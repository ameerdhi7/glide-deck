// Small JSON files under Electron's userData dir: the user's settings and
// the activity feed. Written whole and atomically (tmp + rename).

const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = {
  // Set once the first-run Getting started guide is finished or dismissed
  // (or skipped because connections already existed).
  onboarded: false,
  // Empty = find `nebula` on the login PATH.
  nebulaBin: "",
  // The port the desktop app runs its own `nebula web` bridge on; distinct
  // from the CLI's 7690 default so the two never fight over a port.
  bridgePort: 7691,
  prPollSeconds: 60,
  // Where pull requests come from: `gh` (GitHub CLI), or `claude` / `codex`
  // listing them through their own MCP servers — like an `agent` ticket
  // connection. The rest applies to the agent providers only.
  prs: {
    provider: "gh",
    // Which code host to ask, in plain words ("GitHub", "Bitbucket").
    source: "GitHub",
    // Empty = `haiku` for Claude, Codex's own default.
    model: "",
    // Claude: MCP server names from `claude mcp list`, comma-separated.
    // Empty derives one from `source`.
    mcpServers: "",
    // Extra scope in plain words ("only the questify repos").
    query: "",
    // Each listing is a paid model turn, so it runs this often, not every poll.
    refreshMinutes: 10,
  },
  notify: {
    tickets: true,
    prs: true,
    // Pop PR notifications only for PRs linked to a ticket on the board
    // (the activity feed still gets every one).
    prsLinkedOnly: false,
    connections: true,
    // Play a sound as activity arrives — whether or not a banner pops.
    sound: true,
    // Which sound each kind of activity plays ("" = none); macOS system
    // sound names, see sound.js.
    sounds: {
      tickets: "Glass",
      prs: "Ping",
      connections: "Basso",
      worktrees: "",
    },
    // Also pop a banner while the window is focused (the feed always updates).
    whenFocused: false,
  },
  // Worktree rotation: remove checkouts older than `olderThan` `unit`
  // (hours | days | weeks), by when git last moved in them ("activity") or
  // when they were made ("created"). Off until the user turns it on.
  rotate: {
    enabled: false,
    olderThan: 7,
    unit: "days",
    basis: "activity",
  },
  // The ticket play button: which agent implements the ticket, the branch
  // its worktree is cut from, and the project each tracker connection's
  // tickets were last started in (connection id → project id).
  start: {
    harness: "claude",
    base: "develop",
    projects: {},
  },
  terminal: {
    // Start the NebulaX TUI in the built-in terminal as soon as the app opens,
    // rather than on first visit to the Terminal view.
    autostart: false,
    cwd: "",
  },
};

const ACTIVITY_CAP = 300;

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base && typeof base[k] === "object") {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

class Settings {
  constructor(dir) {
    this.file = path.join(dir, "settings.json");
    this.value = deepMerge(DEFAULTS, readJson(this.file, {}));
  }
  get() {
    return this.value;
  }
  update(patch) {
    this.value = deepMerge(this.value, patch);
    writeJson(this.file, this.value);
    return this.value;
  }
}

class Activity {
  constructor(dir) {
    this.file = path.join(dir, "activity.json");
    const saved = readJson(this.file, {});
    this.items = Array.isArray(saved.items) ? saved.items : [];
    this.lastReadTs = saved.lastReadTs || 0;
    this.seq = this.items.reduce((m, e) => Math.max(m, e.seq || 0), 0);
  }
  add(events) {
    for (const e of events) this.items.unshift({ ...e, seq: ++this.seq });
    this.items.length = Math.min(this.items.length, ACTIVITY_CAP);
    this.save();
  }
  unread() {
    return this.items.filter((e) => e.ts > this.lastReadTs).length;
  }
  markRead() {
    this.lastReadTs = Date.now();
    this.save();
  }
  clear() {
    this.items = [];
    this.save();
  }
  // Bursts (a reconnect can surface dozens of events) coalesce into one
  // write; `flush` on quit makes sure nothing pending is lost.
  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 1000);
  }
  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    writeJson(this.file, { items: this.items, lastReadTs: this.lastReadTs });
  }
}

// The user's notes. Each one is general, or pinned to a project (`scope.id`
// is the NebulaX project id) or a ticket (`scope.id` is the ticket id);
// `scope.label` keeps a readable name for when that project or ticket is gone.
class Notes {
  constructor(dir) {
    this.file = path.join(dir, "notes.json");
    const saved = readJson(this.file, {});
    this.items = Array.isArray(saved.items) ? saved.items : [];
  }
  list() {
    return this.items;
  }
  save(note) {
    const now = Date.now();
    const i = this.items.findIndex((n) => n.id === note.id);
    const prev = i >= 0 ? this.items[i] : { id: note.id || `${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`, createdAt: now };
    const next = {
      ...prev,
      scope: note.scope && ["project", "ticket"].includes(note.scope.kind) ? note.scope : { kind: "general" },
      body: String(note.body || ""),
      updatedAt: now,
    };
    if (i >= 0) this.items[i] = next;
    else this.items.unshift(next);
    writeJson(this.file, { items: this.items });
    return next;
  }
  remove(id) {
    this.items = this.items.filter((n) => n.id !== id);
    writeJson(this.file, { items: this.items });
  }
}

module.exports = { Settings, Activity, Notes, DEFAULTS, deepMerge };
