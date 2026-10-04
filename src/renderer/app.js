// The window: overview, tickets, pull requests, activity and the NebulaX
// terminal. Everything it shows arrives from the main process over the
// preload's `window.nebula` API; the page itself holds only view state.

const { STEPS, progressOf, needsYou, tally } = window.NebulaProgress;
const api = window.nebula;

const S = {
  view: "overview",
  // The play button's last outcome, shown in that ticket's detail pane:
  // { key, tone: "busy" | "ok" | "err", text }.
  starting: null,
  board: { status: { state: "starting", detail: "" }, tickets: [], connections: [], inbox: [] },
  prs: { prs: [], error: null, lastPoll: 0 },
  activity: [],
  unread: 0,
  // How many feed items were unread when the Activity view was last opened —
  // they keep their dot for that visit even though the badge clears.
  unreadShown: 0,
  settings: null,
  filter: "all",
  search: "",
  selected: null,
  worktrees: [],
  wtProjects: [],
  // The project whose checkouts the Worktrees view is showing.
  wtProject: null,
  // Worktrees view: ticked rows, rows mid-delete, and the last error per row.
  wtChecked: new Set(),
  wtBusy: new Set(),
  wtErrors: new Map(),
  wtSearch: "",
  // Worktree rotation: the pass in flight and what the last one did.
  rotate: { running: false, due: [], last: null },
  // Projects view: the filter, projects mid-remove, and the last add/remove
  // failure to show.
  pjSearch: "",
  pjBusy: new Set(),
  pjError: "",
  // Notes view: every note, the scope being shown ("all", "general",
  // "project:<id>", "ticket:<key>"), the open note and the search.
  notes: [],
  ntScope: "all",
  ntSelected: null,
  ntSearch: "",
};

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const tkey = (id) => (id ? `${id.connection}\u0000${id.native}` : "");

function rel(ts) {
  if (!ts) return "";
  const t = typeof ts === "number" ? ts : Date.parse(ts);
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}

// ---------------------------------------------------------------- derived

function liveTickets() {
  return S.board.tickets.filter((t) => !t.removed_reason);
}

/** Ticket ↔ PR links: keys in a PR's title or branch, or the provider's own. */
function links() {
  return window.NebulaLinks.linkPrs(S.board.tickets, S.prs.prs);
}

function prNeedsYou(pr) {
  if (pr.state !== "OPEN") return false;
  if (pr.bucket === "review") return true;
  return pr.reviewDecision === "CHANGES_REQUESTED" || pr.checks === "FAILURE" || pr.checks === "ERROR";
}

const TONE_PILL = { ok: "ok", warn: "warn", err: "err", active: "active", idle: "" };

// ---------------------------------------------------------------- nav

const TITLES = { overview: "Overview", terminal: "Working hub", projects: "Projects", worktrees: "Worktrees", tickets: "Tickets", prs: "Pull requests", activity: "Activity", notes: "Notes", shell: "Terminal" };

function go(view, opts = {}) {
  if (!TITLES[view]) return;
  if (S.view === "notes" && view !== "notes") leaveNote();
  if (view === "activity" && S.view !== "activity") {
    S.unreadShown = S.unread;
    if (S.unread) api.markActivityRead();
  }
  const order = Object.keys(TITLES);
  const moved = S.view !== view;
  const app = document.querySelector(".app");
  // The next view slides in from the side of the tab it came from. Set on
  // the root so the ::view-transition pseudos (which hang off <html>) see it.
  document.documentElement.style.setProperty("--dir", order.indexOf(view) >= order.indexOf(S.view) ? "1" : "-1");
  app.dataset.view = view;
  S.view = view;
  if (opts.filter) S.filter = opts.filter;
  if (opts.ticket) S.selected = opts.ticket;
  // Nav, glider and title stay live (outside the transition snapshot), so
  // they animate on their own while the views cross over.
  document.querySelectorAll(".nav-item[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  $("view-title").textContent = TITLES[view];
  moveGlider();
  if (moved) {
    replay($("view-title"), "pop");
    app.classList.add("entering");
    clearTimeout(go.settle);
    go.settle = setTimeout(() => app.classList.remove("entering"), 700);
  }
  const swap = () => {
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.id === `view-${view}`));
    renderView();
    for (const [v, pane] of Object.entries(PANES)) {
      if (v === view) pane.ensure();
      else pane.sync();
    }
    if (view === "tickets" && opts.ticket) {
      const el = document.querySelector(`.row[data-k="${CSS.escape(opts.ticket)}"]`);
      if (el) el.scrollIntoView({ block: "center" });
    }
    if (view === "prs" && opts.pr) {
      const el = document.querySelector(`.pr[data-url="${CSS.escape(opts.pr)}"]`);
      if (el) {
        el.scrollIntoView({ block: "center" });
        el.classList.remove("flash");
        void el.offsetWidth;
        el.classList.add("flash");
      }
    }
  };
  // The outgoing view slides and blurs away while the new one lands: a real
  // cross-over, not the old view blinking out under a fresh entrance.
  if (moved && document.startViewTransition) document.startViewTransition(swap);
  else swap();
}

/** Slide the gradient pill behind whichever nav tab is on. It moves like a
 *  drop of liquid: the leading edge stretches out to the new tab first, then
 *  the trailing edge snaps in after it with a springy overshoot. */
function moveGlider() {
  const on = document.querySelector(".nav-item[data-view].on");
  const glider = $("nav-glider");
  if (!on || !glider) return;
  const to = on.offsetTop;
  const h = on.offsetHeight;
  const from = moveGlider.at;
  moveGlider.at = to;
  clearTimeout(moveGlider.t);
  glider.classList.remove("stretch");
  if (from === undefined || from === to) {
    glider.style.transform = `translateY(${to}px)`;
    glider.style.height = `${h}px`;
    return;
  }
  glider.classList.add("stretch");
  glider.style.transform = `translateY(${Math.min(from, to)}px)`;
  glider.style.height = `${Math.abs(to - from) + h}px`;
  moveGlider.t = setTimeout(() => {
    glider.classList.remove("stretch");
    glider.style.transform = `translateY(${to}px)`;
    glider.style.height = `${h}px`;
  }, 220);
}

/** Restart a one-shot CSS animation class on an element. */
function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

/** A notification / feed target → a view. */
function goTarget(target) {
  if (!target) return;
  if (target.view === "tickets") go("tickets", target.id ? { ticket: target.id, filter: "all" } : {});
  else if (target.view === "prs") go("prs", { pr: target.id });
  else go(target.view);
}

function renderView() {
  renderNav();
  renderTopbar();
  switch (S.view) {
    case "overview":
      return renderOverview();
    case "tickets":
      return renderTickets();
    case "prs":
      return renderPrs();
    case "activity":
      return renderActivity();
    case "projects":
      return renderProjects();
    case "worktrees":
      return renderWorktrees();
    case "notes":
      return renderNotes();
  }
}

function renderNav() {
  const live = liveTickets();
  $("nav-tickets").textContent = live.length || "";
  $("nav-prs").textContent = S.prs.prs.filter((p) => p.state === "OPEN").length || "";
  $("nav-activity").textContent = S.unread || "";
  $("nav-worktrees").textContent = S.worktrees.length || "";
  $("nav-projects").textContent = S.wtProjects.length || "";
  $("nav-notes").textContent = S.notes.length || "";
  const st = S.board.status;
  $("conn-dot").className = `dot ${st.state}`;
  $("conn-state").textContent =
    { connected: "Connected", starting: "Starting", disconnected: "Reconnecting", error: "Not connected" }[st.state] || st.state;
  $("conn-detail").textContent =
    st.state === "connected"
      ? S.board.connections.map((c) => c.label || c.id).join(", ") || "no tracker configured"
      : st.detail || "";
  $("conn").title = st.detail || "Reconnect to NebulaX";
}

function renderTopbar() {
  const actions = $("top-actions");
  const sub = $("view-sub");
  actions.innerHTML = "";
  sub.textContent = "";
  const btn = (label, ic, fn, cls = "") => {
    const b = document.createElement("button");
    b.className = cls;
    b.innerHTML = `${ic ? icon(ic) : ""}<span>${esc(label)}</span>`;
    b.onclick = fn;
    actions.appendChild(b);
  };
  switch (S.view) {
    case "overview":
    case "tickets": {
      const last = Math.max(0, ...S.board.connections.map((c) => c.last_sync_ms || 0));
      sub.textContent = S.board.status.state === "connected" ? `live${last ? ` · synced ${rel(last)}` : ""}` : "";
      btn("Open NebulaX", "terminal", () => go("terminal"));
      break;
    }
    case "prs":
      sub.textContent = `via ${S.prs.providerLabel || "GitHub"}${S.prs.prs.some((p) => p.host === "bitbucket") ? " + Bitbucket" : ""} · ${
        S.prs.busy ? "asking…" : S.prs.lastPoll ? `checked ${rel(S.prs.lastPoll)}` : "checking…"
      }`;
      btn("Refresh", "refresh", () => api.refreshPrs());
      break;
    case "activity":
      btn("Clear", "", async () => {
        await api.clearActivity();
        S.activity = [];
        renderActivity();
      });
      break;
    case "projects": {
      const n = S.wtProjects.length;
      sub.textContent = S.board.status.state === "connected" ? `${n} open in NebulaX · shared with the Working hub` : "";
      btn("Add project", "plus", addProjects, S.board.status.state === "connected" ? "primary" : "");
      break;
    }
    case "worktrees": {
      const n = S.worktrees.length;
      const np = S.wtProjects.length;
      sub.textContent =
        S.board.status.state === "connected" ? `${n} worktree${n === 1 ? "" : "s"} across ${np} project${np === 1 ? "" : "s"}` : "";
      break;
    }
    case "notes": {
      const n = S.notes.length;
      sub.textContent = `${n} note${n === 1 ? "" : "s"}`;
      btn("New note", "plus", () => newNote(), "primary");
      break;
    }
    case "terminal":
    case "shell": {
      const pane = PANES[S.view];
      sub.textContent = pane.running ? `${pane.name} is running` : pane.started ? "exited" : "";
      btn("Restart", "refresh", () => pane.restart());
      break;
    }
  }
}

// ---------------------------------------------------------------- overview

// The overview is an ops console: a status strip, a 24h activity histogram,
// the ticket pipeline as pixel meters, what's in flight, what needs you, and
// the activity feed as a tail -f event stream.

// [bucket, label, colour, ticket filter]
const SEGMENTS = [
  ["done", "Done", "var(--green)", "done"],
  ["pr", "PR open", "var(--violet)", "review"],
  ["ready", "Ready", "var(--cyan)", "review"],
  ["active", "In progress", "var(--amber)", "active"],
  ["attention", "Needs you", "var(--red)", "needs"],
  ["queued", "Queued", "var(--dim)", "active"],
  ["todo", "To do", "var(--dim2)", "todo"],
];
const TONE_COLOR = { ok: "var(--green)", active: "var(--cyan)", warn: "var(--amber)", err: "var(--red)", idle: "var(--dim)" };
const CATEGORY_SRC = { prs: "pull-request", tickets: "ticket", connections: "connection", worktrees: "worktrees" };

// Event-stream view state: the level filter, a frozen copy while paused, and
// the moment CLR was pressed (it hides older lines; the feed itself is kept).
const OV = { level: "all", paused: null, clearedAt: 0 };

const tsOf = (ts) => (typeof ts === "number" ? ts : Date.parse(ts) || 0);
const pad = (n, w = 2) => String(n).padStart(w, "0");
const clock = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const pctOf = (n, of) => (of ? Math.round((n / of) * 100) : 0);
const seg = (pct, color, cls = "") => `<div class="seg ${cls}" style="--on:${color}"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>`;

// CRT scanlines: off unless turned on, remembered per machine.
function crtOn() {
  try { return localStorage.getItem("nebulax.scanlines") === "on"; } catch { return false; }
}
function setCrt(on) {
  try { localStorage.setItem("nebulax.scanlines", on ? "on" : "off"); } catch {}
  document.documentElement.classList.toggle("crt", on);
}
setCrt(crtOn());

// Theme: follows the system unless set to light or dark, remembered per machine.
const THEMES = ["system", "light", "dark"];
const THEME_ICON = { system: "monitor", light: "sun", dark: "moon" };
const systemDark = matchMedia("(prefers-color-scheme: dark)");
function themePick() {
  try { const t = localStorage.getItem("glidedeck.theme"); return THEMES.includes(t) ? t : "system"; } catch { return "system"; }
}
function applyTheme() {
  const pick = themePick();
  const resolved = pick === "system" ? (systemDark.matches ? "dark" : "light") : pick;
  document.documentElement.dataset.theme = resolved;
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.innerHTML = `${icon(THEME_ICON[pick])}<span>Theme</span><span class="count">${pick[0].toUpperCase()}${pick.slice(1)}</span>`;
}
function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(themePick()) + 1) % THEMES.length];
  try { localStorage.setItem("glidedeck.theme", next); } catch {}
  applyTheme();
}
systemDark.addEventListener("change", applyTheme);
applyTheme();
setInterval(() => {
  const el = $("ov-clock");
  if (el && S.view === "overview") el.textContent = clock(Date.now());
}, 1000);

/** Counts per 30-minute slot over the last 24h, oldest first. */
function slots(events, pick = () => true) {
  const now = Date.now();
  const out = Array.from({ length: 48 }, () => ({ n: 0, err: 0 }));
  for (const e of events) {
    const age = now - tsOf(e.ts);
    if (age < 0 || age >= 864e5 || !pick(e)) continue;
    const s = out[47 - Math.floor(age / 18e5)];
    s.n++;
    if (e.level === "error") s.err++;
  }
  return out;
}

