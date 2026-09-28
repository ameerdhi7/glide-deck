// NebulaX desktop: one window over the NebulaX daemon (tickets, progress,
// PRs, activity) plus the TUI in a built-in terminal. The main process owns
// every long-lived thing — the bridge, the PR poller, the PTY, the activity
// feed — so notifications keep arriving while the window is closed.

const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, ipcMain, Notification, shell, Menu, nativeImage } = require("electron");
const { Settings, Activity } = require("./settings");
const { NebulaBridge } = require("./bridge");
const { PrWatcher } = require("./prs");
const { TerminalHost } = require("./terminal");

app.setName("NebulaX");
// Dev/test isolation: a separate settings + activity store.
if (process.env.NEBULAX_USER_DATA) app.setPath("userData", process.env.NEBULAX_USER_DATA);

const ICON = path.join(__dirname, "..", "..", "build", "icon.png");
const TERM_BUFFER_MAX = 256 * 1024;

let win = null;
let quitting = false;
let settings, activity, bridge, prs, term;
let termBuffer = "";

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

  const s = settings.get().notify;
  if (!Notification.isSupported()) return;
  const focused = win && !win.isDestroyed() && win.isFocused();
  if (focused && !s.whenFocused) return;
  const wanted = events.filter((e) => s[e.category] !== false);
  // A reconnect can surface a burst; fold anything past three into one.
  const shown = wanted.length > 4 ? wanted.slice(0, 3) : wanted;
  for (const e of shown) notify(e.title, e.body, e.target);
  if (wanted.length > shown.length) {
    notify(`${wanted.length - shown.length} more updates`, "Open NebulaX to see the activity feed", { view: "activity" });
  }
}

function notify(title, body, target) {
  const n = new Notification({ title, body: body || "", silent: !settings.get().notify.sound });
  n.on("click", () => showWindow(target));
  n.show();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "NebulaX",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: "#0c0e13",
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
  if (process.env.NEBULAX_CAPTURE_DIR) win.webContents.once("did-finish-load", () => captureViews(process.env.NEBULAX_CAPTURE_DIR));
  win.on("focus", () => send("window:focus", true));
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
  for (const view of ["overview", "tickets", "prs", "activity", "terminal"]) {
    send("nav", { view });
    await wait(view === "terminal" ? 3000 : 800);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `${view}.png`), img.toPNG());
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
        { label: "Tickets", accelerator: "CmdOrCtrl+2", click: nav("tickets") },
        { label: "Pull Requests", accelerator: "CmdOrCtrl+3", click: nav("prs") },
        { label: "Activity", accelerator: "CmdOrCtrl+4", click: nav("activity") },
        { label: "Terminal", accelerator: "CmdOrCtrl+5", click: nav("terminal") },
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
    prs: prs.snapshot(),
    activity: activity.items,
    unread: activity.unread(),
    settings: settings.get(),
    terminalRunning: term.running(),
  }));
  ipcMain.handle("settings:set", (_e, patch) => {
    const before = settings.get();
    const after = settings.update(patch);
    if (before.nebulaBin !== after.nebulaBin || before.bridgePort !== after.bridgePort) bridge.restart();
    if (before.prPollSeconds !== after.prPollSeconds) prs.schedule();
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
  ipcMain.handle("open:external", (_e, url) => openExternal(url));
  ipcMain.handle("changes:request", (_e, ticketId) => bridge.send("board/changes", { ticket: ticketId }));
  ipcMain.handle("prs:refresh", () => prs.poll());
  ipcMain.handle("bridge:reconnect", () => bridge.restart());
  ipcMain.handle("notify:test", () =>
    notify("NebulaX notifications are on", "You'll hear about tickets and PRs here.", { view: "activity" }),
  );

  ipcMain.handle("term:start", (_e, { cols, rows }) => {
    const r = term.start(cols, rows);
    if (r.ok && !r.already) termBuffer = "";
    return { ...r, buffer: r.already ? termBuffer : "" };
  });
  ipcMain.on("term:write", (_e, data) => term.write(data));
  ipcMain.on("term:resize", (_e, { cols, rows }) => term.resize(cols, rows));
  ipcMain.handle("term:kill", () => term.kill());
  ipcMain.handle("term:external", () => term.openExternal());
}

app.whenReady().then(() => {
  const userData = app.getPath("userData");
  settings = new Settings(userData);
  activity = new Activity(userData);
  bridge = new NebulaBridge(settings);
  prs = new PrWatcher(settings);
  term = new TerminalHost(settings, userData);

  if (app.dock && fs.existsSync(ICON)) app.dock.setIcon(nativeImage.createFromPath(ICON));

  bridge.on("status", (s) => send("bridge:status", s));
  bridge.on("board", (b) => send("board", b));
  bridge.on("changes", (c) => send("changes:result", c));
  bridge.on("events", onEvents);
  prs.on("prs", (p) => send("prs", p));
  prs.on("events", onEvents);
  term.on("data", (d) => {
    termBuffer += d;
    if (termBuffer.length > TERM_BUFFER_MAX) termBuffer = termBuffer.slice(-TERM_BUFFER_MAX);
    send("term:data", d);
  });
  term.on("exit", (code) => send("term:exit", code));

  wireIpc();
  buildMenu();
  createWindow();
  bridge.start();
  prs.start();
  if (settings.get().terminal.autostart) term.start(120, 36);
  updateBadge();
});

app.on("activate", () => showWindow());
app.on("before-quit", () => {
  quitting = true;
  bridge?.stop();
  prs?.stop();
  term?.kill();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
