// The window: overview, tickets, pull requests, activity and the NebulaX
// terminal. Everything it shows arrives from the main process over the
// preload's `window.nebula` API; the page itself holds only view state.

const { STEPS, progressOf, needsYou, tally } = window.NebulaProgress;
const api = window.nebula;

const S = {
  view: "overview",
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

/** Ticket ↔ PR links, by Jira-style keys in a PR's title or branch. */
function links() {
  const byKey = new Map(S.board.tickets.map((t) => [(t.key || "").toUpperCase(), t]));
  const prsByTicket = new Map();
  const ticketsByPr = new Map();
  for (const pr of S.prs.prs) {
    const found = new Set(`${pr.title} ${pr.headRef}`.toUpperCase().match(/[A-Z][A-Z0-9]+-\d+/g) || []);
    const hits = [...found].map((k) => byKey.get(k)).filter(Boolean);
    if (!hits.length) continue;
    ticketsByPr.set(pr.url, hits);
    for (const t of hits) {
      const k = tkey(t.id);
      if (!prsByTicket.has(k)) prsByTicket.set(k, []);
      prsByTicket.get(k).push(pr);
    }
  }
  return { prsByTicket, ticketsByPr };
}

function prNeedsYou(pr) {
  if (pr.state !== "OPEN") return false;
  if (pr.bucket === "review") return true;
  return pr.reviewDecision === "CHANGES_REQUESTED" || pr.checks === "FAILURE" || pr.checks === "ERROR";
}

const TONE_PILL = { ok: "ok", warn: "warn", err: "err", active: "active", idle: "" };

// ---------------------------------------------------------------- nav

const TITLES = { overview: "Overview", tickets: "Tickets", prs: "Pull requests", activity: "Activity", terminal: "Terminal" };

function go(view, opts = {}) {
  if (!TITLES[view]) return;
  if (view === "activity" && S.view !== "activity") {
    S.unreadShown = S.unread;
    if (S.unread) api.markActivityRead();
  }
  S.view = view;
  if (opts.filter) S.filter = opts.filter;
  if (opts.ticket) S.selected = opts.ticket;
  document.querySelectorAll(".nav-item[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.id === `view-${view}`));
  $("view-title").textContent = TITLES[view];
  renderView();
  if (view === "terminal") ensureTerminal();
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
  }
}

function renderNav() {
  const live = liveTickets();
  $("nav-tickets").textContent = live.length || "";
  $("nav-prs").textContent = S.prs.prs.filter((p) => p.state === "OPEN").length || "";
  $("nav-activity").textContent = S.unread || "";
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
      sub.textContent = S.prs.lastPoll ? `checked ${rel(S.prs.lastPoll)}` : "checking…";
      btn("Refresh", "refresh", () => api.refreshPrs());
      break;
    case "activity":
      btn("Clear", "", async () => {
        await api.clearActivity();
        S.activity = [];
        renderActivity();
      });
      break;
    case "terminal":
      sub.textContent = termState.running ? "nebula is running" : termState.started ? "exited" : "";
      btn("Restart", "refresh", () => restartTerminal());
      btn("Open in Terminal.app", "external", async () => {
        const r = await api.terminal.openExternal();
        if (r && !r.ok) $("view-sub").textContent = r.error;
      });
      break;
  }
}

// ---------------------------------------------------------------- overview

const SEGMENTS = [
  ["done", "Done"],
  ["pr", "PR open"],
  ["ready", "Ready"],
  ["active", "In progress"],
  ["attention", "Needs you"],
  ["queued", "Queued"],
  ["todo", "To do"],
];

