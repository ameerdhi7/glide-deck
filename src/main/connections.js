// Tracker and code-host connections, edited from Settings. NebulaX keeps them
// in its own two files: the non-secret half (`connections` in config.json)
// and the token (`secrets.connections.<id>.token` in config.local.json — the
// layer it never exports or forwards over ssh). This module patches just
// those keys and leaves every other key in both files as it found it; the
// daemon re-reads them on its next beat, and a resync makes that now.
//
// GitHub is not a connection: NebulaX reaches it through the user's `gh`,
// which holds its own credential, so all this reports is `gh auth status`.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { childEnv, which, nebulaBin } = require("./env");

const KINDS = ["jira", "bitbucket", "agent", "fake"];
const HTTP_TIMEOUT_MS = 15000;

/** Where NebulaX's config lives, as `nebula config path` prints it. */
function locate(configuredBin) {
  const fallback = () => {
    const dir = path.join(os.homedir(), "Library", "Application Support", "dev.nebula.nebula");
    return { config: path.join(dir, "config.json"), local: path.join(dir, "config.local.json") };
  };
  const bin = nebulaBin(configuredBin);
  if (!bin) return Promise.resolve(fallback());
  return new Promise((resolve) => {
    execFile(bin, ["config", "path"], { env: childEnv(), timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(fallback());
      resolve(parseConfigPaths(stdout) || fallback());
    });
  });
}

/** `config.json   /path/…` lines → `{ config, local }`, or null. */
function parseConfigPaths(out) {
  const found = {};
  for (const line of String(out || "").split("\n")) {
    const m = line.match(/^(config\.json|config\.local\.json)\s+(.+?)\s*$/);
    if (m) found[m[1] === "config.json" ? "config" : "local"] = m[2];
  }
  return found.config && found.local ? found : null;
}

function readObject(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch (e) {
    if (e.code === "ENOENT") return {};
    // A file we can't parse is never rewritten from a partial view.
    throw new Error(`${path.basename(file)} is not valid JSON — fix it by hand first (${e.message})`);
  }
}

/** Atomic write through any symlink (a dotfiles-managed config stays linked). */
function writeObject(file, value, mode) {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {
    // not there yet
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : undefined);
  fs.renameSync(tmp, target);
}

/** `abcd…wxyz` → `••••wxyz`: enough to tell two tokens apart, no more. */
function tokenHint(token) {
  const t = String(token || "");
  if (!t) return "";
  return t.length > 8 ? `••••${t.slice(-4)}` : "••••";
}

