// The desktop app's line to NebulaX. It does not speak the daemon's socket
// protocol itself: it runs `nebula web --no-open` (the same JSON-over-
// WebSocket bridge the browser dashboard uses) on its own port and connects
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

const NO_DAEMON = /no nebula daemon is running/i;

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
      this.ws.terminate();
      this.ws = null;
    }
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
      // "nebula web dashboard on http://…" or "… already running on http://…"
      if (!connected && /dashboard (on|already running)/.test(text)) {
        connected = true;
        this.connect();
      }
    };
    child.stdout.on("data", onOut);
    child.stderr.on("data", (b) => {
      stderr += b.toString();
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
          this.emit("board", this.snapshot());
        }
        break;
      }
      case "board/changes-result":
        this.emit("changes", p);
        break;
      case "error":
        this.setStatus("error", typeof p === "string" ? p : JSON.stringify(p));
        break;
    }
    if (events.length) this.emit("events", events);
  }
}

module.exports = { NebulaBridge };
