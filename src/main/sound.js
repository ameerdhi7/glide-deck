// Activity sounds: the main process plays them, so they sound while the
// window is closed too. macOS system sounds through `afplay`; elsewhere the
// system beep is all there is.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

// Lazy, so the pure parts load under `node --test`.
const beep = () => require("electron").shell.beep();

const DIR = "/System/Library/Sounds";
const RANK = { error: 3, warn: 2, info: 1 };
// A reconnect can surface a burst; one sound covers it.
const GAP_MS = 1500;

let last = 0;

/** The sound names the user can pick from ("Glass", "Ping"…). */
function list() {
  if (process.platform !== "darwin") return ["Beep"];
  try {
    return fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith(".aiff"))
      .map((f) => f.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

/** Play one sound by name; "" is silence. */
function play(name) {
  if (!name) return;
  if (process.platform !== "darwin") return beep();
  const file = path.join(DIR, `${path.basename(name)}.aiff`);
  if (!fs.existsSync(file)) return beep();
  const p = spawn("afplay", [file], { stdio: "ignore", detached: true });
  p.on("error", () => beep());
  p.unref();
}

/** New feed events → the sound to play: the most urgent one that has one. */
function pick(events, notify) {
  if (!notify.sound) return "";
  const sounds = notify.sounds || {};
  const e = events
    .filter((e) => sounds[e.category])
    .sort((a, b) => (RANK[b.level] || 0) - (RANK[a.level] || 0))[0];
  return e ? sounds[e.category] : "";
}

function forEvents(events, notify) {
  const name = pick(events, notify);
  if (!name) return;
  const now = Date.now();
  if (now - last < GAP_MS) return;
  last = now;
  play(name);
}

module.exports = { list, play, pick, forEvents };
