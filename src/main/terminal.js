// The terminal experience: the NebulaX TUI itself, running in a real PTY and
// drawn by xterm.js in the Terminal view — or, on request, handed off to
// Terminal.app. The desktop app watches; the TUI is still where you drive.

const { spawn: spawnProcess } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const pty = require("node-pty");
const { childEnv, nebulaBin } = require("./env");

class TerminalHost extends EventEmitter {
  constructor(settings, userData) {
    super();
    this.settings = settings;
    this.userData = userData;
    this.proc = null;
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
    const bin = nebulaBin(this.settings.get().nebulaBin);
    if (!bin) return { ok: false, error: "`nebula` was not found — set its path in Settings." };
    const cwd = this.settings.get().terminal.cwd || os.homedir();
    try {
      this.proc = pty.spawn(bin, [], {
        name: "xterm-256color",
        cols: Math.max(20, cols || 120),
        rows: Math.max(5, rows || 36),
        cwd: fs.existsSync(cwd) ? cwd : os.homedir(),
        env: childEnv({ TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "NebulaX-Desktop" }),
      });
    } catch (e) {
      return { ok: false, error: `could not start nebula: ${e.message}` };
    }
    const proc = this.proc;
    proc.onData((d) => this.emit("data", d));
    proc.onExit(({ exitCode }) => {
      if (this.proc === proc) this.proc = null;
      this.emit("exit", exitCode);
    });
    return { ok: true };
  }

  write(data) {
    if (this.proc) this.proc.write(data);
  }

  resize(cols, rows) {
    if (this.proc && cols > 0 && rows > 0) {
      try {
        this.proc.resize(cols, rows);
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

  /**
   * Open NebulaX in Terminal.app. A `.command` file opened with `open` runs
   * in a new Terminal window without needing Automation permission.
   */
  openExternal() {
    const bin = nebulaBin(this.settings.get().nebulaBin);
    if (!bin) return { ok: false, error: "`nebula` was not found — set its path in Settings." };
    const cwd = this.settings.get().terminal.cwd || os.homedir();
    const file = path.join(this.userData, "open-nebulax.command");
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    fs.writeFileSync(file, `#!/bin/zsh -l\ncd ${q(cwd)} 2>/dev/null\nexec ${q(bin)}\n`, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
    spawnProcess("open", [file], { detached: true, stdio: "ignore" }).unref();
    return { ok: true };
  }
}

module.exports = { TerminalHost };