function envName(id) {
  return `NEBULA_TOKEN_${String(id).replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}

function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function list(s) {
  if (Array.isArray(s)) return s.map((x) => String(x).trim()).filter(Boolean);
  return String(s || "")
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** The fields a kind keeps; anything else already on the entry is carried through. */
function normalize(input) {
  const kind = KINDS.includes(input.kind) ? input.kind : "jira";
  const out = { id: input.id, kind, label: String(input.label || "").trim() };
  const set = (k, v) => {
    if (v !== undefined && v !== null && String(v).trim() !== "") out[k] = String(v).trim();
  };
  if (kind === "jira") {
    set("base_url", String(input.base_url || "").trim().replace(/\/+$/, "").replace(/(\.atlassian\.net)\/.*$/, "$1"));
    set("account", input.account);
    set("jql", input.jql);
  } else if (kind === "bitbucket") {
    set("account", input.account);
    const repos = list(input.repos);
    if (repos.length) out.repos = repos;
  } else if (kind === "agent") {
    set("harness", input.harness === "codex" ? "codex" : "claude");
    set("source", input.source);
    set("query", input.query);
    const servers = list(input.mcp_servers);
    if (servers.length) out.mcp_servers = servers;
  }
  set("repo", input.repo);
  set("base_branch", input.base_branch);
  return out;
}

class Connections {
  constructor(settings) {
    this.settings = settings;
    this.paths = null;
  }

  async where() {
    if (!this.paths) this.paths = await locate(this.settings.get().nebulaBin);
    return this.paths;
  }

  /** Forget the located paths — the nebula binary setting changed. */
  reset() {
    this.paths = null;
  }

  /** Every configured connection with whether a token is on file (never the token). */
  async list() {
    const paths = await this.where();
    const cfg = readObject(paths.config);
    const local = readObject(paths.local);
    const secrets = (local.secrets && local.secrets.connections) || {};
    const conns = Array.isArray(cfg.connections) ? cfg.connections : [];
    return {
      paths,
      connections: conns
        .filter((c) => c && typeof c === "object" && c.id)
        .map((c) => {
          const token = (secrets[c.id] && secrets[c.id].token) || "";
          return {
            ...c,
            hasToken: !!token,
            tokenHint: tokenHint(token),
            envName: envName(c.id),
            envOverride: !!process.env[envName(c.id)],
          };
        }),
    };
  }

  /** Each `bitbucket` connection with its token (env var first) — for the PR list. */
  async bitbucketSources() {
    const paths = await this.where();
    const cfg = readObject(paths.config);
    const secrets = (readObject(paths.local).secrets || {}).connections || {};
    const conns = Array.isArray(cfg.connections) ? cfg.connections : [];
    const token = (c) => String(process.env[envName(c.id)] || (secrets[c.id] && secrets[c.id].token) || "").trim();
    const account = (c) => String(c.account || "").trim();
    return conns
      .filter((c) => c && c.kind === "bitbucket" && c.id)
      .map((c) => {
        // A Jira connection on the same Atlassian login can say who "you"
        // are when the Bitbucket token may not read `/user`.
        const jira = conns.find(
          (j) => j && j.kind === "jira" && j.base_url && token(j) && account(j).toLowerCase() === account(c).toLowerCase(),
        );
        return {
          id: c.id,
          label: c.label,
          account: account(c),
          repos: list(c.repos),
          token: token(c),
          jira: jira ? { baseUrl: jira.base_url, account: account(jira), token: token(jira) } : null,
        };
      });
  }

  /**
   * Add or update one connection. `token` undefined or "" keeps the stored
   * one; `clearToken` drops it. A new connection gets an id from its label.
   */
  async save(input, { token, clearToken } = {}) {
    const paths = await this.where();
    const cfg = readObject(paths.config);
    const conns = Array.isArray(cfg.connections) ? [...cfg.connections] : [];
    const i = input.id ? conns.findIndex((c) => c && c.id === input.id) : -1;
    let id = input.id;
    if (i < 0) {
      const base = slug(input.label) || input.kind || "connection";
      id = base;
      for (let n = 2; conns.some((c) => c && c.id === id); n++) id = `${base}-${n}`;
    }
    const next = normalize({ ...input, id });
    if (!next.label) next.label = id;
    if (i >= 0) {
      // Keys this form doesn't edit (board_id, model, refresh_minutes…) stay.
      const prev = conns[i];
      const edited = ["kind", "label", "base_url", "account", "jql", "repos", "harness", "source", "query", "mcp_servers", "repo", "base_branch"];
      const kept = Object.fromEntries(Object.entries(prev).filter(([k]) => !edited.includes(k)));
      conns[i] = { ...kept, ...next };
    } else {
      conns.push(next);
    }
    cfg.connections = conns;
    writeObject(paths.config, cfg);

    if (clearToken || (token && String(token).trim())) {
      const local = readObject(paths.local);
      local.secrets = local.secrets && typeof local.secrets === "object" ? local.secrets : {};
      const map = local.secrets.connections && typeof local.secrets.connections === "object" ? local.secrets.connections : {};
      if (clearToken) delete map[id];
      else map[id] = { ...(map[id] || {}), token: String(token).trim() };
      local.secrets.connections = map;
      writeObject(paths.local, local, 0o600);
      fs.chmodSync(fs.realpathSync(paths.local), 0o600);
    }
    return id;
  }

  /** Drop a connection and its token. */
  async remove(id) {
    const paths = await this.where();
    const cfg = readObject(paths.config);
    if (Array.isArray(cfg.connections)) {
      cfg.connections = cfg.connections.filter((c) => !c || c.id !== id);
      writeObject(paths.config, cfg);
    }
    const local = readObject(paths.local);
    const map = local.secrets && local.secrets.connections;
    if (map && map[id]) {
      delete map[id];
      writeObject(paths.local, local, 0o600);
    }
  }

  /**
   * Log in with the typed (or stored) token and report who it is — the same
   * whoami call the daemon's `authenticated` step makes.
   */
  async test(input, token) {
    const kind = input.kind;
    if (kind === "agent" || kind === "fake") return { ok: true, who: "no token needed — resync to check" };
    let secret = String(token || "").trim();
    if (!secret && input.id) {
      const paths = await this.where();
      const local = readObject(paths.local);
      secret = (local.secrets && local.secrets.connections && local.secrets.connections[input.id] && local.secrets.connections[input.id].token) || "";
    }
    const account = String(input.account || "").trim();
    if (!account) return { ok: false, error: kind === "jira" ? "Email is empty." : "Account is empty." };
    if (!secret) return { ok: false, error: "No token typed or saved." };
    let url;
    if (kind === "jira") {
      const base = normalize(input).base_url;
      if (!/^https?:\/\//.test(base || "")) return { ok: false, error: "Site URL must start with https://" };
      url = `${base}/rest/api/3/myself`;
    } else {
      url = "https://api.bitbucket.org/2.0/user";
    }
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${account}:${secret}`).toString("base64")}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      const repos = kind === "jira" ? [] : normalize(input).repos || [];
      if (res.status === 403 && repos.length) {
        // No read:user:bitbucket — the daemon then watches the listed repos
        // as nobody in particular, so the test is whether they can be read.
        const pr = await fetch(`https://api.bitbucket.org/2.0/repositories/${repos[0]}/pullrequests?pagelen=1`, {
          headers: { Authorization: `Basic ${Buffer.from(`${account}:${secret}`).toString("base64")}`, Accept: "application/json" },
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (pr.ok) return { ok: true, who: `${account} — reads ${repos.join(", ")} (no read:user, so every PR in them)` };
        return { ok: false, error: `HTTP ${pr.status} reading ${repos[0]} — tick read:repository and read:pullrequest.` };
      }
      if (res.ok) {
        const me = await res.json().catch(() => ({}));
        return { ok: true, who: me.displayName || me.display_name || me.emailAddress || me.username || account };
      }
      const why = {
        401: kind === "jira" ? "401 — wrong email or token (use a classic API token, not a scoped one)." : "401 — wrong account or token (API token → your Atlassian email; app password → your Bitbucket username).",
        403: kind === "jira" ? "403 — the token logs in but lacks a read scope." : "403 — the token lacks read:user:bitbucket. Either tick it, or list the repos (workspace/slug) to watch.",
        404: "404 — check the site URL.",
      }[res.status];
      // Bitbucket names the exact problem ("no Bitbucket scopes", the missing scope).
      const body = await res.json().catch(() => ({}));
      const said = body && body.error && body.error.message;
      return { ok: false, error: [why || `HTTP ${res.status}`, said].filter(Boolean).join(" Bitbucket says: ") };
    } catch (e) {
      return { ok: false, error: e.name === "TimeoutError" ? "Timed out." : e.message };
    }
  }
}

/** `gh auth status` → `{ installed, loggedIn, account, error }`. */
function githubStatus() {
  const gh = which("gh");
  if (!gh) return Promise.resolve({ installed: false, loggedIn: false });
  return new Promise((resolve) => {
    execFile(gh, ["auth", "status", "--hostname", "github.com"], { env: childEnv(), timeout: 15000 }, (err, stdout, stderr) => {
      const out = `${stdout || ""}\n${stderr || ""}`;
      const m = out.match(/Logged in to \S+ (?:account|as) (\S+)/);
      if (m) return resolve({ installed: true, loggedIn: true, account: m[1] });
      resolve({ installed: true, loggedIn: false, error: err ? out.trim().split("\n").pop() : "" });
    });
  });
}

module.exports = { Connections, githubStatus, parseConfigPaths, normalize, tokenHint, envName };