function renderOverview() {
  const tickets = liveTickets();
  const { buckets, total } = tally(tickets);
  const prs = S.prs.prs;
  const needTickets = tickets.filter((t) => needsYou(t) || progressOf(t).tone === "err");
  const needPrs = prs.filter(prNeedsYou);
  renderStrip(buckets, total, prs);
  renderFlow();
  renderPipeline(buckets, total);
  renderFlight(tickets);
  renderNeeds(needTickets, needPrs);
  renderStream();
}

function renderStrip(buckets, total, prs) {
  const st = S.board.status.state;
  const daemon = { connected: ["Live", "c-green"], starting: ["Boot", "c-amber"], disconnected: ["Retry", "c-amber"], error: ["Down", "c-red"] }[st] || [st, "c-dim"];
  const c = S.board.connections[0];
  const health = c ? ({ verified: "c-green", authenticated: "c-green", configured: "c-amber", error: "c-red" }[c.health] || "c-dim") : "c-amber";
  const tracker = c ? `${c.label || c.id}${S.board.connections.length > 1 ? ` +${S.board.connections.length - 1}` : ""}` : "none";
  const mine = prs.filter((p) => p.state === "OPEN" && p.bucket === "mine").length;
  const reviews = prs.filter((p) => p.bucket === "review").length;
  const crt = crtOn();
  $("ov-strip").innerHTML = `
    <div class="strip-cell"><span>Daemon</span><b class="${daemon[1]}">${esc(daemon[0].toUpperCase())}</b></div>
    <button class="strip-cell" data-go="tickets"><span>Tickets</span><b class="c-cyan">${buckets.done}/${total}</b>${seg(pctOf(buckets.done, total), "var(--green)")}</button>
    <button class="strip-cell" data-go="prs"><span>My PRs</span><b class="${mine ? "c-violet" : "c-dim"}">${mine}</b></button>
    <button class="strip-cell" data-go="prs"><span>Reviews</span><b class="${reviews ? "c-amber" : "c-dim"}">${reviews}</b></button>
    <button class="strip-cell" data-go="worktrees"><span>Worktrees</span><b>${S.worktrees.length}</b></button>
    <button class="strip-cell" data-go="${c ? "settings" : "welcome"}" title="${esc(c ? `${c.kind} · ${c.health}${c.detail ? ` · ${c.detail}` : ""}` : "Set up a tracker")}"><span>Tracker</span><b class="${health}">${esc(tracker.toUpperCase())}</b></button>
    <div class="strip-cell push"><span>Local</span><b class="c-green" id="ov-clock">${clock(Date.now())}</b></div>
    <button class="strip-cell crt-toggle ${crt ? "" : "off"}" data-go="crt" title="Scanlines">CRT [${crt ? "ON" : "OFF"}]</button>`;
  $("ov-strip").onclick = (e) => {
    const b = e.target.closest("[data-go]");
    if (!b) return;
    const to = b.dataset.go;
    if (to === "crt") {
      setCrt(!crtOn());
      renderOverview();
    } else if (to === "welcome") openWelcome();
    else if (to === "settings") openSettings();
    else go(to);
  };
}

function renderFlow() {
  const events = S.activity;
  const all = slots(events);
  const max = Math.max(4, ...all.map((s) => s.n));
  const top = Math.ceil(max / 2) * 2;
  const now = Date.now();
  const midnight = new Date().setHours(0, 0, 0, 0);
  const inDay = events.filter((e) => now - tsOf(e.ts) < 864e5);
  const lastHour = events.filter((e) => now - tsOf(e.ts) < 36e5).length;
  const warn = inDay.filter((e) => e.level === "warn").length;
  const err = inDay.filter((e) => e.level === "error").length;
  $("ov-live").hidden = S.board.status.state !== "connected";
  $("ov-flow-stats").innerHTML = `
    <div class="k">LAST HOUR</div>
    <div class="big-num">${lastHour}<small>ev</small></div>
    <dl>
      <dt>TODAY</dt><dd>${events.filter((e) => tsOf(e.ts) >= midnight).length}</dd>
      <dt>WARN</dt><dd class="${warn ? "c-amber" : ""}">${warn}</dd>
      <dt>ERROR</dt><dd class="${err ? "c-red" : ""}">${err}</dd>
      <dt>LAST</dt><dd>${events[0] ? esc(rel(events[0].ts)) : "—"}</dd>
    </dl>`;
  $("ov-histo-axis").innerHTML = `<span>${top}</span><span>${top / 2}</span><span>0</span>`;
  $("ov-histo").innerHTML = all
    .map((s, i) => {
      const from = new Date(now - (48 - i) * 18e5);
      const cls = !s.n ? "z" : s.err ? "hot" : i === 47 ? "now" : "";
      return `<i class="${cls}" style="height:${s.n ? Math.max(4, (s.n / top) * 100) : 0}%" title="${clock(from).slice(0, 5)} · ${s.n} event${s.n === 1 ? "" : "s"}${s.err ? ` · ${s.err} error${s.err === 1 ? "" : "s"}` : ""}"></i>`;
    })
    .join("");
}

function renderPipeline(buckets, total) {
  const done = pctOf(buckets.done, total);
  const moving = total - buckets.done - buckets.todo;
  const mv = pctOf(moving, total);
  $("ov-pipe-note").textContent = `${total} ticket${total === 1 ? "" : "s"}`;
  $("ov-meters").innerHTML = `
    <div class="meter"><span class="k">DONE</span><div class="vbar" style="--on:var(--green)"><i style="height:calc((100% - 8px) * ${done / 100})"></i></div>
      <span class="big-num c-green">${total ? done : "—"}%</span><span class="sub">${buckets.done} of ${total}</span></div>
    <div class="meter"><span class="k">MOVING</span><div class="vbar" style="--on:var(--cyan)"><i style="height:calc((100% - 8px) * ${mv / 100})"></i></div>
      <span class="big-num c-cyan">${total ? mv : "—"}%</span><span class="sub">${moving} in flight</span></div>`;
  const stages = $("ov-stages");
  stages.innerHTML = `<div class="k">BY STAGE</div>`;
  for (const [k, label, color, filter] of SEGMENTS) {
    const b = document.createElement("button");
    b.className = "stage";
    b.innerHTML = `<span class="nm">${esc(label)}</span>${seg(pctOf(buckets[k], total), color)}<span class="v" style="color:${buckets[k] ? color : "var(--dim2)"}">${buckets[k]}</span>`;
    b.onclick = () => go("tickets", { filter });
    stages.appendChild(b);
  }
}

function renderFlight(tickets) {
  const moving = tickets
    .map((t) => ({ t, p: progressOf(t) }))
    .filter(({ p }) => p.step >= 1 && p.step <= 5)
    .sort((a, b) => (b.p.tone === "err" || b.p.tone === "warn") - (a.p.tone === "err" || a.p.tone === "warn") || b.p.step - a.p.step);
  $("ov-flight-n").textContent = moving.length;
  const root = $("ov-flight");
  root.innerHTML = "";
  for (const { t, p } of moving.slice(0, 5)) {
    const color = TONE_COLOR[p.tone] || "var(--dim)";
    const el = document.createElement("div");
    el.className = "flight-row";
    el.title = `${STEPS[p.step]} — step ${p.step + 1} of ${STEPS.length}`;
    el.innerHTML = `
      <div class="nm"><span class="key">${esc(t.key)}</span><span class="s">${esc(t.summary)}</span></div>
      <span class="tag" style="color:${color}">${esc(p.label)}</span>
      <div class="seg steps7" style="--on:${color}">${STEPS.map((_, i) => `<b class="${i < p.step ? "on" : i === p.step ? "cur" : ""}"></b>`).join("")}</div>
      <span class="pct">${pctOf(p.step, STEPS.length - 1)}%</span>`;
    el.onclick = () => go("tickets", { ticket: tkey(t.id), filter: "all" });
    root.appendChild(el);
  }
  if (!moving.length) root.innerHTML = `<div class="stream-empty">nothing moving — press ▶ on a ticket</div>`;
  else if (moving.length > 5) {
    const more = document.createElement("div");
    more.className = "flight-row";
    more.innerHTML = `<button class="link">+${moving.length - 5} more in flight</button>`;
    more.onclick = () => go("tickets", { filter: "active" });
    root.appendChild(more);
  }
}

function renderNeeds(needTickets, needPrs) {
  const n = needTickets.length + needPrs.length;
  const panel = $("ov-alert");
  panel.classList.toggle("hot", n > 0);
  panel.classList.toggle("calm", n === 0);
  const spark = slots(S.activity, (e) => e.level === "warn" || e.level === "error");
  const sMax = Math.max(2, ...spark.map((s) => s.n));
  const body = $("ov-alert-body");
  body.innerHTML = `
    <div class="alert-top">
      <span class="big-num ${n ? "c-amber" : "c-green"}">${n}</span>
      <span class="badge ${n ? "c-amber" : "c-green"}">${n ? "▲ Attention" : "■ All clear"}</span>
    </div>
    <div class="spark" title="Warnings and errors, last 24h">${spark.map((s) => `<i class="${!s.n ? "z" : s.err ? "e" : ""}" style="height:${s.n ? Math.max(15, (s.n / sMax) * 100) : 15}%"></i>`).join("")}</div>
    <div class="alert-list"></div>`;
  const list = body.querySelector(".alert-list");
  for (const t of needTickets.slice(0, 3)) {
    const p = progressOf(t);
    list.appendChild(miniEl({ icon: "ticket", cls: p.tone === "err" ? "lv-error" : "lv-warn", title: `${t.key} · ${p.label}`, body: t.summary, when: rel(t.updated_at), onclick: () => go("tickets", { ticket: tkey(t.id), filter: "all" }) }));
  }
  for (const pr of needPrs.slice(0, Math.max(0, 3 - needTickets.length))) {
    const why = pr.bucket === "review" ? "review requested" : pr.reviewDecision === "CHANGES_REQUESTED" ? "changes requested" : "checks failing";
    list.appendChild(miniEl({ icon: "pr", cls: pr.bucket === "review" ? "lv-warn" : "lv-error", title: `${pr.repo}#${pr.number} · ${why}`, body: pr.title, when: rel(pr.updatedAt), onclick: () => go("prs", { pr: pr.url }) }));
  }
  if (n > 3) {
    const more = document.createElement("button");
    more.className = "link";
    more.textContent = `+${n - 3} more`;
    more.onclick = () => go("tickets", { filter: "needs" });
    list.appendChild(more);
  }
  const last = S.activity.find((e) => e.level === "error");
  $("ov-last-err").innerHTML = last
    ? `<span class="k">LAST ERROR</span><span class="b">${esc(last.title)}${last.body ? `: ${esc(last.body)}` : ""} · <span class="sub">${esc(rel(last.ts))}</span></span>`
    : `<span class="k">LAST ERROR</span><span class="b sub">none in the feed</span>`;
}

function renderStream() {
  const source = (OV.paused || S.activity).filter((e) => tsOf(e.ts) > OV.clearedAt);
  const lvl = (e) => (e.level === "success" ? "info" : e.level);
  const count = { all: source.length, info: 0, warn: 0, error: 0 };
  for (const e of source) count[lvl(e)] = (count[lvl(e)] || 0) + 1;
  const ctl = $("ov-stream-ctl");
  ctl.innerHTML =
    ["all", "info", "warn", "error"].map((k) => `<button class="sbtn ${OV.level === k ? "on" : ""}" data-lvl="${k}">${k} ${count[k] || 0}</button>`).join("") +
    `<i class="sep"></i><button class="sbtn solid" data-act="pause">${OV.paused ? "▶ Resume" : "▮▮ Pause"}</button><button class="sbtn solid" data-act="clr">Clr</button>`;
  ctl.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.lvl) OV.level = b.dataset.lvl;
    else if (b.dataset.act === "pause") OV.paused = OV.paused ? null : S.activity.slice();
    else if (b.dataset.act === "clr") {
      OV.clearedAt = Date.now();
      OV.paused = null;
    }
    renderStream();
  };
  const root = $("ov-stream");
  const atBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 24;
  const lines = source.filter((e) => OV.level === "all" || lvl(e) === OV.level).slice(0, 150).reverse();
  root.innerHTML = "";
  for (const e of lines) {
    const t = tsOf(e.ts);
    const el = document.createElement("div");
    el.className = `stream-line ${esc(e.level)}`;
    el.title = new Date(t).toLocaleString();
    el.innerHTML = `<span class="ts">${clock(t)}.${pad(new Date(t).getMilliseconds(), 3)}</span><span class="lvl">[${e.level === "success" ? " OK " : esc(e.level.toUpperCase())}]</span><span class="src">${esc(CATEGORY_SRC[e.category] || "nebula")}</span><span class="msg">${esc(e.title)}${e.body ? ` <em>— ${esc(e.body)}</em>` : ""}</span>`;
    el.onclick = () => goTarget(e.target);
    root.appendChild(el);
  }
  if (!lines.length) root.innerHTML = `<div class="stream-empty">${OV.paused ? "paused" : "waiting for events"}</div>`;
  if (atBottom || !root.dataset.seen) root.scrollTop = root.scrollHeight;
  root.dataset.seen = "1";
}

function miniEl({ icon: ic, cls, title, body, when, onclick }) {
  const el = document.createElement("div");
  el.className = "mini";
  el.innerHTML = `<span class="${cls}">${icon(ic)}</span><div style="min-width:0"><div class="t">${esc(title)}</div>${body ? `<div class="b">${esc(body)}</div>` : ""}</div><span class="when">${esc(when)}</span>`;
  if (onclick) el.onclick = onclick;
  return el;
}