function renderOverview() {
  const tickets = liveTickets();
  const { buckets, total } = tally(tickets);
  $("ov-done").textContent = buckets.done;
  $("ov-total").textContent = total;
  $("ov-pct").textContent = total ? `${Math.round((buckets.done / total) * 100)}%` : "—";
  $("ov-stack").innerHTML = total
    ? SEGMENTS.filter(([k]) => buckets[k]).map(([k, l]) => `<span class="seg-${k}" style="flex-grow:${buckets[k]}" title="${l}: ${buckets[k]}"></span>`).join("")
    : "";
  $("ov-legend").innerHTML = SEGMENTS.map(([k, l]) => `<span><i class="seg-${k}"></i>${l} <b>${buckets[k]}</b></span>`).join("");

  const prs = S.prs.prs;
  const needTickets = tickets.filter((t) => needsYou(t) || progressOf(t).tone === "err");
  const needPrs = prs.filter(prNeedsYou);
  const tiles = [
    ["gold", buckets.active + buckets.queued, "In progress", () => go("tickets", { filter: "active" })],
    ["err", needTickets.length + needPrs.length, "Needs you", () => go("tickets", { filter: "needs" })],
    ["blue", buckets.ready, "Ready to ship", () => go("tickets", { filter: "review" })],
    ["violet", prs.filter((p) => p.state === "OPEN" && p.bucket === "mine").length, "Your open PRs", () => go("prs")],
    ["warn", prs.filter((p) => p.bucket === "review").length, "Reviews for you", () => go("prs")],
  ];
  const tilesEl = $("ov-tiles");
  tilesEl.innerHTML = "";
  for (const [tone, n, label, fn] of tiles) {
    const b = document.createElement("button");
    b.className = `tile ${n ? tone : ""}`;
    b.innerHTML = `<div class="n">${n}</div><div class="l">${esc(label)}</div>`;
    b.onclick = fn;
    tilesEl.appendChild(b);
  }

  // Needs you: tickets first, then PRs.
  const needs = $("ov-needs");
  needs.innerHTML = "";
  $("ov-needs-count").textContent = needTickets.length + needPrs.length ? `${needTickets.length + needPrs.length}` : "";
  for (const t of needTickets) {
    const p = progressOf(t);
    needs.appendChild(
      miniEl({
        icon: "ticket",
        cls: p.tone === "err" ? "lv-error" : "lv-warn",
        title: `${t.key} · ${p.label}`,
        body: t.summary,
        when: rel(t.updated_at),
        onclick: () => go("tickets", { ticket: tkey(t.id), filter: "all" }),
      }),
    );
  }
  for (const pr of needPrs) {
    const why =
      pr.bucket === "review" ? "review requested" : pr.reviewDecision === "CHANGES_REQUESTED" ? "changes requested" : "checks failing";
    needs.appendChild(
      miniEl({
        icon: "pr",
        cls: pr.bucket === "review" ? "lv-warn" : "lv-error",
        title: `${pr.repo}#${pr.number} · ${why}`,
        body: pr.title,
        when: rel(pr.updatedAt),
        onclick: () => go("prs", { pr: pr.url }),
      }),
    );
  }
  if (!needs.children.length) needs.innerHTML = `<div class="empty">${icon("check")}Nothing is waiting on you.</div>`;

  const act = $("ov-activity");
  act.innerHTML = "";
  for (const e of S.activity.slice(0, 7)) {
    act.appendChild(
      miniEl({ icon: e.category === "prs" ? "pr" : e.category === "connections" ? "plug" : "ticket", cls: `lv-${e.level}`, title: e.title, body: e.body, when: rel(e.ts), onclick: () => goTarget(e.target) }),
    );
  }
  if (!act.children.length) act.innerHTML = `<div class="empty">${icon("bell")}Updates will appear here as they happen.</div>`;

  const conns = $("ov-conns");
  if (!S.board.connections.length) {
    conns.innerHTML = `<div class="sub">${
      S.board.status.state === "connected"
        ? "No tracker connection yet — add one to NebulaX's config.json (see docs/jira-tickets.md)."
        : esc(S.board.status.detail || "Waiting for NebulaX…")
    }</div>`;
  } else {
    conns.innerHTML = S.board.connections
      .map(
        (c) => `<div class="conn-card"><span class="dot health-${esc(c.health)}"></span><div class="meta"><span>${esc(c.label || c.id)} <span class="sub">${esc(c.kind)}</span></span><small>${esc(c.health)}${c.last_sync_ms ? ` · synced ${rel(c.last_sync_ms)}` : ""}${c.detail ? ` · ${esc(c.detail)}` : ""}</small></div></div>`,
      )
      .join("");
  }
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
    el.innerHTML = `
      <div class="key">${esc(t.key || t.id.native)}</div>
      <div class="summary">${esc(t.summary)}</div>
      <span class="pill ${TONE_PILL[p.tone]}">${esc(p.label)}</span>
      <div class="meta">${meta.join('<span class="sub">·</span>')}</div>
      <div class="steps-wrap">${stepsHtml(p)}</div>`;
    el.onclick = () => {
      S.selected = k;
      renderTickets();
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
    return;
  }
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
  if (t.workflow) addBtn(actions, "View changes", "diff", () => openChanges(t));
  pane.querySelectorAll("[data-pr]").forEach((el) => (el.onclick = () => go("prs", { pr: el.dataset.pr })));
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
    root.innerHTML = `<div class="empty big">${icon("pr")}Asking GitHub for your pull requests…</div>`;
    return;
  }
  for (const [bucket, title, empty] of PR_GROUPS) {
    const list = S.prs.prs.filter((p) => p.bucket === bucket);
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
  el.innerHTML = `
    <span class="${prStateClass(pr)}">${icon(prStateIcon(pr))}</span>
    <div class="title">${esc(pr.title)}</div>
    <div class="right">${ticketChips}${review}${checks}${pr.comments ? `<span class="cmt">${icon("comment")}${pr.comments}</span>` : ""}</div>
    <div class="meta">
      <span class="num">${esc(pr.repo)}#${pr.number}</span>
      ${pr.draft ? `<span class="pill">draft</span>` : ""}
      ${pr.bucket === "review" ? `<span>by ${esc(pr.author)}</span>` : ""}
      <span>${pr.state === "MERGED" ? `merged ${rel(pr.mergedAt)}` : `updated ${rel(pr.updatedAt)}`}</span>
      <span class="diffstat"><span class="a">+${pr.additions}</span> <span class="d">−${pr.deletions}</span></span>
    </div>`;
  el.onclick = (e) => {
    const chip = e.target.closest("[data-ticket]");
    if (chip) {
      e.stopPropagation();
      go("tickets", { ticket: chip.dataset.ticket, filter: "all" });
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
    const ic = e.category === "prs" ? "pr" : e.category === "connections" ? "plug" : "ticket";
    el.innerHTML = `
      <span class="lv-${esc(e.level)}">${icon(ic)}</span>
      <div class="t">${esc(e.title)}<span class="cat">${esc({ prs: "pull request", tickets: "ticket", connections: "connection" }[e.category] || "")}</span></div>
      <span class="when" title="${esc(new Date(e.ts).toLocaleString())}">${rel(e.ts)}</span>
      ${e.body ? `<div class="b">${esc(e.body)}</div>` : ""}`;
    el.onclick = () => goTarget(e.target);
    feed.appendChild(el);
  });
}

