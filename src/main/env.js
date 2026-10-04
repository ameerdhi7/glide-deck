// A GUI app launched from Finder or the Dock gets launchd's bare PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), which finds neither `nebula` (in
// ~/.cargo/bin) nor `gh` (in /opt/homebrew/bin). Ask the user's login shell
// for its PATH once, and fall back to the usual install dirs if that fails.

const { execFile, execFileSync } = require("node:child_process");
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

const SHELL_ARGS = ["-ilc", 'printf "__PATH__%s__PATH__" "$PATH"'];

function mergePath(shellOut) {
  const m = (shellOut || "").match(/__PATH__(.*)__PATH__/);
  const parts = [...(m ? m[1] : "").split(":"), ...(process.env.PATH || "").split(":"), ...FALLBACK_DIRS];
  return [...new Set(parts.filter(Boolean))].join(":");
}

/**
 * Resolve the login PATH off the main thread — an interactive login shell
 * takes ~1s to start, which would otherwise freeze the app at launch. Call
 * once at startup; `loginPath()` is then a cache hit.
 */
function warmLoginPath() {
  if (cachedPath) return Promise.resolve(cachedPath);
  return new Promise((resolve) => {
    execFile(process.env.SHELL || "/bin/zsh", SHELL_ARGS, { encoding: "utf8", timeout: 4000 }, (_err, stdout) => {
      cachedPath = cachedPath || mergePath(stdout);
      resolve(cachedPath);
    });
  });
}

/** The login PATH; blocks only if `warmLoginPath` hasn't finished. */
function loginPath() {
  if (cachedPath) return cachedPath;
  let out = "";
  try {
    out = execFileSync(process.env.SHELL || "/bin/zsh", SHELL_ARGS, {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    out = "";
  }
  cachedPath = mergePath(out);
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

module.exports = { loginPath, warmLoginPath, childEnv, which, nebulaBin };