// ---------------------------------------------------------------- tickets

const FILTERS = [
  ["all", "All", () => true],
  ["needs", "Needs you", (t, p) => needsYou(t) || p.tone === "err"],
  ["active", "In progress", (t, p) => (p.step === 1 || p.step === 2) && p.tone !== "err" && !needsYou(t)],
  ["review", "Ready", (t, p) => p.step >= 3 && p.step <= 5],
  ["todo", "To do", (t, p) => p.step === 0],
  ["done", "Done", (t, p) => p.step === 6],
];

function sortRank(t, p) {
  if (needsYou(t) || p.tone === "err") return 0;
  if (p.step === 2) return 1;
  if (p.step >= 3 && p.step <= 5) return 2;
  if (p.step === 1) return 3;
  if (p.step === 0) return t.blocked_reason ? 5 : 4;
  return 6;
}

function renderTickets() {
  const all = S.board.tickets.map((t) => ({ t, p: progressOf(t) }));
  const f = $("tk-filters");
  f.innerHTML = "";
  for (const [id, label, fn] of FILTERS) {
    const n = all.filter(({ t, p }) => !t.removed_reason && fn(t, p)).length;
    const b = document.createElement("button");
    b.className = `chip-btn ${S.filter === id ? "on" : ""}`;
    b.innerHTML = `${esc(label)} <b>${n}</b>`;
    b.onclick = () => {
      S.filter = id;
      renderTickets();
    };
    f.appendChild(b);
  }

  const fn = (FILTERS.find((x) => x[0] === S.filter) || FILTERS[0])[2];
  const q = S.search.trim().toLowerCase();
  const rows = all
    .filter(({ t, p }) => fn(t, p) && (S.filter === "all" || !t.removed_reason))
    .filter(({ t }) => !q || `${t.key} ${t.summary} ${t.assignee || ""} ${t.status_name || ""}`.toLowerCase().includes(q))
    .sort((a, b) => {
      const r = sortRank(a.t, a.p) - sortRank(b.t, b.p);
      if (r) return r;
      if (a.t.rank != null && b.t.rank != null && a.t.rank !== b.t.rank) return a.t.rank - b.t.rank;
      return (a.t.key || "").localeCompare(b.t.key || "", undefined, { numeric: true });
    });

  const { prsByTicket } = links();
  const list = $("tk-list");
  list.innerHTML = "";
  if (!rows.length) {
    list.innerHTML = S.board.tickets.length
      ? `<div class="empty big">${icon("ticket")}No tickets in this view.</div>`
      : `<div class="empty big">${icon("ticket")}${
          S.board.status.state === "connected"
            ? "No tickets assigned yet. Once a tracker connection syncs, your tickets land here."
            : esc(S.board.status.detail || "Connecting to NebulaX…")
        }</div>`;
  }
  for (const { t, p } of rows) {
    const k = tkey(t.id);
    const el = document.createElement("div");
    el.className = `row ${S.selected === k ? "sel" : ""}`;
    el.dataset.k = k;
    const linked = prsByTicket.get(k) || [];
    const meta = [
      t.status_name && `<span>${esc(t.status_name)}</span>`,
      t.priority && `<span>${esc(t.priority)}</span>`,
      t.assignee && `<span>${esc(t.assignee)}</span>`,
      ...linked.map((pr) => `<span class="pill violet">${icon("pr")}#${pr.number}</span>`),
      t.removed_reason && `<span class="pill">removed</span>`,
      t.blocked_reason && `<span class="pill warn">blocked</span>`,
    ].filter(Boolean);
    const play = canStart(t)
      ? `<button class="play" title="Start ${esc(t.key)} with ${esc(harnessName(startPrefs().harness))}" aria-label="Start ${esc(t.key)}">${icon("play")}</button>`
      : "";
    el.innerHTML = `
      <div class="key">${esc(t.key || t.id.native)}</div>
      <div class="summary">${esc(t.summary)}</div>
      <div class="row-end"><span class="pill ${TONE_PILL[p.tone]}">${esc(p.label)}</span>${play}</div>
      <div class="meta">${meta.join('<span class="sub">·</span>')}</div>
      <div class="steps-wrap">${stepsHtml(p)}</div>`;
    el.onclick = () => {
      S.selected = k;
      renderTickets();
    };
    const pb = el.querySelector(".play");
    if (pb)
      pb.onclick = (e) => {
        e.stopPropagation();
        S.selected = k;
        startTicket(t);
      };
    list.appendChild(el);
  }
  if (!S.selected && rows.length) S.selected = tkey(rows[0].t.id);
  renderDetail();
}

function stepsHtml(p, withLabels = false) {
  const parts = [];
  STEPS.forEach((_, i) => {
    if (i > 0) parts.push(`<span class="bar ${i <= p.step ? "done" : ""}"></span>`);
    const cls = i < p.step ? "done" : i === p.step ? `cur ${p.tone}` : "";
    parts.push(`<span class="s ${cls}" title="${esc(STEPS[i])}"></span>`);
  });
  const labels = withLabels
    ? `<div class="step-labels">${STEPS.map((s, i) => `<span class="${i === p.step ? "cur" : ""}">${esc(s)}</span>`).join("")}</div>`
    : "";
  return `<div class="steps">${parts.join("")}</div>${labels}`;
}

function renderDetail() {
  const pane = $("tk-detail");
  const t = S.board.tickets.find((x) => tkey(x.id) === S.selected);
  if (!t) {
    pane.innerHTML = `<div class="empty big">Select a ticket to see its progress.</div>`;
    delete pane.dataset.ticket;
    return;
  }
  // Background repaints must not reset the branch box or snap a dropdown
  // shut while it is in use; the pane catches up when focus leaves it.
  const opts = pane.querySelector(".start-opts");
  if (pane.dataset.ticket === S.selected && opts && opts.contains(document.activeElement)) return;
  pane.dataset.ticket = S.selected;
  const p = progressOf(t);
  const { prsByTicket } = links();
  const linked = prsByTicket.get(S.selected) || [];
  const f = t.fields || {};
  const facts = [
    ["Status", t.status_name],
    ["Workflow", t.workflow ? t.workflow.replace(/_/g, " ") + (t.stage ? ` · ${t.stage}` : "") : "not started"],
    ["Delivery", t.delivery && t.delivery !== "no_pr" ? t.delivery.replace(/_/g, " ") : ""],
    ["Type", f.issue_type],
    ["Priority", t.priority],
    ["Assignee", t.assignee],
    ["Updated", t.updated_at ? rel(t.updated_at) : ""],
    ["Labels", (f.labels || []).join(", ")],
  ].filter(([, v]) => v);

  pane.innerHTML = `
    <div class="key">${esc(t.key || t.id.native)}</div>
    <h2>${esc(t.summary)}</h2>
    <span class="pill ${TONE_PILL[p.tone]}">${esc(p.label)}</span>
    <h3>Progress</h3>
    ${stepsHtml(p, true)}
    ${startBlockHtml(t)}
    <div class="actions" id="dt-actions"></div>
    ${t.blocked_reason ? `<h3>Blocked</h3><div class="note blocked">${esc(t.blocked_reason)}</div>` : ""}
    ${t.change_summary ? `<h3>What changed</h3><div class="note">${esc(t.change_summary)}</div>` : ""}
    ${
      t.evidence && t.evidence.length
        ? `<h3>Evidence</h3><div class="ev-list">${t.evidence
            .map((b) => {
              const tone = { passed: "ok", failed: "err", stale: "warn", running: "active" }[b.state] || "";
              return `<div class="ev-item"><span class="pill ${tone}">${esc(b.state.replace(/_/g, " "))}</span><span>${esc(b.kind.replace(/_/g, " "))}</span>${b.label ? `<span class="lbl">${esc(b.label)}</span>` : ""}</div>`;
            })
            .join("")}</div>`
        : ""
    }
    ${
      linked.length
        ? `<h3>Pull requests</h3><div class="pr-links">${linked
            .map((pr) => `<div class="mini" data-pr="${esc(pr.url)}"><span class="${prStateClass(pr)}">${icon(prStateIcon(pr))}</span><div style="min-width:0"><div class="t">${esc(pr.title)}</div><div class="b">${esc(pr.repo)}#${pr.number} · ${esc(prStateText(pr))}</div></div><span class="when">${rel(pr.updatedAt)}</span></div>`)
            .join("")}</div>`
        : ""
    }
    <h3>Details</h3>
    <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    ${f.description || t.brief ? `<h3>Description</h3><div class="prose">${esc(f.description || t.brief)}</div>` : ""}
    ${f.acceptance_criteria ? `<h3>Acceptance criteria</h3><div class="prose">${esc(f.acceptance_criteria)}</div>` : ""}
  `;
  const actions = pane.querySelector("#dt-actions");
  if (t.url) addBtn(actions, "Open in Jira", "external", () => api.openExternal(t.url));
  if (t.workflow || linked.length) addBtn(actions, "View changes", "diff", () => openChanges(t, linked));
  const nNotes = S.notes.filter((n) => scopeKey(n.scope) === `ticket:${S.selected}`).length;
  addBtn(actions, nNotes ? `Notes · ${nNotes}` : "Add note", "note", () => {
    const scope = ticketScope(t);
    go("notes");
    selectNoteScope(scopeKey(scope));
    if (!nNotes) newNote(scope);
  });
  pane.querySelectorAll("[data-pr]").forEach((el) => (el.onclick = () => go("prs", { pr: el.dataset.pr })));
  wireStartBlock(pane, t);
}

// ---------------------------------------------------------------- start

// The agents a ticket can be handed to; the choice is remembered as the
// default for the next play.
const HARNESSES = [
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["cursor", "Cursor"],
  ["pi", "Pi"],
];
const harnessName = (h) => (HARNESSES.find((x) => x[0] === h) || [h, h])[1];

function startPrefs() {
  const st = (S.settings && S.settings.start) || {};
  return { harness: st.harness || "claude", base: st.base ?? "develop", projects: st.projects || {} };
}

/** Anything not already underway, blocked, removed or done can be (re)started. */
function canStart(t) {
  if (t.blocked_reason || t.removed_reason) return false;
  if (t.workflow === "running" || t.workflow === "queued") return false;
  return progressOf(t).step < 6;
}

/**
 * The project a ticket starts in: the one last used for its connection,
 * else the only one open. Empty lets the daemon use the connection's `repo`.
 */
function startProject(t) {
  const projects = sortedProjects();
  const remembered = startPrefs().projects[t.id.connection];
  if (projects.some((p) => p.id === remembered)) return remembered;
  return projects.length === 1 ? projects[0].id : "";
}

function startBlockHtml(t) {
  const k = tkey(t.id);
  const pr = startPrefs();
  const msg = S.starting && S.starting.key === k ? S.starting : null;
  const busy = msg && msg.tone === "busy";
  const project = startProject(t);
  const projects = sortedProjects();
  const opt = (v, label, sel) => `<option value="${esc(v)}" ${sel ? "selected" : ""}>${esc(label)}</option>`;
  const status = msg ? `<div class="start-msg ${msg.tone}">${esc(msg.text)}</div>` : "";
  if (!canStart(t) && !busy) return status;
  return `
    <div class="start">
      <button class="play big" id="st-go" ${busy ? "disabled" : ""} title="Start implementing ${esc(t.key)}">${icon("play")}</button>
      <div class="start-opts">
        <div class="t">${busy ? "Starting…" : "Start implementing"}</div>
        <div class="start-row">
          <select id="st-harness" title="Which agent implements it — the default for next time">${HARNESSES.map(([v, l]) => opt(v, l, v === pr.harness)).join("")}</select>
          <select id="st-project" title="The project its branch is cut in">
            ${project ? "" : opt("", projects.length ? "Choose a project…" : "No projects open", true)}
            ${projects.map((p) => opt(p.id, p.name, p.id === project)).join("")}
          </select>
          <label class="st-base" title="Pulled from origin first; the new branch starts here">from<input id="st-base" value="${esc(pr.base)}" placeholder="default branch" spellcheck="false" /></label>
        </div>
      </div>
    </div>
    ${status}`;
}

function wireStartBlock(pane, t) {
  const go_ = pane.querySelector("#st-go");
  if (!go_) return;
  const save = () => {
    const projects = { ...startPrefs().projects };
    const project = pane.querySelector("#st-project").value;
    if (project) projects[t.id.connection] = project;
    const start = { harness: pane.querySelector("#st-harness").value, base: pane.querySelector("#st-base").value.trim(), projects };
    S.settings = { ...S.settings, start };
    return api.setSettings({ start });
  };
  pane.querySelector("#st-harness").onchange = save;
  pane.querySelector("#st-project").onchange = save;
  pane.querySelector("#st-base").onchange = save;
  pane.querySelector(".start-opts").onfocusout = () =>
    setTimeout(() => {
      if (!pane.querySelector(".start-opts")?.contains(document.activeElement)) renderDetail();
    });
  go_.onclick = async () => {
    await save();
    startTicket(t);
  };
}

/**
 * The play button: hand the ticket to the chosen agent — the daemon pulls the
 * base branch, cuts a branch named after the ticket, and opens the session —
 * then go watch it in the Working hub.
 */
async function startTicket(t) {
  const k = tkey(t.id);
  const pr = startPrefs();
  const who = harnessName(pr.harness);
  S.starting = { key: k, tone: "busy", text: `Pulling ${pr.base || "the default branch"} and opening a ${who} session…` };
  renderTickets();
  const r = await api.startTicket({ ticket: t.id, harness: pr.harness, project: startProject(t) || undefined, base: pr.base || undefined });
  if (r && r.ok) {
    S.starting = { key: k, tone: "ok", text: `${who} is implementing ${t.key} — follow it in the Working hub.` };
    go("terminal");
  } else {
    S.starting = { key: k, tone: "err", text: (r && r.error) || "NebulaX did not answer" };
    if (S.view === "tickets") renderTickets();
  }
}

