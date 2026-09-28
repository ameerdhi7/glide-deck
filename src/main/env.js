// A GUI app launched from Finder or the Dock gets launchd's bare PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), which finds neither `nebula` (in
// ~/.cargo/bin) nor `gh` (in /opt/homebrew/bin). Ask the user's login shell
// for its PATH once, and fall back to the usual install dirs if that fails.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FALLBACK_DIRS = [
  path.join(os.homedir(), ".cargo", "bin"),
  path.join(os.homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

let cachedPath = null;

function loginPath() {
  if (cachedPath) return cachedPath;
  let shellPath = "";
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    shellPath = execFileSync(shell, ["-ilc", 'printf "__PATH__%s__PATH__" "$PATH"'], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = shellPath.match(/__PATH__(.*)__PATH__/);
    shellPath = m ? m[1] : "";
  } catch {
    shellPath = "";
  }
  const parts = [...shellPath.split(":"), ...(process.env.PATH || "").split(":"), ...FALLBACK_DIRS];
  cachedPath = [...new Set(parts.filter(Boolean))].join(":");
  return cachedPath;
}

/** The environment children (nebula, gh, the terminal) run with. */
function childEnv(extra = {}) {
  return { ...process.env, PATH: loginPath(), ...extra };
}

/** First executable named `name` on the login PATH, or null. */
function which(name) {
  for (const dir of loginPath().split(":")) {
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** The nebula binary: the configured path when set, else PATH lookup. */
function nebulaBin(configured) {
  if (configured) return configured;
  return which("nebula");
}

module.exports = { loginPath, childEnv, which, nebulaBin };
