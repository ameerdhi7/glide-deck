// Glide Deck: one window over the NebulaX daemon (tickets, progress,
// PRs, activity) plus the TUI in a built-in terminal. The main process owns
// every long-lived thing — the bridge, the PR poller, the PTY, the activity
// feed — so notifications keep arriving while the window is closed.

const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, ipcMain, Notification, shell, Menu, nativeImage, dialog, nativeTheme } = require("electron");
const { Settings, Activity, Notes } = require("./settings");
const sound = require("./sound");
const { NebulaBridge } = require("./bridge");
const { PrWatcher } = require("./prs");
const { WorktreeRotator } = require("./rotator");
const { Connections, githubStatus } = require("./connections");
const { TerminalHost, shellCommand } = require("./terminal");
const { warmLoginPath, childEnv, which } = require("./env");
const { execFile } = require("node:child_process");
const { linkPrs, tkey } = require("../shared/links");

app.setName("Glide Deck");
// Settings, activity and notes lived under "NebulaX" before the rename; carry them over once.
{
  const appData = app.getPath("appData");
  const old = path.join(appData, "NebulaX");
  const now = path.join(appData, "Glide Deck");
  try { if (fs.existsSync(old) && !fs.existsSync(now)) fs.renameSync(old, now); } catch {}
}
// Dev/test isolation: a separate settings + activity store.
if (process.env.NEBULAX_USER_DATA) app.setPath("userData", process.env.NEBULAX_USER_DATA);

const ICON = path.join(__dirname, "..", "..", "build", "icon.png");

let win = null;
let quitting = false;
let settings, activity, notes, bridge, prs, rotator, term, shellTerm, connections;

/** A pull request's diff as its reviewers see it, through the user's `gh`. */
function prDiff(url) {
  return new Promise((resolve) => {
    if (!/^https:\/\/github\.com\//.test(url || "")) {
      return resolve({ ok: false, error: "Only GitHub pull requests can be diffed here — open it in the browser instead." });
    }
    const gh = which("gh");
    if (!gh) return resolve({ ok: false, error: "GitHub CLI (`gh`) not found." });
    execFile(gh, ["pr", "diff", url], { env: childEnv(), timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || "").trim().split("\n")[0] });
      resolve({ ok: true, diff: stdout });
    });
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function showWindow(target) {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (target) send("nav", target);
}

function updateBadge() {
  const n = activity.unread();
  if (app.dock) app.dock.setBadge(n > 0 ? String(n) : "");
  send("activity:unread", n);
}

/** New events: into the feed, then maybe onto the desktop. */
function onEvents(events) {
  activity.add(events);
  for (const e of events) send("activity:new", e);
  updateBadge();

  // Every arrival can sound, focused or not, banner or not.
  const s = settings.get().notify;
  sound.forEvents(events, s);
  if (!Notification.isSupported()) return;
  const focused = win && !win.isDestroyed() && win.isFocused();
  if (focused && !s.whenFocused) return;
  const wanted = events.filter(
    (e) => s[e.category] !== false && !(e.category === "prs" && s.prsLinkedOnly && !(e.tickets && e.tickets.length)),
  );
  // A reconnect can surface a burst; fold anything past three into one.
  const shown = wanted.length > 4 ? wanted.slice(0, 3) : wanted;
  for (const e of shown) notify(e.title, e.body, e.target);
  if (wanted.length > shown.length) {
    notify(`${wanted.length - shown.length} more updates`, "Open Glide Deck to see the activity feed", { view: "activity" });
  }
}

/** Ticket ↔ PR links over what the bridge and the PR watcher hold now. */
function currentLinks() {
  return linkPrs(bridge.snapshot().tickets, [...prs.prs.values()]);
}