function addBtn(parent, label, ic, fn) {
  const b = document.createElement("button");
  b.innerHTML = `${icon(ic)}<span>${esc(label)}</span>`;
  b.onclick = fn;
  parent.appendChild(b);
}

// ---------------------------------------------------------------- PRs

function prStateIcon(pr) {
  return pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "pr";
}
function prStateClass(pr) {
  if (pr.state === "MERGED") return "st-merged";
  if (pr.state === "CLOSED") return "st-closed";
  return pr.draft ? "st-draft" : "st-open";
}
function prStateText(pr) {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  return pr.draft ? "draft" : "open";
}

const PR_GROUPS = [
  ["review", "Waiting on your review", "No one is waiting on your review."],
  ["mine", "Your open pull requests", "You have no open pull requests."],
  // Bitbucket without read:user: nobody to sort by, so every open PR of the watched repos.
  ["open", "Open in watched repos", ""],
  ["closed", "Recently merged or closed", "Nothing merged or closed in the last two weeks."],
];

function renderPrs() {
  const err = $("pr-error");
  err.hidden = !S.prs.error;
  err.innerHTML = S.prs.error ? `${icon("alert")}<span>${esc(S.prs.error)}</span>` : "";
  const { ticketsByPr } = links();
  const root = $("pr-groups");
  root.innerHTML = "";
  if (!S.prs.lastPoll && !S.prs.error) {
    const who = S.prs.provider === "gh" || !S.prs.provider ? "GitHub" : `${S.prs.providerLabel} (through its MCP servers)`;
    root.innerHTML = `<div class="empty big">${icon("pr")}Asking ${esc(who)} for your pull requests…</div>`;
    return;
  }
  for (const [bucket, title, empty] of PR_GROUPS) {
    const list = S.prs.prs.filter((p) => p.bucket === bucket);
    if (!empty && !list.length) continue;
    const g = document.createElement("div");
    g.className = "pr-group";
    g.innerHTML = `<h2>${esc(title)} <b>${list.length}</b></h2>`;
    if (!list.length) g.innerHTML += `<div class="sub" style="padding:4px 2px 8px">${esc(empty)}</div>`;
    for (const pr of list) g.appendChild(prEl(pr, ticketsByPr.get(pr.url) || []));
    root.appendChild(g);
  }
}

function prEl(pr, tickets) {
  const el = document.createElement("div");
  el.className = "pr";
  el.dataset.url = pr.url;
  const checks = {
    SUCCESS: `<span class="pill ok">${icon("check")}checks</span>`,
    FAILURE: `<span class="pill err">${icon("x")}checks</span>`,
    ERROR: `<span class="pill err">${icon("x")}checks</span>`,
    PENDING: `<span class="pill active">checks running</span>`,
    EXPECTED: `<span class="pill active">checks pending</span>`,
  }[pr.checks] || "";
  const review = {
    APPROVED: `<span class="pill ok">approved</span>`,
    CHANGES_REQUESTED: `<span class="pill warn">changes requested</span>`,
    REVIEW_REQUIRED: pr.state === "OPEN" ? `<span class="pill">review required</span>` : "",
  }[pr.reviewDecision] || "";
  const ticketChips = tickets
    .map((t) => `<span class="pill blue link" data-ticket="${esc(tkey(t.id))}">${esc(t.key)}</span>`)
    .join("");
  // Only GitHub PRs can be diffed (through `gh`); the rest open in the browser.
  const diffable = /^https:\/\/github\.com\//.test(pr.url || "");
  const changes = diffable ? `<span class="pill link" data-changes title="View the code changes">${icon("diff")}changes</span>` : "";
  el.innerHTML = `
    <span class="${prStateClass(pr)}">${icon(prStateIcon(pr))}</span>
    <div class="title">${esc(pr.title)}</div>
    <div class="right">${changes}${ticketChips}${review}${checks}${pr.comments ? `<span class="cmt">${icon("comment")}${pr.comments}</span>` : ""}</div>
    <div class="meta">
      <span class="num">${esc(pr.repo)}#${pr.number}</span>
      ${pr.draft ? `<span class="pill">draft</span>` : ""}
      ${pr.bucket === "review" || pr.bucket === "open" || (pr.host === "bitbucket" && pr.author) ? `<span>by ${esc(pr.author)}</span>` : ""}
      <span>${pr.state === "MERGED" ? `merged ${rel(pr.mergedAt)}` : `updated ${rel(pr.updatedAt)}`}</span>
      ${pr.additions || pr.deletions ? `<span class="diffstat"><span class="a">+${pr.additions}</span> <span class="d">−${pr.deletions}</span></span>` : ""}
    </div>`;
  el.onclick = (e) => {
    const chip = e.target.closest("[data-ticket]");
    if (chip) {
      e.stopPropagation();
      go("tickets", { ticket: chip.dataset.ticket, filter: "all" });
      return;
    }
    if (e.target.closest("[data-changes]")) {
      e.stopPropagation();
      openPrChanges(pr);
      return;
    }
    api.openExternal(pr.url);
  };
  return el;
}

// ---------------------------------------------------------------- activity

function renderActivity() {
  const feed = $("feed");
  feed.innerHTML = "";
  if (!S.activity.length) {
    feed.innerHTML = `<div class="empty big">${icon("bell")}No updates yet. Ticket moves, PR reviews, checks and merges land here — and on your desktop.</div>`;
    return;
  }
  let day = "";
  S.activity.forEach((e, i) => {
    const d = new Date(e.ts).toDateString();
    if (d !== day) {
      day = d;
      const h = document.createElement("div");
      h.className = "day";
      const today = new Date().toDateString();
      const yday = new Date(Date.now() - 864e5).toDateString();
      h.textContent = d === today ? "Today" : d === yday ? "Yesterday" : new Date(e.ts).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
      feed.appendChild(h);
    }
    const el = document.createElement("div");
    el.className = `ev-row ${i < S.unreadShown ? "unread" : ""}`;
    const ic = e.category === "prs" ? "pr" : e.category === "connections" ? "plug" : e.category === "worktrees" ? "branch" : "ticket";
    el.innerHTML = `
      <span class="lv-${esc(e.level)}">${icon(ic)}</span>
      <div class="t">${esc(e.title)}<span class="cat">${esc({ prs: "pull request", tickets: "ticket", connections: "connection", worktrees: "worktrees" }[e.category] || "")}</span></div>
      <span class="when" title="${esc(new Date(e.ts).toLocaleString())}">${rel(e.ts)}</span>
      ${e.body ? `<div class="b">${esc(e.body)}</div>` : ""}`;
    el.onclick = () => goTarget(e.target);
    feed.appendChild(el);
  });
}

// ---------------------------------------------------------------- notes

const scopeKey = (s) => (!s || s.kind === "general" ? "general" : `${s.kind}:${s.id}`);
const ticketScope = (t) => ({ kind: "ticket", id: tkey(t.id), label: t.key ? `${t.key} · ${t.summary}` : t.summary });
const projectScope = (p) => ({ kind: "project", id: p.id, label: p.name });