// ---------------------------------------------------------------- changes modal

let chTicket = null;

function openChanges(t) {
  chTicket = tkey(t.id);
  $("ch-title").textContent = `${t.key || t.id.native} — changes`;
  $("ch-count").textContent = "";
  $("ch-body").innerHTML = `<div class="empty">Loading the diff…</div>`;
  $("changes").showModal();
  api.requestChanges(t.id).then((sent) => {
    if (!sent) $("ch-body").innerHTML = `<div class="empty">Not connected to NebulaX.</div>`;
  });
}

function onChanges(p) {
  if (!p || !p.ticket || tkey(p.ticket) !== chTicket) return;
  const files = parseDiff(p.diff || "");
  if (!files.length) {
    $("ch-body").innerHTML = `<div class="empty">${esc(p.note || "No changes yet.")}</div>`;
    return;
  }
  $("ch-count").textContent = `${files.length} file${files.length === 1 ? "" : "s"} changed`;
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

function renderFileDiff(files, file) {
  const body = $("ch-body");
  body.innerHTML = "";
  const back = document.createElement("span");
  back.className = "back";
  back.textContent = "‹ All files";
  back.onclick = () => renderFileList(files);
  const pre = document.createElement("pre");
  pre.className = "diff";
  pre.innerHTML = file.lines
    .map((l) => `<span class="${l[0] === "+" ? "a" : l[0] === "-" ? "d" : l.startsWith("@@") ? "h" : "m"}">${esc(l)}</span>`)
    .join("\n");
  body.append(back, pre);
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

const termState = { xterm: null, fit: null, running: false, started: false, ready: false };

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function ensureTerminal() {
  if (termState.xterm) {
    requestAnimationFrame(() => {
      termState.fit.fit();
      termState.xterm.focus();
    });
    return;
  }
  const xterm = new Terminal({
    fontFamily: '"SF Mono", "JetBrains Mono", Menlo, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    macOptionIsMeta: true,
    scrollback: 5000,
    allowTransparency: true,
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
  xterm.open($("term"));
  termState.xterm = xterm;
  termState.fit = fit;
  xterm.onData((d) => {
    if (!termState.running) {
      if (d === "\r") startTerminal();
      return;
    }
    api.terminal.write(d);
  });
  xterm.onResize(({ cols, rows }) => api.terminal.resize(cols, rows));
  new ResizeObserver(() => {
    if (S.view === "terminal") fit.fit();
  }).observe($("term"));
  requestAnimationFrame(() => {
    fit.fit();
    startTerminal();
  });
}

async function startTerminal() {
  const { xterm } = termState;
  termState.ready = false;
  const r = await api.terminal.start(xterm.cols, xterm.rows);
  termState.started = true;
  if (!r.ok) {
    termState.running = false;
    xterm.writeln(`\x1b[31m${r.error}\x1b[0m`);
    xterm.writeln("\x1b[2mFix it in Settings, then press Enter to try again.\x1b[0m");
  } else {
    termState.running = true;
    if (r.buffer) xterm.write(r.buffer);
    xterm.focus();
  }
  termState.ready = true;
  renderNavTerm();
  if (S.view === "terminal") renderTopbar();
}

async function restartTerminal() {
  if (!termState.xterm) return go("terminal");
  await api.terminal.kill();
  termState.running = false;
  termState.xterm.reset();
  startTerminal();
}

function renderNavTerm() {
  $("nav-term").textContent = termState.running ? "●" : "";
}

api.terminal.onData((d) => {
  // Until `start` answers, output is part of the replay buffer it returns.
  if (termState.xterm && termState.ready) termState.xterm.write(d);
});
api.terminal.onExit(() => {
  termState.running = false;
  renderNavTerm();
  if (termState.xterm) termState.xterm.writeln("\r\n\x1b[2m[nebula exited — press Enter to start it again]\x1b[0m");
  if (S.view === "terminal") renderTopbar();
});

// ---------------------------------------------------------------- settings

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
  form.notifyWhenFocused.checked = s.notify.whenFocused;
  form.prPollSeconds.value = s.prPollSeconds;
  $("settings").showModal();
}

async function saveSettings() {
  const form = $("settings").querySelector("form");
  const port = parseInt(form.bridgePort.value, 10);
  const poll = parseInt(form.prPollSeconds.value, 10);
  S.settings = await api.setSettings({
    nebulaBin: form.nebulaBin.value.trim(),
    bridgePort: port >= 1024 && port <= 65535 ? port : S.settings.bridgePort,
    prPollSeconds: poll >= 15 ? poll : S.settings.prPollSeconds,
    terminal: { cwd: form.terminalCwd.value.trim(), autostart: form.terminalAutostart.checked },
    notify: {
      tickets: form.notifyTickets.checked,
      prs: form.notifyPrs.checked,
      connections: form.notifyConnections.checked,
      sound: form.notifySound.checked,
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

  document.querySelectorAll(".nav-item[data-view]").forEach((b) => (b.onclick = () => go(b.dataset.view)));
  document.querySelectorAll("[data-goto]").forEach((b) => (b.onclick = () => go(b.dataset.goto)));
  $("open-settings").onclick = openSettings;
  $("conn").onclick = () => api.reconnect();
  $("tk-search").oninput = (e) => {
    S.search = e.target.value;
    renderTickets();
  };
  $("save-settings").onclick = () => saveSettings();
  $("test-notify").onclick = () => api.testNotification();
  $("ch-close").onclick = () => $("changes").close();
  $("changes").addEventListener("close", () => (chTicket = null));
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
  api.onNav(goTarget);
  api.onFocus(() => {
    if (S.view === "activity" && S.unread) api.markActivityRead();
  });

  if (st.terminalRunning) termState.running = true;
  renderNavTerm();
  go("overview");
  // Relative times drift; repaint them every half minute.
  setInterval(() => {
    if (S.view !== "terminal") renderView();
  }, 30000);
}

init();