/** A PR event names the ticket(s) it belongs to, in its title and `tickets`. */
function withTickets(events) {
  const { ticketsByPr } = currentLinks();
  return events.map((e) => {
    const linked = (e.target && ticketsByPr.get(e.target.id)) || [];
    if (!linked.length) return e;
    const keys = linked.map((t) => t.key);
    return { ...e, title: `${keys.join(", ")} · ${e.title}`, tickets: keys };
  });
}

// Ticket ↔ PR pairs already announced, and the PR urls seen with them; null
// until both the board and the PR list have their first answer, so start-up
// doesn't announce every link.
let knownLinks = null;
let knownPrUrls = new Set();

/** A PR that newly belongs to a ticket on the board is news of its own. */
function checkLinks() {
  if (!bridge.baselined || !prs.baselined) return;
  const { ticketsByPr } = currentLinks();
  const pairs = new Map();
  for (const [url, tickets] of ticketsByPr) for (const t of tickets) pairs.set(`${tkey(t.id)}\u0001${url}`, { t, pr: prs.prs.get(url) });
  if (knownLinks) {
    // A brand-new PR already arrives as "PR opened", ticket attached.
    const fresh = [...pairs]
      .filter(([k, v]) => !knownLinks.has(k) && knownPrUrls.has(v.pr.url))
      .map(([, v]) => v);
    if (fresh.length) {
      onEvents(
        fresh.map(({ t, pr }) => ({
          ts: Date.now(),
          category: "prs",
          kind: "pr-linked",
          level: "info",
          title: `${t.key} ↔ ${pr.repo}#${pr.number}`,
          body: pr.title,
          target: { view: "tickets", id: tkey(t.id) },
          url: pr.url,
          tickets: [t.key],
        })),
      );
    }
  }
  knownLinks = new Set(pairs.keys());
  knownPrUrls = new Set(prs.prs.keys());
}

// Shown notifications, held until clicked or closed: a Notification nothing
// references is garbage-collected and its click handler stops firing.
const shown = new Set();

function notify(title, body, target) {
  // Silent: the activity sound (sound.js) is the one that plays.
  const n = new Notification({ title, body: body || "", silent: true });
  shown.add(n);
  n.on("click", () => {
    shown.delete(n);
    showWindow(target);
  });
  n.on("close", () => shown.delete(n));
  n.show();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "Glide Deck",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0d12" : "#f4f5f8",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());
  if (process.env.NEBULAX_OPEN_VIEW) win.webContents.once("did-finish-load", () => setTimeout(() => send("nav", { view: process.env.NEBULAX_OPEN_VIEW }), 500));
  if (process.env.NEBULAX_CAPTURE_DIR) win.webContents.once("did-finish-load", () => captureViews(process.env.NEBULAX_CAPTURE_DIR));
  win.on("focus", () => send("window:focus", true));
  // A reloading or crashed page can't be showing the terminal.
  win.webContents.on("did-start-loading", () => {
    term.detach();
    shellTerm.detach();
  });
  win.webContents.on("render-process-gone", () => {
    term.detach();
    shellTerm.detach();
  });
  // Closing hides: the app keeps watching and notifying from the Dock.
  win.on("close", (e) => {
    if (!quitting && process.platform === "darwin") {
      e.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    win = null;
  });
  // Links always leave the app for the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) {
      e.preventDefault();
      openExternal(url);
    }
  });
}