function noteTitle(n) {
  const line = (n.body || "").split("\n").find((l) => l.trim());
  return line ? line.trim().replace(/^#+\s*/, "") : "Empty note";
}

function scopeLabel(s) {
  if (!s || s.kind === "general") return "General";
  if (s.kind === "project") {
    const p = S.wtProjects.find((x) => x.id === s.id);
    return p ? p.name : s.label || "Removed project";
  }
  const t = S.board.tickets.find((x) => tkey(x.id) === s.id);
  return t ? t.key || t.summary : (s.label || "").split(" · ")[0] || "Removed ticket";
}

/** The scope a new note gets from what's being shown. */
function scopeFromKey(key) {
  if (key === "all" || key === "general") return { kind: "general" };
  const [kind, ...rest] = key.split(":");
  const id = rest.join(":");
  const from = S.notes.find((n) => scopeKey(n.scope) === key);
  if (kind === "project") {
    const p = S.wtProjects.find((x) => x.id === id);
    return p ? projectScope(p) : from ? from.scope : { kind: "general" };
  }
  const t = S.board.tickets.find((x) => tkey(x.id) === id);
  return t ? ticketScope(t) : from ? from.scope : { kind: "general" };
}

function visibleNotes() {
  const q = S.ntSearch.trim().toLowerCase();
  return S.notes
    .filter((n) => S.ntScope === "all" || scopeKey(n.scope) === S.ntScope)
    .filter((n) => !q || `${n.body} ${scopeLabel(n.scope)}`.toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

let ntSaveTimer = null;
let ntPending = null;

function saveNoteSoon(note) {
  ntPending = note;
  clearTimeout(ntSaveTimer);
  ntSaveTimer = setTimeout(flushNote, 400);
}

async function flushNote() {
  clearTimeout(ntSaveTimer);
  const note = ntPending;
  ntPending = null;
  if (!note) return;
  // The open editor holds this very object, so it stays the one in S.notes.
  await api.saveNote(note);
}

/** Leaving the open note: save what's typed, drop it if it was left blank. */
function leaveNote() {
  const n = S.notes.find((x) => x.id === S.ntSelected);
  if (n && !n.body.trim()) {
    ntPending = null;
    clearTimeout(ntSaveTimer);
    S.notes = S.notes.filter((x) => x.id !== n.id);
    api.deleteNote(n.id);
    S.ntSelected = null;
    renderNav();
  } else flushNote();
}

function selectNote(id) {
  if (id === S.ntSelected) return;
  leaveNote();
  S.ntSelected = id;
  renderNotes();
}

function selectNoteScope(key) {
  if (key === S.ntScope) return;
  leaveNote();
  S.ntScope = key;
  S.ntSelected = null;
  renderNotes();
}

let creatingNote = false;

async function newNote(scope = scopeFromKey(S.ntScope)) {
  // A second click before the first note lands would leave an empty one behind.
  if (creatingNote) return;
  creatingNote = true;
  leaveNote();
  let note;
  try {
    note = await api.saveNote({ scope, body: "" });
  } finally {
    creatingNote = false;
  }
  S.notes.unshift(note);
  if (S.ntScope !== "all" && S.ntScope !== scopeKey(scope)) S.ntScope = "all";
  S.ntSearch = "";
  $("nt-search").value = "";
  S.ntSelected = note.id;
  renderNotes();
  renderNav();
  renderTopbar();
  const ta = document.querySelector("#nt-editor textarea");
  if (ta) ta.focus();
}

async function deleteNote(id) {
  ntPending = null;
  clearTimeout(ntSaveTimer);
  await api.deleteNote(id);
  S.notes = S.notes.filter((n) => n.id !== id);
  S.ntSelected = null;
  renderNotes();
  renderNav();
  renderTopbar();
}

function renderNotes() {
  renderNoteScopes();
  renderNoteList();
  renderNoteEditor();
}

function renderNoteScopes() {
  const count = (key) => S.notes.filter((n) => scopeKey(n.scope) === key).length;
  const root = $("nt-scopes");
  root.innerHTML = "";
  const add = (key, name, n, sub) => {
    const b = document.createElement("button");
    b.className = `wt-proj ${key === S.ntScope ? "on" : ""} ${n ? "" : "empty-proj"}`;
    b.innerHTML = `<span class="name">${esc(name)}</span><b>${n || ""}</b>${sub ? `<span class="repo" style="direction:ltr">${esc(sub)}</span>` : ""}`;
    b.onclick = () => selectNoteScope(key);
    root.appendChild(b);
  };
  const head = (label) => root.insertAdjacentHTML("beforeend", `<h4>${esc(label)}</h4>`);
  add("all", "All notes", S.notes.length);
  add("general", "General", count("general"));

  // Every open project, plus removed ones that still hold notes.
  const projects = new Map(sortedProjects().map((p) => [`project:${p.id}`, p.name]));
  for (const n of S.notes) if (n.scope.kind === "project" && !projects.has(scopeKey(n.scope))) projects.set(scopeKey(n.scope), scopeLabel(n.scope));
  if (projects.size) head("Projects");
  for (const [key, name] of projects) add(key, name, count(key));

  // Tickets only once they hold a note (or are being shown) — the board is long.
  const tickets = new Map();
  for (const n of S.notes) if (n.scope.kind === "ticket") tickets.set(scopeKey(n.scope), n.scope);
  if (S.ntScope.startsWith("ticket:") && !tickets.has(S.ntScope)) tickets.set(S.ntScope, scopeFromKey(S.ntScope));
  if (tickets.size) head("Tickets");
  for (const [key, scope] of tickets) {
    const t = S.board.tickets.find((x) => tkey(x.id) === scope.id);
    add(key, scopeLabel(scope), count(key), t ? t.summary : (scope.label || "").split(" · ").slice(1).join(" · "));
  }
}

function renderNoteList() {
  const rows = visibleNotes();
  const root = $("nt-list");
  root.innerHTML = "";
  if (!rows.length) {
    root.innerHTML = `<div class="empty">${S.ntSearch ? "No notes match the search." : "No notes here yet."}</div>`;
    return;
  }
  for (const n of rows) {
    const b = document.createElement("button");
    b.className = `nt-item ${n.id === S.ntSelected ? "on" : ""}`;
    b.innerHTML = `<div class="t">${esc(noteTitle(n))}</div><div class="b"><span class="scope">${esc(scopeLabel(n.scope))}</span><span>·</span><span>${rel(n.updatedAt)}</span></div>`;
    b.onclick = () => selectNote(n.id);
    root.appendChild(b);
  }
}

function renderNoteEditor() {
  const pane = $("nt-editor");
  const n = S.notes.find((x) => x.id === S.ntSelected);
  if (!n) {
    pane.innerHTML = `<div class="empty big">${icon("note")}Pick a note, or start a new one.</div>`;
    delete pane.dataset.note;
    return;
  }
  // Background repaints (board updates, the 30s clock) must not yank the
  // textarea out from under someone typing in it.
  if (pane.dataset.note === n.id && pane.contains(document.activeElement)) {
    pane.querySelector("#nt-when").textContent = `edited ${rel(n.updatedAt)}`;
    return;
  }
  pane.dataset.note = n.id;
  const opt = (s, label) => `<option value="${esc(scopeKey(s))}" ${scopeKey(s) === scopeKey(n.scope) ? "selected" : ""}>${esc(label)}</option>`;
  const projects = sortedProjects().map(projectScope);
  if (n.scope.kind === "project" && !projects.some((s) => s.id === n.scope.id)) projects.unshift(n.scope);
  const tickets = liveTickets().map(ticketScope);
  if (n.scope.kind === "ticket" && !tickets.some((s) => s.id === n.scope.id)) tickets.unshift(n.scope);
  const byKey = new Map([...projects, ...tickets].map((s) => [scopeKey(s), s]));

  pane.innerHTML = `
    <div class="toolbar">
      <select id="nt-scope" title="What this note is about">
        ${opt({ kind: "general" }, "General note")}
        ${projects.length ? `<optgroup label="Project">${projects.map((s) => opt(s, s.label)).join("")}</optgroup>` : ""}
        ${tickets.length ? `<optgroup label="Ticket">${tickets.map((s) => opt(s, s.label)).join("")}</optgroup>` : ""}
      </select>
      <span class="sub" id="nt-when">edited ${rel(n.updatedAt)}</span>
      <span class="spacer"></span>
      <button class="btn danger" id="nt-delete">${icon("trash")}<span>Delete</span></button>
    </div>
    <textarea id="nt-body" placeholder="Write a note… the first line is its title." spellcheck="true"></textarea>`;
  const ta = pane.querySelector("#nt-body");
  ta.value = n.body;
  ta.oninput = () => {
    n.body = ta.value;
    n.updatedAt = Date.now();
    pane.querySelector("#nt-when").textContent = "edited just now";
    saveNoteSoon(n);
    renderNoteList();
  };
  pane.querySelector("#nt-scope").onchange = (e) => {
    n.scope = e.target.value === "general" ? { kind: "general" } : byKey.get(e.target.value);
    n.updatedAt = Date.now();
    saveNoteSoon(n);
    flushNote();
    // Moved out of what's shown: follow it.
    if (S.ntScope !== "all" && S.ntScope !== scopeKey(n.scope)) S.ntScope = scopeKey(n.scope);
    renderNoteScopes();
    renderNoteList();
  };
  pane.querySelector("#nt-delete").onclick = () => deleteNote(n.id);
}

// ---------------------------------------------------------------- worktrees

function sortedProjects() {
  return [...S.wtProjects].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function visibleWorktrees() {
  const q = S.wtSearch.trim().toLowerCase();
  return S.worktrees
    .filter((w) => w.project_id === S.wtProject)
    .filter((w) => !q || `${w.branch} ${w.path}`.toLowerCase().includes(q))
    .sort((a, b) => a.branch.localeCompare(b.branch, undefined, { numeric: true }));
}

function selectWorktreeProject(id) {
  if (id === S.wtProject) return;
  S.wtProject = id;
  // A selection never spans projects: what's ticked is what's on screen.
  S.wtChecked.clear();
  S.wtSearch = "";
  $("wt-search").value = "";
  renderWorktrees();
}

function renderWorktreeProjects() {
  const projects = sortedProjects();
  // Land on the first project that has something to clean up.
  if (!projects.some((p) => p.id === S.wtProject)) {
    S.wtProject = (projects.find((p) => p.worktrees) || projects[0] || {}).id || null;
    S.wtChecked.clear();
  }
  const list = $("wt-projects");
  list.innerHTML = projects.length
    ? ""
    : `<div class="sub" style="padding:4px 10px">${
        S.board.status.state === "connected" ? "No projects open in NebulaX yet." : esc(S.board.status.detail || "Connecting…")
      }</div>`;
  for (const p of projects) {
    const b = document.createElement("button");
    b.className = `wt-proj ${p.id === S.wtProject ? "on" : ""} ${p.worktrees ? "" : "empty-proj"}`;
    b.title = p.repo;
    b.innerHTML = `<span class="name">${esc(p.name)}</span><b>${p.worktrees || ""}</b><span class="repo"><bdi dir="ltr">${esc(p.repo)}</bdi></span>`;
    b.onclick = () => selectWorktreeProject(p.id);
    list.appendChild(b);
  }
}

function renderWorktrees() {
  renderWorktreeProjects();
  // Rows that vanished (deleted here or elsewhere) can't stay ticked.
  const ids = new Set(S.worktrees.map((w) => w.id));
  for (const set of [S.wtChecked, S.wtBusy]) for (const id of set) if (!ids.has(id)) set.delete(id);
  for (const id of S.wtErrors.keys()) if (!ids.has(id)) S.wtErrors.delete(id);

  const rows = visibleWorktrees();
  const project = S.wtProjects.find((p) => p.id === S.wtProject);
  const root = $("wt-groups");
  root.innerHTML = "";
  if (!rows.length) {
    root.innerHTML = `<div class="empty big">${icon("branch")}${
      S.board.status.state !== "connected"
        ? esc(S.board.status.detail || "Connecting to NebulaX…")
        : !project
          ? "Pick a project to see its worktrees."
          : project.worktrees
            ? "No worktrees match the filter."
            : `${esc(project.name)} is down to its main checkout — nothing to clean up.`
    }</div>`;
  } else {
    const g = document.createElement("div");
    g.className = "wt-group";
    g.innerHTML = `<h2>${esc(project.name)} <b>${rows.length}</b><span class="sub">${esc(project.repo)}</span></h2>`;
    for (const w of rows) g.appendChild(worktreeEl(w));
    root.appendChild(g);
  }
  syncWorktreeToolbar(rows);
  renderRotateBar();
}

function renderRotateBar() {
  const r = (S.settings && S.settings.rotate) || {};
  const on = $("rot-on");
  on.checked = !!r.enabled;
  // Don't clobber a number the user is typing.
  if (document.activeElement !== $("rot-n")) $("rot-n").value = r.olderThan || 7;
  $("rot-unit").value = r.unit || "days";
  $("rot-basis").value = r.basis || "activity";
  const due = S.worktrees.filter(wouldRotate).length;
  const { running, last } = S.rotate;
  const run = $("rot-run");
  run.disabled = running || S.board.status.state !== "connected";
  run.textContent = running ? "Rotating…" : "Rotate now";
  const bits = [];
  if (r.enabled) bits.push(due ? `${due} due across all projects` : "nothing due across all projects");
  else bits.push("off");
  if (last) {
    const what = last.deleted.length ? `deleted ${last.deleted.length}` : "deleted none";
    bits.push(`last run ${rel(last.ts)}, ${what}${last.kept.length ? `, kept ${last.kept.length}` : ""}`);
  }
  $("rot-status").textContent = bits.join(" · ");
}

function saveRotate() {
  const n = Math.round(Number($("rot-n").value));
  S.settings.rotate = {
    enabled: $("rot-on").checked,
    olderThan: n >= 1 ? n : S.settings.rotate.olderThan,
    unit: $("rot-unit").value,
    basis: $("rot-basis").value,
  };
  api.setSettings({ rotate: S.settings.rotate });
  renderWorktrees();
}

function onRotateStatus(st) {
  const wasDue = S.rotate.due || [];
  S.rotate = st;
  // Rows the pass is working through read "deleting…" until their reply.
  for (const id of st.due || []) S.wtBusy.add(id);
  if (!st.running) for (const id of wasDue) S.wtBusy.delete(id);
  if (S.view === "worktrees") renderWorktrees();
}

const ROT_UNIT_MS = { hours: 3600_000, days: 86400_000, weeks: 7 * 86400_000 };

/** Whether the rotation rule, when on, would delete this checkout now. */
function wouldRotate(w) {
  const r = S.settings && S.settings.rotate;
  const cutoff = r && r.enabled ? Number(r.olderThan) * (ROT_UNIT_MS[r.unit] || 0) : 0;
  const t = r && r.basis === "created" ? w.created : w.active;
  return cutoff > 0 && !!t && !w.running && Date.now() - t > cutoff;
}

function worktreeEl(w) {
  const el = document.createElement("div");
  const busy = S.wtBusy.has(w.id);
  const on = S.wtChecked.has(w.id);
  el.className = `wt ${on ? "on" : ""} ${busy ? "busy" : ""}`;
  const err = S.wtErrors.get(w.id);
  const sessions = w.running
    ? `<span class="pill active">${w.running} running</span>`
    : w.sessions
      ? `<span class="pill">${w.sessions} session${w.sessions === 1 ? "" : "s"}</span>`
      : "";
  const basis = S.settings && S.settings.rotate && S.settings.rotate.basis === "created" ? "created" : "active";
  const t = w[basis];
  const age = t
    ? `<span class="age" title="made ${esc(new Date(w.created).toLocaleString())} · last git activity ${esc(new Date(w.active).toLocaleString())}">${basis === "created" ? "made" : "active"} ${rel(t)}</span>`
    : "";
  const stale = wouldRotate(w) ? `<span class="pill warn" title="Past the auto-delete cutoff — the next rotation removes it">old</span>` : "";
  el.innerHTML = `
    <input type="checkbox" ${on ? "checked" : ""} ${busy ? "disabled" : ""} aria-label="Select ${esc(w.branch)}" />
    <div class="branch">${esc(w.branch)}</div>
    <div class="right">${busy ? `<span class="pill">deleting…</span>` : `${age}${stale}${sessions}`}</div>
    <div class="path" title="${esc(w.path)}">${esc(w.path)}</div>
    ${err ? `<div class="err-msg">${esc(err)}</div>` : ""}`;
  el.onclick = () => {
    if (busy) return;
    if (on) S.wtChecked.delete(w.id);
    else S.wtChecked.add(w.id);
    renderWorktrees();
  };
  return el;
}

function syncWorktreeToolbar(rows = visibleWorktrees()) {
  const selectable = rows.filter((w) => !S.wtBusy.has(w.id));
  const ticked = selectable.filter((w) => S.wtChecked.has(w.id)).length;
  const all = $("wt-all");
  all.checked = selectable.length > 0 && ticked === selectable.length;
  all.indeterminate = ticked > 0 && ticked < selectable.length;
  all.disabled = !selectable.length;
  $("wt-all-label").textContent = ticked ? `${ticked} selected` : "Select all";
  const n = S.wtChecked.size;
  const del = $("wt-delete");
  del.disabled = !n || S.board.status.state !== "connected";
  del.innerHTML = `${icon("trash")}<span>${n ? `Delete ${n} worktree${n === 1 ? "" : "s"}` : "Delete selected"}</span>`;
}

function confirmDeleteWorktrees() {
  const picked = visibleWorktrees().filter((w) => S.wtChecked.has(w.id));
  const project = S.wtProjects.find((p) => p.id === S.wtProject);
  if (!picked.length) return;
  const force = $("wt-force").checked;
  const live = picked.reduce((n, w) => n + w.sessions, 0);
  $("wtc-title").textContent = `Delete ${picked.length} worktree${picked.length === 1 ? "" : "s"} of ${project ? project.name : "this project"}?`;
  $("wtc-body").textContent = [
    "Each checkout folder is removed from disk (git worktree remove); the branches stay.",
    live ? `${live} session${live === 1 ? "" : "s"} inside will be stopped.` : "",
    force ? "Force is on: uncommitted changes in them are lost." : "A worktree with uncommitted changes is kept and reported — tick Force to discard them.",
  ]
    .filter(Boolean)
    .join(" ");
  $("wtc-list").innerHTML = picked.map((w) => `<li>${esc(w.branch)}</li>`).join("");
  $("wtc-ok").onclick = () => {
    $("wt-confirm").close();
    deleteWorktrees(picked.map((w) => w.id), force);
  };
  $("wt-confirm").showModal();
}

async function deleteWorktrees(ids, force) {
  for (const id of ids) {
    S.wtBusy.add(id);
    S.wtChecked.delete(id);
    S.wtErrors.delete(id);
  }
  renderWorktrees();
  await api.deleteWorktrees(ids, force);
}

function onWorktreeProgress(r) {
  S.wtBusy.delete(r.id);
  if (!r.ok) {
    S.wtErrors.set(r.id, r.error || "could not delete");
    S.wtChecked.add(r.id); // still ticked, ready for a retry with Force
  }
  if (S.view === "worktrees") renderWorktrees();
}

// ---------------------------------------------------------------- projects

// The projects NebulaX has open. Adding or removing one here goes through the
// daemon, so the Working hub (the TUI) shows the change as it happens.

function renderProjects() {
  for (const id of S.pjBusy) if (!S.wtProjects.some((p) => p.id === id)) S.pjBusy.delete(id);
  const banner = $("pj-error");
  banner.hidden = !S.pjError;
  banner.textContent = S.pjError;

  const q = S.pjSearch.trim().toLowerCase();
  const rows = sortedProjects().filter((p) => !q || `${p.name} ${p.repo}`.toLowerCase().includes(q));
  const root = $("pj-list");
  root.innerHTML = "";
  if (!rows.length) {
    root.innerHTML = `<div class="empty big">${icon("folder")}${
      S.board.status.state !== "connected"
        ? esc(S.board.status.detail || "Connecting to NebulaX…")
        : S.wtProjects.length
          ? "No projects match the filter."
          : "No projects open in NebulaX yet — add a git repo to start working in it."
    }</div>`;
    return;
  }
  for (const p of rows) root.appendChild(projectEl(p));
}

function projectEl(p) {
  const busy = S.pjBusy.has(p.id);
  const el = document.createElement("div");
  el.className = `pj ${busy ? "busy" : ""}`;
  const bits = [
    p.running ? `<span class="pill active">${p.running} running</span>` : "",
    p.sessions && !p.running ? `<span class="pill">${p.sessions} session${p.sessions === 1 ? "" : "s"}</span>` : "",
    p.worktrees ? `<span class="pill">${p.worktrees} worktree${p.worktrees === 1 ? "" : "s"}</span>` : "",
  ].join("");
  el.innerHTML = `
    ${icon("folder", "pj-ic")}
    <div class="name">${esc(p.name)}</div>
    <div class="right">${busy ? `<span class="pill">removing…</span>` : bits}</div>
    <div class="path" title="${esc(p.repo)}">${esc(p.repo)}</div>`;
  const rm = document.createElement("button");
  rm.className = "btn danger pj-rm";
  rm.disabled = busy || S.board.status.state !== "connected";
  rm.title = `Remove ${p.name} from NebulaX`;
  rm.innerHTML = `${icon("trash")}<span>Remove</span>`;
  rm.onclick = () => confirmRemoveProject(p);
  el.querySelector(".right").appendChild(rm);
  return el;
}

async function addProjects() {
  S.pjError = "";
  const results = await api.addProjects();
  const failed = results.filter((r) => !r.ok);
  S.pjError = failed.map((r) => `${r.path}: ${r.error || "could not add"}`).join("\n");
  if (S.view === "projects") renderProjects();
}

function confirmRemoveProject(p) {
  $("pjc-title").textContent = `Remove ${p.name}?`;
  $("pjc-body").textContent = [
    "NebulaX stops tracking it and it leaves the Working hub. The folder on disk is not touched.",
    p.sessions ? `Its ${p.sessions} session${p.sessions === 1 ? "" : "s"} will be closed.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  $("pjc-ok").onclick = async () => {
    $("pj-confirm").close();
    S.pjBusy.add(p.id);
    S.pjError = "";
    renderProjects();
    const r = await api.removeProject(p.id);
    if (!r.ok) {
      S.pjBusy.delete(p.id);
      S.pjError = `${p.name}: ${r.error || "could not remove"}`;
    }
    if (S.view === "projects") renderProjects();
  };
  $("pj-confirm").showModal();
}

// ---------------------------------------------------------------- changes modal

// One modal, two places the code can be: the ticket's pull request (what
// reviewers see — shown first when there is one) and the run's worktree
// (local work, pushed or not). The strip under the title says which, and how
// far the work has travelled: local only, commits not pushed, pushed, PR.

let chView = null; // { ticket, source: "pr" | "local", pr }

function openChanges(t, linked) {
  const pr = [...(linked || [])].sort((a, b) => (a.state === "OPEN") - (b.state === "OPEN") || Date.parse(a.updatedAt) - Date.parse(b.updatedAt)).pop();
  const sources = [];
  if (pr) sources.push({ id: "pr", label: `PR #${pr.number}` });
  if (t.workflow) sources.push({ id: "local", label: "Worktree" });
  $("ch-title").textContent = `${t.key || t.id.native} — changes`;
  const seg = $("ch-src");
  seg.innerHTML = "";
  if (sources.length > 1) {
    for (const s of sources) {
      const b = document.createElement("button");
      b.textContent = s.label;
      b.dataset.src = s.id;
      b.onclick = () => showSource(t, s.id, pr);
      seg.appendChild(b);
    }
  }
  $("changes").showModal();
  showSource(t, sources[0].id, pr);
}

/** The changes modal for a pull request on its own, from the Pull requests view. */
function openPrChanges(pr) {
  $("ch-title").textContent = `${pr.repo}#${pr.number} — changes`;
  $("ch-src").innerHTML = "";
  $("changes").showModal();
  showSource(null, "pr", pr);
}

function showSource(t, source, pr) {
  chView = { ticket: t ? tkey(t.id) : null, source, pr };
  $("ch-src").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.src === source));
  $("ch-count").textContent = "";
  $("ch-where").innerHTML = source === "pr" ? prWhere(pr) : "";
  $("ch-body").innerHTML = `<div class="empty">Loading the diff…</div>`;
  const view = chView;
  if (source === "pr") {
    api.prDiff(pr.url).then((r) => {
      if (chView !== view) return;
      if (!r.ok) {
        $("ch-body").innerHTML = `<div class="empty">${esc(r.error)}</div>`;
        return;
      }
      showDiff(r.diff, "The pull request has no file changes.");
    });
  } else {
    api.requestChanges(t.id).then((sent) => {
      if (chView === view && !sent) $("ch-body").innerHTML = `<div class="empty">Not connected to NebulaX.</div>`;
    });
  }
}

function prWhere(pr) {
  return `<span class="pill violet">${esc(prStateText(pr))}</span><span>${esc(pr.repo)}#${pr.number}</span>${pr.headRef ? `<span class="branch">${esc(pr.headRef)}</span>` : ""}<span class="pill link" id="ch-open-pr">Open on GitHub</span>`;
}

function localWhere(loc) {
  if (!loc) return "";
  const n = (k) => `${k} commit${k === 1 ? "" : "s"}`;
  const [tone, text] = !loc.pushed
    ? ["warn", loc.unpushed ? `local only · ${n(loc.unpushed)} not pushed` : "local only · nothing committed"]
    : loc.unpushed
      ? ["warn", `pushed · ${n(loc.unpushed)} newer not pushed`]
      : ["ok", "pushed · up to date"];
  return `<span class="pill ${tone}">${esc(text)}</span>${loc.dirty ? `<span class="pill active">uncommitted edits</span>` : ""}<span class="branch">${esc(loc.branch)}</span>`;
}

function onChanges(p) {
  if (!p || !p.ticket || !chView || chView.source !== "local" || tkey(p.ticket) !== chView.ticket) return;
  $("ch-where").innerHTML = localWhere(p.location);
  showDiff(p.diff || "", p.note || "No changes yet.");
}

function showDiff(diff, emptyNote) {
  const files = parseDiff(diff);
  if (!files.length) {
    $("ch-body").innerHTML = `<div class="empty">${esc(emptyNote)}</div>`;
    return;
  }
  const adds = files.reduce((n, f) => n + f.adds, 0);
  const dels = files.reduce((n, f) => n + f.dels, 0);
  $("ch-count").textContent = `${files.length} file${files.length === 1 ? "" : "s"} · +${adds} −${dels}`;
  renderFileList(files);
}

function renderFileList(files) {
  const body = $("ch-body");
  body.innerHTML = "";
  for (const file of files) {
    const row = document.createElement("div");
    row.className = "file-row";
    row.innerHTML = `<span class="path">${esc(file.path)}</span><span class="a">+${file.adds}</span><span class="d">−${file.dels}</span>`;
    row.onclick = () => renderFileDiff(files, file);
    body.appendChild(row);
  }
}

// A file's diff past this many lines is cut, with a button for the rest —
// a lockfile or generated bundle shouldn't freeze the modal.
const DIFF_CUT = 400;

function diffLine(l) {
  return `<span class="${l[0] === "+" ? "a" : l[0] === "-" ? "d" : l.startsWith("@@") ? "h" : "m"}">${esc(l)}</span>`;
}

function renderFileDiff(files, file) {
  const body = $("ch-body");
  body.innerHTML = "";
  const back = document.createElement("span");
  back.className = "back";
  back.textContent = "‹ All files";
  back.onclick = () => renderFileList(files);
  const pre = document.createElement("pre");
  pre.className = "diff";
  const cut = file.lines.length > DIFF_CUT;
  pre.innerHTML = (cut ? file.lines.slice(0, DIFF_CUT) : file.lines).map(diffLine).join("\n");
  body.append(back, pre);
  if (cut) {
    const more = document.createElement("button");
    more.className = "diff-more";
    more.textContent = `Show ${file.lines.length - DIFF_CUT} more lines`;
    more.onclick = () => {
      pre.innerHTML = file.lines.map(diffLine).join("\n");
      more.remove();
    };
    body.appendChild(more);
  }
}

function parseDiff(diff) {
  const files = [];
  let cur = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/ b\/(.+)$/);
      cur = { path: m ? m[1] : line.slice(11), adds: 0, dels: 0, lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.lines.push(line);
    if (line.startsWith("+") && !line.startsWith("+++")) cur.adds++;
    else if (line.startsWith("-") && !line.startsWith("---")) cur.dels++;
  }
  return files;
}

// ---------------------------------------------------------------- terminal

// Two PTY panes share this code: the Working hub (the NebulaX TUI) and the
// Terminal view (a plain login shell). Each keeps running in the main process
// whether or not it's on screen; a pane attaches only while its view is
// visible (see TerminalHost). Attaching answers with the screen so far;
// output that races the answer is held in `pending` and written after it.

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function makePane({ view, el, nav, pty, name }) {
  const P = { view, name, xterm: null, fit: null, running: false, started: false, starting: false, attached: false, pending: null };

  const visible = () => S.view === view && document.visibilityState === "visible";

  P.ensure = () => {
    if (!P.xterm) create();
    P.sync();
  };

  /** Attach while the view is visible, detach otherwise. */
  P.sync = () => {
    const { xterm, fit } = P;
    if (!xterm) return;
    if (visible()) {
      requestAnimationFrame(() => {
        fit.fit();
        xterm.focus();
        // Not started yet, or running but detached → (re)join it.
        if (!P.attached && (P.running || !P.started)) start();
      });
    } else if (P.attached) {
      P.attached = false;
      P.pending = null;
      pty.detach();
    }
  };

  function create() {
    const xterm = new Terminal({
      fontFamily: '"SF Mono", "JetBrains Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      macOptionIsMeta: true,
      scrollback: 5000,
      theme: {
        background: "#0a0c10",
        foreground: "#e6e9ef",
        cursor: cssVar("--gold") || "#e8c547",
        selectionBackground: "#2c334a",
        black: "#1e2432", red: "#e06c75", green: "#4ec9a5", yellow: "#e8c547",
        blue: "#6ea8fe", magenta: "#b99cf6", cyan: "#56b6c2", white: "#e6e9ef",
        brightBlack: "#5b6478", brightRed: "#ff7b86", brightGreen: "#6ee0bc", brightYellow: "#f3d66b",
        brightBlue: "#8fbcff", brightMagenta: "#cdb6ff", brightCyan: "#7fd3dc", brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon.FitAddon();
    xterm.loadAddon(fit);
    xterm.open($(el));
    // GPU rendering: far cheaper than the DOM renderer for a TUI that redraws
    // many times a second. Falls back to the DOM renderer if WebGL is lost.
    try {
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      xterm.loadAddon(webgl);
    } catch {
      // no WebGL — the DOM renderer carries on
    }
    P.xterm = xterm;
    P.fit = fit;
    xterm.onData((d) => {
      if (!P.running) {
        if (d === "\r") start();
        return;
      }
      pty.write(d);
    });
    xterm.onResize(({ cols, rows }) => pty.resize(cols, rows));
    new ResizeObserver(() => {
      if (visible()) fit.fit();
    }).observe($(el));
  }

  /** Start the process (or rejoin the running one) and paint its current screen. */
  async function start() {
    // Enter pressed twice on an exited pane must not start it twice.
    if (P.starting) return;
    P.starting = true;
    const { xterm } = P;
    P.attached = true;
    P.pending = [];
    let r;
    try {
      r = await pty.start(xterm.cols, xterm.rows);
    } finally {
      P.starting = false;
    }
    P.started = true;
    if (!r.ok) {
      P.running = false;
      P.attached = false;
      P.pending = null;
      xterm.writeln(`\x1b[31m${r.error}\x1b[0m`);
      xterm.writeln("\x1b[2mFix it in Settings, then press Enter to try again.\x1b[0m");
    } else if (!P.attached) {
      P.running = true; // detached while we waited; the next visit rejoins
    } else {
      P.running = true;
      xterm.reset();
      xterm.write(r.snapshot || "");
      for (const d of P.pending || []) xterm.write(d);
      P.pending = null;
      if (visible()) xterm.focus();
      else P.sync(); // hidden while we waited — let go again
    }
    P.renderNav();
    if (S.view === view) renderTopbar();
  }

  P.restart = async () => {
    if (!P.xterm) return go(view);
    await pty.kill();
    P.running = false;
    P.attached = false;
    P.xterm.reset();
    start();
  };

  P.renderNav = () => {
    $(nav).textContent = P.running ? "●" : "";
  };

  pty.onData((d) => {
    if (!P.xterm || !P.attached) return;
    if (P.pending) P.pending.push(d);
    else P.xterm.write(d);
  });
  pty.onExit(() => {
    P.running = false;
    P.attached = false;
    P.renderNav();
    if (P.xterm) P.xterm.writeln(`\r\n\x1b[2m[${name} exited — press Enter to start it again]\x1b[0m`);
    if (S.view === view) renderTopbar();
  });
  document.addEventListener("visibilitychange", P.sync);
  return P;
}

const hub = makePane({ view: "terminal", el: "term", nav: "nav-term", pty: api.terminal, name: "nebula" });
const shellPane = makePane({ view: "shell", el: "shell-term", nav: "nav-shell", pty: api.shell, name: "shell" });
const PANES = { terminal: hub, shell: shellPane };

// ---------------------------------------------------------------- settings

// The per-kind sound pickers: None plus whatever the system has.
let SOUNDS = null;
async function fillSounds(form, sounds) {
  SOUNDS = SOUNDS || (await api.listSounds());
  const keys = { soundTickets: "tickets", soundPrs: "prs", soundConnections: "connections", soundWorktrees: "worktrees" };
  for (const [field, key] of Object.entries(keys)) {
    const sel = form[field];
    const cur = sounds[key] || "";
    const names = cur && !SOUNDS.includes(cur) ? [...SOUNDS, cur] : SOUNDS;
    sel.innerHTML = `<option value="">None</option>` + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    sel.value = cur;
  }
  const sync = () => $("sound-picks").classList.toggle("off", !form.notifySound.checked);
  form.notifySound.onchange = sync;
  sync();
}

function openSettings() {
  const s = S.settings;
  const form = $("settings").querySelector("form");
  form.nebulaBin.value = s.nebulaBin || "";
  form.nebulaBin.placeholder = S.board.status.bin || "found on PATH";
  form.bridgePort.value = s.bridgePort;
  form.terminalCwd.value = s.terminal.cwd || "";
  form.terminalAutostart.checked = !!s.terminal.autostart;
  form.notifyTickets.checked = s.notify.tickets;
  form.notifyPrs.checked = s.notify.prs;
  form.notifyConnections.checked = s.notify.connections;
  form.notifySound.checked = s.notify.sound;
  fillSounds(form, s.notify.sounds || {});
  form.notifyWhenFocused.checked = s.notify.whenFocused;
  form.notifyPrsLinkedOnly.checked = !!s.notify.prsLinkedOnly;
  form.prPollSeconds.value = s.prPollSeconds;
  const pr = s.prs || {};
  form.prProvider.value = pr.provider || "gh";
  form.prSource.value = pr.source || "";
  form.prModel.value = pr.model || "";
  form.prMcpServers.value = pr.mcpServers || "";
  form.prQuery.value = pr.query || "";
  form.prRefreshMinutes.value = pr.refreshMinutes || 10;
  syncPrProviderFields();
  $("settings").showModal();
  renderConnections();
  renderGithub();
}

// ---------------------------------------------------------------- connections

/** What each kind asks for, and where its token comes from. */
const CONN_KINDS = {
  jira: {
    title: "Jira",
    help: 'Tickets assigned to you, straight from Jira Cloud\'s REST API. Make a token at <a data-href="https://id.atlassian.com/manage-profile/security/api-tokens">id.atlassian.com → API tokens</a> → <b>Create API token</b> (the classic one, not "with scopes").',
    account: "Email",
    token: "API token",
  },
  bitbucket: {
    title: "Bitbucket",
    help: 'Pull-request news for the activity feed: merged, declined, approved, comments, review requests. Use an <a data-href="https://id.atlassian.com/manage-profile/security/api-tokens">Atlassian API token with scopes</a> (app Bitbucket, read on account, workspace, repositories and pull requests) with your Atlassian email — or a legacy app password with your Bitbucket username.',
    account: "Email or username",
    token: "API token / app password",
  },
  agent: {
    title: "Other tracker",
    help: "Any tracker your Claude Code or Codex already reaches through an MCP server — Linear, Asana, Trello, ClickUp, monday.com, GitHub Issues, Jira too. No token here: the agent holds the sign-in (<code>claude mcp add …</code>, then <code>/mcp</code> to log in). Each refresh is one short read-only model turn.",
  },
  fake: { title: "Demo", help: "Built-in demo tickets, no token." },
};

const CE = { kind: "jira", id: null, removeArmed: false };

/** One Settings-style row for connection `c`; `data-edit` is its index in `S.connConfig`. */
function connRow(c, i) {
  const health = new Map(S.board.connections.map((h) => [h.id, h]));
  const h = health.get(c.id);
  const needsToken = c.kind === "jira" || c.kind === "bitbucket";
  let line;
  let cls = "";
  if (needsToken && !c.hasToken && !c.envOverride) {
    line = "no token yet";
    cls = "warn";
  } else if (h && h.health === "error") {
    line = h.detail || "last sync failed";
    cls = "err";
  } else {
    const where = c.kind === "jira" ? c.base_url : c.kind === "bitbucket" ? c.account : c.kind === "agent" ? `${c.source || "any tracker"} via ${c.harness || "claude"}` : "";
    const tok = c.envOverride ? `token from ${c.envName}` : c.hasToken ? `token ${c.tokenHint}` : "";
    line = [where, tok, h ? h.health : ""].filter(Boolean).join(" · ");
  }
  const dot = h ? `health-${h.health}` : needsToken && !c.hasToken ? "health-configured" : "";
  return `<div class="conn-row"><span class="dot ${esc(dot)}"></span><div class="meta"><span>${esc(c.label || c.id)} <span class="sub">${esc((CONN_KINDS[c.kind] || {}).title || c.kind)}</span></span><small class="${cls}" title="${esc(line)}">${esc(line)}</small></div><button type="button" class="btn" data-edit="${i}">Edit</button></div>`;
}

async function renderConnections() {
  const el = $("conn-list");
  const r = await api.listConnections();
  if (!r.ok) {
    el.innerHTML = `<div class="conn-row"><div class="meta"><small class="err">${esc(r.error)}</small></div></div>`;
    return;
  }
  S.connConfig = r.connections;
  el.innerHTML = r.connections.map((c, i) => connRow(c, i)).join("");
  el.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => openConnEditor(S.connConfig[+b.dataset.edit])));
  const auto = S.board.connections.filter((c) => String(c.id).startsWith("auto-"));
  $("conn-discovery").innerHTML = r.connections.length
    ? "With any connection here, NebulaX stops auto-finding the trackers your agent is connected to — add those as <b>Other tracker</b> to keep them."
    : `Nothing added yet, so NebulaX auto-finds trackers your Claude or Codex is connected to${auto.length ? ` — found: ${auto.map((c) => esc(c.label || c.id)).join(", ")}` : ""}. Adding one here turns that off.`;
}

async function renderGithub() {
  const st = $("gh-status");
  const btn = $("gh-login");
  const r = await api.githubStatus();
  st.className = "";
  if (!r.installed) {
    st.textContent = "gh not installed — brew install gh";
    st.className = "warn";
    btn.hidden = true;
  } else if (r.loggedIn) {
    st.textContent = `signed in as ${r.account} · PRs, checks and issues use it`;
    btn.hidden = false;
    btn.textContent = "Switch account";
  } else {
    st.textContent = "not signed in";
    st.className = "warn";
    btn.hidden = false;
    btn.textContent = "Sign in";
  }
}

function openConnEditor(conn, kind) {
  const form = $("ce-form");
  form.reset();
  CE.kind = conn ? conn.kind : kind;
  CE.id = conn ? conn.id : null;
  CE.removeArmed = false;
  const k = CONN_KINDS[CE.kind] || CONN_KINDS.jira;
  $("ce-title").textContent = conn ? `${conn.label || conn.id}` : `Add ${k.title}`;
  $("ce-help").innerHTML = k.help;
  $("ce-help").querySelectorAll("a[data-href]").forEach((a) => (a.onclick = () => api.openExternal(a.dataset.href)));
  if (k.account) $("ce-account-label").textContent = k.account;
  if (k.token) $("ce-token-label").textContent = k.token;
  form.querySelectorAll("[data-kind]").forEach((el) => (el.hidden = !el.dataset.kind.split(" ").includes(CE.kind)));
  const c = conn || {};
  form.label.value = c.label || "";
  form.label.placeholder = conn ? c.id : k.title === "Other tracker" ? "Linear" : `Work ${k.title}`;
  form.base_url.value = c.base_url || "";
  form.account.value = c.account || "";
  form.jql.value = c.jql || "";
  form.repos.value = (c.repos || []).join(", ");
  form.harness.value = c.harness === "codex" ? "codex" : "claude";
  form.source.value = c.source || "";
  form.mcp_servers.value = (c.mcp_servers || []).join(", ");
  form.query.value = c.query || "";
  form.repo.value = c.repo || "";
  form.token.type = "password";
  $("ce-reveal").textContent = "Show";
  form.token.placeholder = c.hasToken ? `saved (${c.tokenHint}) — leave empty to keep` : "paste the token";
  $("ce-token-note").textContent = c.envOverride ? `${c.envName} is set in the environment and wins over the saved token.` : "";
  $("ce-remove").hidden = !conn;
  $("ce-remove").textContent = "Remove";
  setCeResult("");
  $("conn-edit").showModal();
}

function ceConnection() {
  const form = $("ce-form");
  return {
    id: CE.id,
    kind: CE.kind,
    label: form.label.value.trim() || form.label.placeholder,
    base_url: form.base_url.value,
    account: form.account.value,
    jql: form.jql.value,
    repos: form.repos.value,
    harness: form.harness.value,
    source: form.source.value,
    mcp_servers: form.mcp_servers.value,
    query: form.query.value,
    repo: form.repo.value,
  };
}

function setCeResult(text, ok) {
  const el = $("ce-result");
  el.textContent = text;
  el.className = `ce-result ${text ? (ok ? "ok" : "err") : ""}`;
}

async function ceTest() {
  setCeResult("Testing…", true);
  const r = await api.testConnection(ceConnection(), $("ce-form").token.value);
  setCeResult(r.ok ? `✓ Logged in as ${r.who}` : r.error, r.ok);
}

async function ceSave() {
  const conn = ceConnection();
  const form = $("ce-form");
  if (conn.kind === "jira" && !/^https?:\/\/\S+/.test(conn.base_url.trim())) return setCeResult("Site URL must start with https://");
  if ((conn.kind === "jira" || conn.kind === "bitbucket") && !conn.account.trim()) return setCeResult(`${CONN_KINDS[conn.kind].account} is empty.`);
  if (conn.kind === "agent" && !conn.source.trim() && !conn.mcp_servers.trim()) return setCeResult("Name the tracker (or its MCP server).");
  const r = await api.saveConnection(conn, form.token.value);
  if (!r.ok) return setCeResult(r.error);
  $("conn-edit").close();
  WZ.added = true;
  refreshConnections();
}

async function ceRemove() {
  if (!CE.removeArmed) {
    CE.removeArmed = true;
    $("ce-remove").textContent = "Click again to remove";
    return;
  }
  const r = await api.removeConnection(CE.id);
  if (!r.ok) return setCeResult(r.error);
  $("conn-edit").close();
  refreshConnections();
}

/** After an add, edit or remove: the Settings list and, if open, the guide. */
function refreshConnections() {
  renderConnections();
  if ($("welcome").open) renderWelcome();
}

// ---------------------------------------------------------------- getting started

// First-run guide: connect a tracker, then a code host. Each "connect" opens
// the same connection editor Settings uses, on top of the guide, so the
// token, test and save paths are the one set. Shown once — closing it any
// way counts — and reopened from Settings → Getting started.

const WZ_STEPS = ["Welcome", "Tickets", "Pull requests", "Done"];
const WZ = { step: 0, added: false };
const TRACKER_KINDS = ["jira", "agent", "fake"];

function openWelcome() {
  WZ.step = 0;
  WZ.added = false;
  renderWelcome();
  if (!$("welcome").open) $("welcome").showModal();
}

function wzGo(step) {
  WZ.step = Math.max(0, Math.min(WZ_STEPS.length - 1, step));
  renderWelcome();
}

function wzChoice(kind, ic, title, body) {
  return `<button type="button" class="wz-choice" data-wz-add="${kind}">${icon(ic)}<span><b>${esc(title)}</b><small>${body}</small></span></button>`;
}

/** Paint the step at once from the last-known list, then again once the fresh one lands. */
async function renderWelcome() {
  const step = WZ.step;
  paintWelcome({ ok: true, connections: S.connConfig || [] });
  const r = await api.listConnections();
  if (step !== WZ.step) return; // moved on while listing
  if (r.ok) S.connConfig = r.connections;
  paintWelcome(r.ok ? r : { ...r, connections: S.connConfig || [] });
}

function paintWelcome(r) {
  const step = WZ.step;
  $("wz-steps").innerHTML = WZ_STEPS.map((name, i) => `<li class="${i < step ? "done" : i === step ? "on" : ""}"><span>${i < step ? icon("check") : i + 1}</span>${esc(name)}</li>`).join("");
  const conns = r.connections;
  const rows = (keep) => {
    const html = conns.map((c, i) => (keep(c) ? connRow(c, i) : "")).join("");
    return html ? `<div class="conn-list">${html}</div>` : "";
  };
  const trackers = conns.filter((c) => TRACKER_KINDS.includes(c.kind));
  const hosts = conns.filter((c) => c.kind === "bitbucket");
  const body = $("wz-body");

  if (step === 0) {
    body.innerHTML = `
      <h2>Welcome to Glide Deck</h2>
      <p class="sub">Two short steps connect the tools NebulaX reads, so your tickets and pull requests show up here.</p>
      <ul class="wz-points">
        <li>${icon("ticket")}<span><b>Your tickets</b><small>From Jira, or any tracker your Claude Code or Codex already reaches — Linear, Asana, Trello, GitHub Issues…</small></span></li>
        <li>${icon("pr")}<span><b>Your pull requests</b><small>From Bitbucket, or GitHub through the <code>gh</code> CLI.</small></span></li>
        <li>${icon("plug")}<span><b>Tokens stay on this Mac</b><small>In NebulaX's <code>config.local.json</code> — never exported or sent over <code>nebula ssh</code>.</small></span></li>
      </ul>
      ${
        conns.length
          ? `<div class="banner ok wz-ready">${icon("check")}<span>Already configured — ${conns.length} connection${conns.length === 1 ? "" : "s"} set up. You can skip the steps.</span><span class="spacer"></span><button type="button" class="btn" id="wz-configured">Skip to summary</button></div>`
          : ""
      }
      ${r.ok ? "" : `<div class="banner err">${esc(r.error)}</div>`}`;
  } else if (step === 1) {
    body.innerHTML = `
      <h2>Where do your tickets live?</h2>
      <p class="sub">Pick one — you can add more later in Settings → Connections.</p>
      <div class="wz-choices">
        ${wzChoice("jira", "ticket", "Jira", "Jira Cloud with an API token — you'll need your site URL and email.")}
        ${wzChoice("agent", "plug", "Other tracker", "Linear, Asana, ClickUp, GitHub Issues… through your agent's MCP servers. No token here.")}
        ${wzChoice("fake", "play", "Demo tickets", "Try the board with built-in sample tickets, no account.")}
      </div>
      ${rows((c) => TRACKER_KINDS.includes(c.kind))}`;
  } else if (step === 2) {
    body.innerHTML = `
      <h2>Where do your pull requests live?</h2>
      <p class="sub">Glide Deck turns PR news — reviews, approvals, checks, merges — into notifications.</p>
      <div class="wz-choices">
        ${wzChoice("bitbucket", "pr", "Bitbucket", "Bitbucket Cloud with an Atlassian API token (or a legacy app password).")}
      </div>
      ${rows((c) => c.kind === "bitbucket")}
      <div class="conn-row">
        <div class="meta"><span>GitHub <span class="sub">gh CLI</span></span><small id="wz-gh">checking…</small></div>
        <button type="button" class="btn" id="wz-gh-login" hidden>Sign in</button>
      </div>`;
    wzGithub();
  } else {
    const none = !trackers.length && !hosts.length;
    body.innerHTML = `
      <h2>${none ? "You can connect later" : "You're set"}</h2>
      <p class="sub">${
        none
          ? "Nothing is connected yet. Add a tracker or code host any time in Settings → Connections."
          : "NebulaX syncs these in the background. Change them any time in Settings → Connections."
      }</p>
      ${rows(() => true)}
      <div class="conn-row"><div class="meta"><span>GitHub <span class="sub">gh CLI</span></span><small id="wz-gh">checking…</small></div></div>`;
    wzGithub();
  }

  const skip = $("wz-configured");
  if (skip) skip.onclick = () => wzGo(WZ_STEPS.length - 1);
  body.querySelectorAll("[data-wz-add]").forEach((b) => (b.onclick = () => openConnEditor(null, b.dataset.wzAdd)));
  body.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => openConnEditor(S.connConfig[+b.dataset.edit])));
  const here = step === 1 ? trackers.length : step === 2 ? hosts.length : 1;
  $("wz-back").hidden = step === 0;
  $("wz-skip").hidden = step === WZ_STEPS.length - 1;
  $("wz-next").textContent = step === 0 ? "Get started" : step === WZ_STEPS.length - 1 ? "Finish" : here ? "Next" : "Skip this step";
}

async function wzGithub() {
  const r = await api.githubStatus();
  const st = $("wz-gh");
  if (!st) return;
  const btn = $("wz-gh-login");
  st.className = r.loggedIn ? "" : "warn";
  st.textContent = !r.installed ? "gh not installed — brew install gh" : r.loggedIn ? `signed in as ${r.account}` : "not signed in";
  // A signed-in gh already covers the pull-request step.
  if (r.loggedIn && WZ.step === 2) $("wz-next").textContent = "Next";
  if (btn) {
    btn.hidden = !r.installed || r.loggedIn;
    btn.onclick = async () => {
      // Sign-in runs in the Terminal view, which the guide would cover.
      const res = await api.githubLogin();
      if (res && res.ok) $("welcome").close();
      else st.textContent = (res && res.error) || "could not open the terminal";
    };
  }
}

function finishWelcome() {
  $("welcome").close();
  if (!WZ.added) return;
  api.resyncTickets();
  go(S.connConfig.some((c) => TRACKER_KINDS.includes(c.kind)) ? "tickets" : "overview");
}

/** First launch: show the guide unless connections were set up another way. */
async function maybeWelcome() {
  if (S.settings.onboarded) return;
  const r = await api.listConnections();
  if (r.ok && r.connections.length) api.setSettings({ onboarded: true });
  else openWelcome();
}

/** Show only the fields the chosen PR provider uses. */
function syncPrProviderFields() {
  const form = $("settings").querySelector("form");
  const provider = form.prProvider.value;
  form.querySelectorAll("[data-pr-provider]").forEach((el) => {
    const want = el.dataset.prProvider;
    el.hidden = !(want === provider || (want === "agent" && provider !== "gh"));
  });
  form.prModel.placeholder = provider === "codex" ? "Codex's default" : "haiku";
}

async function saveSettings() {
  const form = $("settings").querySelector("form");
  const port = parseInt(form.bridgePort.value, 10);
  const poll = parseInt(form.prPollSeconds.value, 10);
  const refresh = parseInt(form.prRefreshMinutes.value, 10);
  S.settings = await api.setSettings({
    nebulaBin: form.nebulaBin.value.trim(),
    bridgePort: port >= 1024 && port <= 65535 ? port : S.settings.bridgePort,
    prPollSeconds: poll >= 15 ? poll : S.settings.prPollSeconds,
    prs: {
      provider: form.prProvider.value,
      source: form.prSource.value.trim(),
      model: form.prModel.value.trim(),
      mcpServers: form.prMcpServers.value.trim(),
      query: form.prQuery.value.trim(),
      refreshMinutes: refresh >= 2 ? refresh : S.settings.prs.refreshMinutes,
    },
    terminal: { cwd: form.terminalCwd.value.trim(), autostart: form.terminalAutostart.checked },
    notify: {
      tickets: form.notifyTickets.checked,
      prs: form.notifyPrs.checked,
      prsLinkedOnly: form.notifyPrsLinkedOnly.checked,
      connections: form.notifyConnections.checked,
      sound: form.notifySound.checked,
      sounds: {
        tickets: form.soundTickets.value,
        prs: form.soundPrs.value,
        connections: form.soundConnections.value,
        worktrees: form.soundWorktrees.value,
      },
      whenFocused: form.notifyWhenFocused.checked,
    },
  });
}

// ---------------------------------------------------------------- wiring

async function init() {
  hydrateIcons();
  const st = await api.getState();
  S.board = st.board;
  S.prs = st.prs;
  S.activity = st.activity;
  S.unread = st.unread;
  S.settings = st.settings;
  if (st.rotate) S.rotate = st.rotate;
  S.worktrees = (st.worktrees && st.worktrees.worktrees) || [];
  S.wtProjects = (st.worktrees && st.worktrees.projects) || [];
  S.notes = st.notes || [];

  document.querySelectorAll(".nav-item[data-view]").forEach((b) => (b.onclick = () => go(b.dataset.view)));
  window.addEventListener("resize", moveGlider);
  document.querySelectorAll("[data-goto]").forEach((b) => (b.onclick = () => go(b.dataset.goto)));
  $("open-settings").onclick = openSettings;
  $("theme-toggle").onclick = cycleTheme;
  $("conn").onclick = () => api.reconnect();
  // Resync skips the daemon's caches; an agent listing turn can take half a
  // minute, so the button reads "Syncing…" until tickets arrive (or 45s).
  $("tk-resync").onclick = async () => {
    const b = $("tk-resync");
    if (b.disabled) return;
    b.disabled = true;
    b.textContent = "Syncing…";
    const done = () => {
      clearTimeout(timer);
      off();
      b.disabled = false;
      b.textContent = "Resync";
    };
    const lastSync = (board) => Math.max(0, ...board.connections.map((c) => c.last_sync_ms || 0));
    const before = lastSync(S.board);
    const timer = setTimeout(done, 45_000);
    // Only a push carrying a newer sync time ends it; routine board pushes
    // that arrive meanwhile are not the resync's answer.
    const off = api.onBoard((board) => {
      if (lastSync(board) > before) setTimeout(done, 300);
    });
    const sent = await api.resyncTickets();
    if (sent === false) return done();
  };
  $("tk-search").oninput = (e) => {
    S.search = e.target.value;
    renderTickets();
  };
  $("save-settings").onclick = () => saveSettings();
  $("test-notify").onclick = () => api.testNotification();
  const sform = $("settings").querySelector("form");
  sform.querySelectorAll("[data-preview]").forEach((b) => (b.onclick = () => api.playSound(sform[b.dataset.preview].value)));
  sform.querySelectorAll("[data-sound]").forEach((sel) => (sel.onchange = () => api.playSound(sel.value)));
  $("open-welcome").onclick = () => {
    $("settings").close();
    openWelcome();
  };
  $("wz-next").onclick = () => (WZ.step === WZ_STEPS.length - 1 ? finishWelcome() : wzGo(WZ.step + 1));
  $("wz-back").onclick = () => wzGo(WZ.step - 1);
  $("wz-skip").onclick = () => $("welcome").close();
  // However it closes (Finish, Skip, Esc, GitHub sign-in), it has been seen.
  $("welcome").addEventListener("close", () => {
    if (!S.settings.onboarded) api.setSettings({ onboarded: true }).then((v) => (S.settings = v));
  });
  $("settings").querySelector("select[name=prProvider]").onchange = syncPrProviderFields;
  document.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => openConnEditor(null, b.dataset.add)));
  $("gh-login").onclick = async () => {
    const r = await api.githubLogin();
    if (r && r.ok) $("settings").close();
    else $("gh-status").textContent = (r && r.error) || "could not open the terminal";
  };
  $("ce-test").onclick = ceTest;
  $("ce-save").onclick = ceSave;
  $("ce-remove").onclick = ceRemove;
  $("ce-reveal").onclick = () => {
    const t = $("ce-form").token;
    t.type = t.type === "password" ? "text" : "password";
    $("ce-reveal").textContent = t.type === "password" ? "Show" : "Hide";
  };
  $("ce-form").addEventListener("submit", (e) => {
    // Enter in a field saves rather than closing the dialog unsaved.
    if (e.submitter && e.submitter.value === "cancel") return;
    e.preventDefault();
    ceSave();
  });
  $("wt-search").oninput = (e) => {
    S.wtSearch = e.target.value;
    renderWorktrees();
  };
  $("wt-all").onchange = (e) => {
    for (const w of visibleWorktrees()) {
      if (S.wtBusy.has(w.id)) continue;
      if (e.target.checked) S.wtChecked.add(w.id);
      else S.wtChecked.delete(w.id);
    }
    renderWorktrees();
  };
  $("wt-delete").onclick = confirmDeleteWorktrees;
  for (const id of ["rot-on", "rot-n", "rot-unit", "rot-basis"]) $(id).onchange = saveRotate;
  $("rot-run").onclick = () => api.rotateWorktrees();
  $("nt-search").oninput = (e) => {
    S.ntSearch = e.target.value;
    renderNoteList();
  };
  $("pj-search").oninput = (e) => {
    S.pjSearch = e.target.value;
    renderProjects();
  };
  $("pjc-cancel").onclick = () => $("pj-confirm").close();
  $("wtc-cancel").onclick = () => $("wt-confirm").close();
  $("ch-close").onclick = () => $("changes").close();
  $("changes").addEventListener("close", () => (chView = null));
  $("ch-where").onclick = (e) => {
    if (e.target.id === "ch-open-pr" && chView && chView.pr) api.openExternal(chView.pr.url);
  };
  $("changes").onclick = (e) => {
    if (e.target.id === "changes") $("changes").close();
  };

  api.onBoard((b) => {
    S.board = { ...S.board, ...b };
    renderView();
  });
  api.onBridgeStatus((s) => {
    S.board.status = s;
    renderView();
  });
  api.onPrs((p) => {
    S.prs = p;
    renderView();
  });
  api.onActivity((e) => {
    S.activity.unshift(e);
    // main keeps the same 300 (ACTIVITY_CAP in settings.js)
    if (S.activity.length > ACTIVITY_CAP) S.activity.length = ACTIVITY_CAP;
    if (S.view === "activity") S.unreadShown++;
    renderView();
  });
  api.onUnread((n) => {
    S.unread = n;
    // Watching the feed as it arrives counts as reading it.
    if (S.view === "activity" && n && document.hasFocus()) api.markActivityRead();
    renderNav();
  });
  api.onSettings((s) => (S.settings = s));
  api.onChanges(onChanges);
  api.onWorktrees((w) => {
    S.worktrees = w.worktrees;
    S.wtProjects = w.projects;
    renderNav();
    if (S.view === "worktrees") renderWorktrees();
    if (S.view === "projects" || S.view === "notes") renderView();
  });
  api.onWorktreeProgress(onWorktreeProgress);
  api.onRotateStatus(onRotateStatus);
  api.onNav(goTarget);
  api.onFocus(() => {
    if (S.view === "activity" && S.unread) api.markActivityRead();
  });

  if (st.terminalRunning) hub.running = true;
  if (st.shellRunning) shellPane.running = true;
  hub.renderNav();
  shellPane.renderNav();
  go("overview");
  maybeWelcome();
  // Relative times drift; repaint them every half minute.
  setInterval(() => {
    if (!PANES[S.view] && document.visibilityState === "visible") renderView();
  }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !PANES[S.view]) renderView();
  });
}

init();
