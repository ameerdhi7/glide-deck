// Small JSON files under Electron's userData dir: the user's settings and
// the activity feed. Written whole and atomically (tmp + rename).

const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = {
  // Empty = find `nebula` on the login PATH.
  nebulaBin: "",
  // The port the desktop app runs its own `nebula web` bridge on; distinct
  // from the CLI's 7690 default so the two never fight over a port.
  bridgePort: 7691,
  prPollSeconds: 60,
  notify: {
    tickets: true,
    prs: true,
    connections: true,
    sound: true,
    // Also pop a banner while the window is focused (the feed always updates).
    whenFocused: false,
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
  save() {
    writeJson(this.file, { items: this.items, lastReadTs: this.lastReadTs });
  }
}

module.exports = { Settings, Activity, DEFAULTS, deepMerge };
