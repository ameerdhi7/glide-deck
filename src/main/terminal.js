// The terminal experience: the NebulaX TUI itself, running in a real PTY and
// drawn by xterm.js in the Terminal view. The desktop app watches; the TUI is
// still where you drive.
//
// The PTY's output is mirrored into a headless xterm here in the main process
// and only streamed to the window while the Terminal view is on screen
// (`attach`). Streaming every chunk to a window that isn't showing it cost
// ~15% CPU for nothing — the TUI redraws ~10×/s even when idle. On attach the
// window gets the mirror's serialized screen, then the live stream, so it
// picks up exactly where the TUI is.

const fs = require("node:fs");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const pty = require("node-pty");
const { Terminal: Headless } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");
const { childEnv, nebulaBin } = require("./env");

/** What the NebulaX hub runs: the `nebula` TUI. */
function nebulaCommand(settings) {
  const bin = nebulaBin(settings.get().nebulaBin);
  if (!bin) return { error: "`nebula` was not found — set its path in Settings." };
  return { file: bin, args: [], label: "nebula" };
}

/** What the Terminal view runs: the user's own login shell, nothing else. */
function shellCommand() {
  const file = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
  return { file, args: process.platform === "win32" ? [] : ["-l"], label: "the shell" };
}

class TerminalHost extends EventEmitter {
  constructor(settings, userData, command = nebulaCommand) {
    super();
    this.settings = settings;
    this.userData = userData;
    this.command = command;
    this.proc = null;
    this.mirror = null;
    this.serializer = null;
    this.attached = false;
  }

  running() {
    return !!this.proc;
  }

  /** Start the TUI in a PTY sized `cols`×`rows`; no-op if already running. */
  start(cols, rows) {
    if (this.proc) {
      this.resize(cols, rows);
      return { ok: true, already: true };
    }
    cols = Math.max(20, cols || 120);
    rows = Math.max(5, rows || 36);
    const cmd = this.command(this.settings);
    if (cmd.error) return { ok: false, error: cmd.error };
    const cwd = this.settings.get().terminal.cwd || os.homedir();
    try {
      this.proc = pty.spawn(cmd.file, cmd.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: fs.existsSync(cwd) ? cwd : os.homedir(),
        env: childEnv({ TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Glide-Deck" }),
      });
    } catch (e) {
      return { ok: false, error: `could not start ${cmd.label}: ${e.message}` };
    }
    const proc = this.proc;
    this.disposeMirror();
    const mirror = new Headless({ cols, rows, scrollback: 1000, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    mirror.loadAddon(this.serializer);
    this.mirror = mirror;
    proc.onData((d) => {
      // A killed process can still flush output; it belongs to no session.
      if (this.proc !== proc) return;
      mirror.write(d);
      if (this.attached) this.emit("data", d);
    });
    // Only an exit we didn't cause is news; kill() already cleared `proc`.
    proc.onExit(({ exitCode }) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.emit("exit", exitCode);
    });
    return { ok: true };
  }

  /**
   * Start streaming to the window; resolves to the screen so far. Chunks
   * queued before this call are in the snapshot, later ones are streamed —
   * the empty write's callback marks the boundary.
   */
  attach() {
    this.attached = true;
    const { mirror, serializer } = this;
    if (!mirror) return Promise.resolve("");
    return new Promise((resolve) => mirror.write("", () => resolve(serializer.serialize({ scrollback: 1000 }))));
  }

  detach() {
    this.attached = false;
  }

  disposeMirror() {
    if (this.mirror) this.mirror.dispose();
    this.mirror = null;
    this.serializer = null;
  }

  write(data) {
    if (this.proc) this.proc.write(data);
  }

  resize(cols, rows) {
    if (this.proc && cols > 0 && rows > 0) {
      try {
        this.proc.resize(cols, rows);
        if (this.mirror) this.mirror.resize(cols, rows);
      } catch {
        // the process may have just exited
      }
    }
  }

  kill() {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}

module.exports = { TerminalHost, shellCommand };
