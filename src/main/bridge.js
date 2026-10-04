// The desktop app's line to NebulaX. It does not speak the daemon's socket
// protocol itself: it runs `nebula web --no-open` (the same JSON-over-
// WebSocket bridge) on its own port and connects
// to it, so the daemon stays the single source of truth and a protocol bump
// only ever has to be handled in Rust.
//
// Lifecycle: find `nebula` → start the bridge → if the bridge says no daemon
// is up, start `nebula daemon` detached and try again → connect → on any
// drop, reconnect with backoff.

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const WebSocket = require("ws");
const { childEnv, nebulaBin } = require("./env");
const { ticketKey, diffTicket, diffSnapshot, removedEvent, diffConnection } = require("./diff");
const { worktreeTimes } = require("./rotator");

const NO_DAEMON = /no nebula daemon is running/i;
// Only the tail of the bridge's stderr is ever read (the daemon check and the
// last line); a long-lived bridge must not keep every warning it printed.
const STDERR_CAP = 16 * 1024;
// Live inbox events kept between snapshots; the next snapshot replaces them.
const INBOX_CAP = 200;

class NebulaBridge extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.child = null;
    this.ws = null;
    this.stopping = false;
    this.retryTimer = null;
    this.daemonAttempts = 0;
    this.backoffMs = 1000;
    // Board state as last seen.
    this.tickets = new Map();
    this.connections = [];
    this.inbox = [];
    this.baselined = false;
    // The daemon's tree, for the Worktrees view: projects and checkouts by
    // id, and the sessions living in each.
    this.projects = new Map();
    this.worktrees = new Map();
    this.agents = new Map();
    // Numbered requests (worktree deletes, project adds/removes) waiting on
    // the daemon's reply.
    this.nextReq = 1;
    this.pending = new Map();
    this.status = { state: "starting", detail: "looking for nebula…" };
  }

  snapshot() {
    return {
      status: this.status,
      tickets: [...this.tickets.values()],
      connections: this.connections,
      inbox: this.inbox,
    };
  }

  /**
   * The projects open in NebulaX and every non-main checkout of each, with
   * the sessions living in it.
   */
  worktreeSnapshot() {
    const agents = [...this.agents.values()].filter((a) => !a.archived);
    const worktrees = [...this.worktrees.values()]
      .filter((w) => !w.is_main)
      .map((w) => {
        const sessions = agents.filter((a) => a.worktree_id === w.id);
        return {
          ...worktreeTimes(w.path),
          id: w.id,
          project_id: w.project_id,
          branch: w.branch,
          path: w.path,
          sessions: sessions.length,
          running: sessions.filter((a) => a.status === "running" || a.status === "needs_feedback").length,
        };
      });
    const projects = [...this.projects.values()].map((p) => {
      const mine = worktrees.filter((w) => w.project_id === p.id);
      const sessions = agents.filter((a) => {
        const w = this.worktrees.get(a.worktree_id);
        return w && w.project_id === p.id;
      });
      return {
        id: p.id,
        name: p.name,
        repo: p.repo_path,
        worktrees: mine.length,
        sessions: sessions.length,
        running: sessions.filter((a) => a.status === "running" || a.status === "needs_feedback").length,
      };
    });
    return { projects, worktrees };
  }

  /**
   * Remove one checkout through the daemon (it stops the sessions inside,
   * runs `git worktree remove` and drops the row). Resolves `{ok, error?}`.
   */
  deleteWorktree(id, force) {
    return this.request("worktrees/delete", { id, force: !!force });
  }

  /**
   * Open a git repo in NebulaX. It lands in the workspace the TUI last
   * opened, so the Working hub lists it as soon as the daemon says so.
   */
  addProject(path) {
    return this.request("projects/add", { path });
  }

  /** Close a project in NebulaX (its folder on disk is left alone). */
  removeProject(id) {
    return this.request("projects/remove", { id });
  }

  /** Send a numbered request; resolves `{ok, error?}` from the daemon's reply. */
  request(kind, payload) {
    const req_id = this.nextReq++;
    if (!this.send(kind, { req_id, ...payload })) {
      return Promise.resolve({ ok: false, error: "not connected to NebulaX" });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        resolve({ ok: false, error: "NebulaX did not answer" });
      }, 120000);
      this.pending.set(req_id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
  }

  settle(req_id, result) {
    const done = this.pending.get(req_id);
    if (!done) return;
    this.pending.delete(req_id);
    done(result);
  }

  settleAll(error) {
    for (const id of [...this.pending.keys()]) this.settle(id, { ok: false, error });
  }

  setStatus(state, detail = "") {
    this.status = { state, detail, bin: this.bin || null, port: this.port };
    this.emit("status", this.status);
  }

  start() {
    this.stopping = false;
    this.bin = nebulaBin(this.settings.get().nebulaBin);
    this.port = this.settings.get().bridgePort;
    if (!this.bin) {
      this.setStatus("error", "`nebula` was not found on your PATH — set its location in Settings.");
      return;
    }
    this.spawnWeb();
  }

  /** Tear everything down and start again (settings changed, user asked). */
  restart() {
    this.stop();
    this.daemonAttempts = 0;
    this.backoffMs = 1000;
    this.start();
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.retryTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      // A socket still handshaking emits 'error' after terminate(); with no
      // listener that would throw in the main process.
      this.ws.on("error", () => {});
      this.ws.terminate();
      this.ws = null;
    }
    this.settleAll("lost the connection to NebulaX");
    if (this.child) {
      this.child.removeAllListeners();
      this.child.kill();
      this.child = null;
    }
  }

  retry(fn, ms) {
    if (this.stopping) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(fn, ms);
  }

  spawnWeb() {
    if (this.stopping) return;
    this.setStatus("starting", "starting the NebulaX bridge…");
    let stderr = "";
    let connected = false;
    const child = spawn(this.bin, ["web", "--no-open", "--port", String(this.port)], {
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    const onOut = (buf) => {
      const text = buf.toString();
      // "nebula web bridge on ws://…" (older builds: "nebula web dashboard on http://…")
      if (!connected && /(bridge|dashboard) (on|already running)/.test(text)) {
        connected = true;
        this.connect();
      }
    };
    child.stdout.on("data", onOut);
    child.stderr.on("data", (b) => {
      stderr += b.toString();
      if (stderr.length > STDERR_CAP) stderr = stderr.slice(-STDERR_CAP);
    });
    child.on("error", (err) => {
      this.setStatus("error", `could not run ${this.bin}: ${err.message}`);
      this.retry(() => this.spawnWeb(), 10000);
    });
    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      if (NO_DAEMON.test(stderr)) {
        if (this.daemonAttempts++ < 3) {
          this.startDaemon();
          this.retry(() => this.spawnWeb(), 1500);
        } else {
          this.setStatus("error", "the NebulaX daemon would not start — run `nebula` in the Terminal view.");
          this.retry(() => {
            this.daemonAttempts = 0;
            this.spawnWeb();
          }, 15000);
        }
        return;
      }
      // Exit 0 after "already running": another bridge owns the port and we
      // are connected to it; the WebSocket's own close handler takes over.
      if (code === 0 && connected) return;
      this.setStatus("error", (stderr.trim() || `nebula web exited (${code})`).split("\n").pop());
      this.retry(() => this.spawnWeb(), 5000);
    });
  }

  startDaemon() {
    this.setStatus("starting", "starting the NebulaX daemon…");
    try {
      const d = spawn(this.bin, ["daemon"], { env: childEnv(), detached: true, stdio: "ignore" });
      d.on("error", () => {});
      d.unref();
    } catch {
      // reported through the bridge's next failure
    }
  }

  connect() {
    if (this.stopping) return;
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
    this.ws = ws;
    ws.on("open", () => {
      this.backoffMs = 1000;
      this.daemonAttempts = 0;
      this.setStatus("connected", "");
    });
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.handle(msg.kind, msg.payload || {});
    });
    ws.on("error", () => {
      // 'close' follows and handles it
    });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.settleAll("lost the connection to NebulaX");
      if (this.stopping) return;
      if (this.status.state !== "error") this.setStatus("disconnected", "reconnecting…");
      const wait = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 15000);
      // Bridge process still alive → just reconnect; otherwise respawn it.
      this.retry(() => (this.child ? this.connect() : this.spawnWeb()), wait);
    });
  }

  send(kind, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ kind, payload }));
    return true;
  }

  handle(kind, p) {
    const events = [];
    switch (kind) {
      case "tickets/snapshot": {
        const list = p.tickets || [];
        if (this.baselined) events.push(...diffSnapshot(this.tickets, list));
        this.tickets = new Map(list.map((t) => [ticketKey(t.id), t]));
        const prevConns = new Map(this.connections.map((c) => [c.id, c]));
        this.connections = p.connections || [];
        if (this.baselined) {
          for (const c of this.connections) events.push(...diffConnection(prevConns.get(c.id), c));
        }
        this.inbox = p.inbox || [];
        this.baselined = true;
        this.emit("board", this.snapshot());
        break;
      }
      case "tickets/upsert": {
        const t = p.ticket;
        if (!t) return;
        const k = ticketKey(t.id);
        if (this.baselined) events.push(...diffTicket(this.tickets.get(k), t));
        this.tickets.set(k, t);
        this.emit("board", this.snapshot());
        break;
      }
      case "tickets/removed": {
        const k = ticketKey(p.id);
        const t = this.tickets.get(k);
        if (t) {
          events.push(removedEvent(t, p.reason));
          this.tickets.delete(k);
          this.emit("board", this.snapshot());
        }
        break;
      }
      case "connections/status": {
        const i = this.connections.findIndex((c) => c.id === p.id);
        events.push(...diffConnection(i >= 0 ? this.connections[i] : null, p));
        if (i >= 0) this.connections[i] = p;
        else this.connections.push(p);
        this.emit("board", this.snapshot());
        break;
      }
      case "inbox/event": {
        if (!this.inbox.some((e) => e.dedupe_key === p.dedupe_key)) {
          this.inbox.unshift(p);
          if (this.inbox.length > INBOX_CAP) this.inbox.length = INBOX_CAP;
          this.emit("board", this.snapshot());
        }
        break;
      }
      case "tree/snapshot":
        this.projects = new Map((p.projects || []).map((x) => [x.id, x]));
        this.worktrees = new Map((p.worktrees || []).map((x) => [x.id, x]));
        this.agents = new Map((p.agents || []).map((x) => [x.id, x]));
        this.emit("worktrees");
        break;
      case "tree/upsert":
        if (p.project) this.projects.set(p.project.id, p.project);
        if (p.worktree) this.worktrees.set(p.worktree.id, p.worktree);
        if (p.agent) this.agents.set(p.agent.id, p.agent);
        this.emit("worktrees");
        break;
      case "tree/removed":
        if (p.project) this.projects.delete(p.project);
        if (p.worktree) this.worktrees.delete(p.worktree);
        if (p.agent) this.agents.delete(p.agent);
        this.emit("worktrees");
        break;
      case "tree/status": {
        const a = this.agents.get(p.agent);
        if (a && a.status !== p.status) {
          a.status = p.status;
          this.emit("worktrees");
        }
        break;
      }
      case "request/done":
        this.settle(p.req_id, { ok: true });
        break;
      case "request/error":
        this.settle(p.req_id, { ok: false, error: p.message });
        break;
      case "board/changes-result":
        this.emit("changes", p);
        break;
      case "error": {
        // A daemon-side error on a live socket is reported, not a lost
        // connection: "error" would stick until the next reconnect and stop
        // the rotator from ever running.
        const detail = typeof p === "string" ? p : JSON.stringify(p);
        const live = this.ws && this.ws.readyState === WebSocket.OPEN;
        this.setStatus(live ? "connected" : "error", detail);
        break;
      }
    }
    if (events.length) this.emit("events", events);
  }
}

module.exports = { NebulaBridge };