/** Dev aid: screenshot every view into `dir`, then quit. */
async function captureViews(dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  fs.mkdirSync(dir, { recursive: true });
  await wait(Number(process.env.NEBULAX_CAPTURE_DELAY_MS) || 6000);
  // A fresh settings dir opens the first-run guide over every view.
  await win.webContents.executeJavaScript('document.getElementById("welcome").open && document.getElementById("welcome").close()');
  for (const view of ["overview", "projects", "tickets", "prs", "activity", "worktrees", "terminal", "shell"]) {
    send("nav", { view });
    await wait(view === "terminal" || view === "shell" ? 3000 : 800);
    // An occluded window renders lazily: the first capture flushes the frame.
    await win.webContents.capturePage();
    await wait(400);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `${view}.png`), img.toPNG());
  }
  // The Getting started guide, the Settings dialog and the connection editor it opens.
  for (const [name, js] of [
    ["welcome", "openWelcome()"],
    ["welcome-tickets", "wzGo(1)"],
    ["welcome-prs", "wzGo(2)"],
    ["settings", 'document.getElementById("welcome").close(); document.getElementById("open-settings").click()'],
    ["connection", 'document.querySelector("[data-add=jira]").click()'],
  ]) {
    await win.webContents.executeJavaScript(js);
    await wait(1500);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `${name}.png`), img.toPNG());
  }
  quitting = true;
  app.quit();
}

function openExternal(url) {
  if (typeof url === "string" && /^https?:\/\//.test(url)) shell.openExternal(url);
}

function buildMenu() {
  const nav = (view) => () => showWindow({ view });
  const template = [
    { role: "appMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Overview", accelerator: "CmdOrCtrl+1", click: nav("overview") },
        { label: "Projects", accelerator: "CmdOrCtrl+2", click: nav("projects") },
        { label: "Worktrees", accelerator: "CmdOrCtrl+3", click: nav("worktrees") },
        { label: "Tickets", accelerator: "CmdOrCtrl+4", click: nav("tickets") },
        { label: "Pull Requests", accelerator: "CmdOrCtrl+5", click: nav("prs") },
        { label: "Activity", accelerator: "CmdOrCtrl+6", click: nav("activity") },
        { label: "Notes", accelerator: "CmdOrCtrl+7", click: nav("notes") },
        { label: "Working hub", accelerator: "CmdOrCtrl+8", click: nav("terminal") },
        { label: "Terminal", accelerator: "CmdOrCtrl+9", click: nav("shell") },
        { type: "separator" },
        { label: "Refresh Pull Requests", accelerator: "CmdOrCtrl+R", click: () => prs.poll() },
        { label: "Reconnect to NebulaX", accelerator: "CmdOrCtrl+Shift+R", click: () => bridge.restart() },
        { type: "separator" },
        { role: "toggleDevTools" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function wireIpc() {
  ipcMain.handle("state:get", () => ({
    board: bridge.snapshot(),
    worktrees: bridge.worktreeSnapshot(),
    rotate: rotator.status(),
    prs: prs.snapshot(),
    activity: activity.items,
    unread: activity.unread(),
    settings: settings.get(),
    notes: notes.list(),
    terminalRunning: term.running(),
    shellRunning: shellTerm.running(),
  }));
  ipcMain.handle("settings:set", (_e, patch) => {
    const before = settings.get();
    const after = settings.update(patch);
    if (before.nebulaBin !== after.nebulaBin) connections.reset();
    if (before.nebulaBin !== after.nebulaBin || before.bridgePort !== after.bridgePort) bridge.restart();
    if (JSON.stringify(before.prs) !== JSON.stringify(after.prs)) {
      knownLinks = null;
      prs.reset();
    } else if (before.prPollSeconds !== after.prPollSeconds) prs.schedule();
    // A rule just turned on (or changed) gets a pass soon, not in 15 minutes.
    if (JSON.stringify(before.rotate) !== JSON.stringify(after.rotate)) rotator.schedule(after.rotate.enabled ? 5000 : undefined);
    send("settings", after);
    return after;
  });
  ipcMain.handle("activity:markRead", () => {
    activity.markRead();
    updateBadge();
  });
  ipcMain.handle("activity:clear", () => {
    activity.clear();
    updateBadge();
  });
  ipcMain.handle("notes:save", (_e, note) => notes.save(note));
  ipcMain.handle("notes:delete", (_e, id) => notes.remove(id));
  ipcMain.handle("open:external", (_e, url) => openExternal(url));
  ipcMain.handle("changes:request", (_e, ticketId) => bridge.send("board/changes", { ticket: ticketId }));
  ipcMain.handle("changes:pr", (_e, url) => prDiff(url));
  // One at a time: the daemon serializes worktree ops anyway, and each reply
  // lets the page tick that row off as it goes.
  ipcMain.handle("worktrees:delete", async (_e, { ids, force }) => {
    const results = [];
    for (const id of ids || []) {
      const r = await bridge.deleteWorktree(id, force);
      results.push({ id, ...r });
      send("worktrees:progress", { id, ...r });
    }
    return results;
  });
  ipcMain.handle("rotate:run", () => rotator.run({ manual: true }));
  // Adding: pick one or more repo folders, then open each in NebulaX.
  ipcMain.handle("projects:add", async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: "Add projects to NebulaX",
      buttonLabel: "Add",
      properties: ["openDirectory", "multiSelections"],
    });
    if (picked.canceled) return [];
    const results = [];
    for (const path of picked.filePaths) results.push({ path, ...(await bridge.addProject(path)) });
    return results;
  });
  ipcMain.handle("projects:remove", (_e, id) => bridge.removeProject(id));
  ipcMain.handle("prs:refresh", () => prs.poll());
  ipcMain.handle("tickets:resync", () => bridge.send("board/sync-now", {}));
  // The play button: cut the ticket's worktree and launch its session. The
  // reply lands once the session is up (or says why it could not start).
  ipcMain.handle("tickets:start", (_e, { ticket, harness, project, base }) =>
    bridge.request("board/start", { tickets: [ticket], harness, project, base }),
  );
  ipcMain.handle("bridge:reconnect", () => bridge.restart());
  // Connections live in NebulaX's own config; a change resyncs the board so
  // the daemon picks it up now rather than on its next beat.
  const connCall = (fn) => async (...args) => {
    try {
      return { ok: true, ...(await fn(...args)) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };
  ipcMain.handle("connections:list", connCall(() => connections.list()));
  ipcMain.handle(
    "connections:save",
    connCall(async (_e, { connection, token, clearToken }) => {
      const id = await connections.save(connection, { token, clearToken });
      bridge.send("board/sync-now", {});
      return { id };
    }),
  );
  ipcMain.handle(
    "connections:remove",
    connCall(async (_e, id) => {
      await connections.remove(id);
      bridge.send("board/sync-now", {});
      return {};
    }),
  );
  ipcMain.handle("connections:test", (_e, { connection, token }) => connections.test(connection, token));
  ipcMain.handle("github:status", () => githubStatus());
  // `gh auth login` is interactive (a one-time code, a browser), so it runs
  // in the Shell view where the user can answer it.
  ipcMain.handle("github:login", () => {
    const r = shellTerm.start(120, 36);
    if (!r.ok) return r;
    shellTerm.write("gh auth login --hostname github.com --git-protocol https --web\r");
    send("nav", { view: "shell" });
    return { ok: true };
  });
  ipcMain.handle("notify:test", () => {
    const s = settings.get().notify;
    if (s.sound) sound.play(s.sounds.tickets || Object.values(s.sounds).find(Boolean));
    notify("Glide Deck notifications are on", "You'll hear about tickets and PRs here.", { view: "activity" });
  });
  ipcMain.handle("sound:list", () => sound.list());
  ipcMain.handle("sound:play", (_e, name) => sound.play(name));

  // Start (or rejoin) the TUI and attach: the reply carries the screen so far.
  ipcMain.handle("term:start", async (_e, { cols, rows }) => {
    const r = term.start(cols, rows);
    return r.ok ? { ...r, snapshot: await term.attach() } : r;
  });
  ipcMain.on("term:detach", () => term.detach());
  ipcMain.on("term:write", (_e, data) => term.write(data));
  ipcMain.on("term:resize", (_e, { cols, rows }) => term.resize(cols, rows));
  ipcMain.handle("term:kill", () => term.kill());

  // The Terminal view: a plain login shell, same attach protocol.
  ipcMain.handle("shell:start", async (_e, { cols, rows }) => {
    const r = shellTerm.start(cols, rows);
    return r.ok ? { ...r, snapshot: await shellTerm.attach() } : r;
  });
  ipcMain.on("shell:detach", () => shellTerm.detach());
  ipcMain.on("shell:write", (_e, data) => shellTerm.write(data));
  ipcMain.on("shell:resize", (_e, { cols, rows }) => shellTerm.resize(cols, rows));
  ipcMain.handle("shell:kill", () => shellTerm.kill());
}

app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  settings = new Settings(userData);
  activity = new Activity(userData);
  notes = new Notes(userData);
  bridge = new NebulaBridge(settings);
  prs = new PrWatcher(settings, () =>
    bridge
      .snapshot()
      .tickets.filter((t) => t.key && !t.removed_reason)
      .map((t) => t.key),
    () => connections.bitbucketSources(),
  );
  rotator = new WorktreeRotator(settings, bridge);
  connections = new Connections(settings);
  term = new TerminalHost(settings, userData);
  shellTerm = new TerminalHost(settings, userData, shellCommand);

  if (app.dock && fs.existsSync(ICON)) app.dock.setIcon(nativeImage.createFromPath(ICON));

  bridge.on("status", (s) => send("bridge:status", s));
  // A snapshot or a sync can deliver many upserts at once; send the board at
  // most every 100ms instead of once per ticket.
  let boardTimer = null;
  let worktreeTimer = null;
  bridge.on("board", () => {
    if (boardTimer) return;
    boardTimer = setTimeout(() => {
      boardTimer = null;
      send("board", bridge.snapshot());
      checkLinks();
    }, 100);
  });
  bridge.on("worktrees", () => {
    if (worktreeTimer) return;
    worktreeTimer = setTimeout(() => {
      worktreeTimer = null;
      send("worktrees", bridge.worktreeSnapshot());
    }, 100);
  });
  bridge.on("changes", (c) => send("changes:result", c));
  bridge.on("events", onEvents);
  prs.on("prs", (p) => {
    send("prs", p);
    checkLinks();
  });
  prs.on("events", (events) => onEvents(withTickets(events)));
  rotator.on("status", (st) => send("rotate:status", st));
  rotator.on("progress", (r) => send("worktrees:progress", r));
  rotator.on("rotated", (r) => {
    const n = r.deleted.length;
    onEvents([
      {
        ts: r.ts,
        category: "worktrees",
        kind: "worktrees-rotated",
        level: r.kept.length ? "warn" : "info",
        title: n ? `Rotated ${n} old worktree${n === 1 ? "" : "s"}` : "Worktree rotation kept every checkout",
        body: [
          r.deleted.join(", "),
          r.kept.length ? `kept ${r.kept.map((k) => `${k.branch} (${k.error})`).join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        target: { view: "worktrees" },
      },
    ]);
  });
  term.on("data", (d) => send("term:data", d));
  term.on("exit", (code) => send("term:exit", code));
  shellTerm.on("data", (d) => send("shell:data", d));
  shellTerm.on("exit", (code) => send("shell:exit", code));

  wireIpc();
  buildMenu();
  createWindow();
  // Children need the login PATH; resolve it without blocking the window.
  await warmLoginPath();
  bridge.start();
  prs.start();
  rotator.start();
  if (settings.get().terminal.autostart) term.start(120, 36);
  updateBadge();
});

app.on("activate", () => showWindow());
app.on("before-quit", () => {
  quitting = true;
  activity?.flush();
  bridge?.stop();
  prs?.stop();
  rotator?.stop();
  term?.kill();
  shellTerm?.kill();
});
// `kill`/Ctrl-C must not orphan the TUI's PTY or the bridge: quit properly.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => app.quit());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
