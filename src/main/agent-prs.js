// Pull requests listed by an agent CLI — Claude Code or Codex — through the
// MCP servers the user already connected to it (GitHub, Bitbucket, GitLab…),
// the same way NebulaX's `agent` ticket connection lists tickets. The harness
// holds the credentials, so there is no token here either.
//
// Each listing is one headless model turn (tens of seconds, a few cents), so
// the watcher runs it every `refreshMinutes`, not on the `gh` poll cadence.
// The turn is told to only read: Claude is pre-approved for the named MCP
// servers alone with its built-in tools disallowed; Codex runs read-only.

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { childEnv, which } = require("./env");

const RUN_TIMEOUT_MS = 240000;
const DEFAULT_CLAUDE_MODEL = "haiku";

// Strict (every property required, nulls instead of omissions) because
// Codex's `--output-schema` rejects anything looser.
const nullable = (type) => ({ type: [type, "null"] });
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["error", "prs"],
  properties: {
    error: nullable("string"),
    prs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "url", "number", "title", "repo", "author", "state", "draft", "bucket", "updatedAt", "mergedAt",
          "headRef", "reviewDecision", "checks", "comments", "additions", "deletions", "tickets",
        ],
        properties: {
          url: { type: "string" },
          number: { type: "integer" },
          title: { type: "string" },
          repo: { type: "string" },
          author: { type: "string" },
          state: { type: "string", enum: ["OPEN", "MERGED", "CLOSED"] },
          draft: { type: "boolean" },
          bucket: { type: "string", enum: ["review", "mine", "closed"] },
          updatedAt: nullable("string"),
          mergedAt: nullable("string"),
          headRef: nullable("string"),
          reviewDecision: { type: ["string", "null"], enum: ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", null] },
          checks: { type: ["string", "null"], enum: ["SUCCESS", "FAILURE", "PENDING", null] },
          comments: { type: "integer" },
          additions: { type: "integer" },
          deletions: { type: "integer" },
          tickets: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const CLAUDE_DISALLOWED = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task"];

/** The usual MCP server name for a well-known source (`claude mcp list` shows yours). */
function serversFor(cfg) {
  const configured = String(cfg.mcpServers || "")
    .split(/[\s,]+/)
    .map((s) => s.replace(/^mcp__/, "").trim())
    .filter(Boolean);
  if (configured.length) return configured;
  const known = { github: "github", bitbucket: "bitbucket", gitlab: "gitlab", "azure devops": "azure-devops" };
  const k = known[String(cfg.source || "").trim().toLowerCase()];
  return k ? [k] : [];
}

function prompt(cfg, ticketKeys) {
  const source = String(cfg.source || "").trim() || "code host (GitHub, Bitbucket, GitLab or similar)";
  const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  let p =
    `You are a read-only pull request lister feeding a dashboard. Using the ${source} tools available to you ` +
    `through MCP, list three groups of pull requests for me (the authenticated user): bucket "review" — open PRs ` +
    `waiting on my review; bucket "mine" — my open PRs; bucket "closed" — my PRs merged or closed since ${since}. ` +
    `A PR belongs to one bucket only, "review" first.`;
  if (String(cfg.query || "").trim()) p += ` Scope: ${cfg.query.trim()}.`;
  if (ticketKeys.length) {
    p +=
      `\n\nMy tickets are: ${ticketKeys.join(", ")}. For each PR, put in "tickets" the keys from that list it ` +
      `relates to — named in its title, branch or description, or linked to it by the tracker. Also list any open ` +
      `PR of mine for one of those tickets. Use [] when none apply.`;
  }
  p +=
    `\n\nRules: only read — never create, merge, approve, comment on or edit anything. Use MCP tools only. Never ` +
    `ask me anything: discover any workspace, org or repository you need with the tools themselves. If the tools ` +
    `are missing or not authenticated, return an empty list and put the reason in "error"; otherwise "error" is ` +
    `null. state is OPEN, MERGED or CLOSED (a declined PR is CLOSED). repo is "owner/name" or "workspace/repo". ` +
    `reviewDecision and checks are null when the host doesn't say. updatedAt and mergedAt are ISO-8601 or null. ` +
    `Use 0 for counts you can't read.`;
  return p;
}

/** Claude's `--output-format json` envelope → the answer; shell noise ahead of it is skipped. */
function parseClaude(stdout) {
  const line = String(stdout)
    .split("\n")
    .reverse()
    .find((l) => l.trimStart().startsWith("{"));
  if (!line) throw new Error("claude printed no JSON result");
  const env = JSON.parse(line);
  if (env.is_error) throw new Error(`claude: ${env.result || "unknown error"}`);
  return env.structured_output != null ? env.structured_output : JSON.parse(env.result || "");
}

/** One answered PR → the shape the app uses (the same as the `gh` path's). */
function normalize(p) {
  const bucket = ["review", "mine", "closed"].includes(p.bucket) ? p.bucket : p.state === "OPEN" ? "mine" : "closed";
  return {
    url: p.url,
    number: Number(p.number) || 0,
    title: p.title || "",
    repo: p.repo || "",
    author: p.author || "",
    draft: !!p.draft,
    state: ["OPEN", "MERGED", "CLOSED"].includes(p.state) ? p.state : "OPEN",
    updatedAt: p.updatedAt || null,
    mergedAt: p.mergedAt || null,
    headRef: p.headRef || "",
    reviewDecision: p.reviewDecision || null,
    checks: p.checks || null,
    comments: Number(p.comments) || 0,
    additions: Number(p.additions) || 0,
    deletions: Number(p.deletions) || 0,
    tickets: Array.isArray(p.tickets) ? p.tickets.map(String) : [],
    bucket,
  };
}

/** The answer → a de-duplicated list; a PR in `review` wins. */
function collectAnswer(answer) {
  const out = new Map();
  const list = (answer && answer.prs) || [];
  for (const bucket of ["review", "mine", "closed"]) {
    for (const p of list) {
      if (!p || !/^https?:\/\//.test(p.url || "") || out.has(p.url)) continue;
      const n = normalize(p);
      if (n.bucket === bucket) out.set(n.url, n);
    }
  }
  return [...out.values()];
}

function run(program, args, cwd, signal) {
  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      { cwd, env: childEnv(), timeout: RUN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, signal },
      (err, stdout, stderr) => {
        if (err) {
          if (err.name === "AbortError") return reject(new Error("cancelled"));
          const detail = (String(stderr).trim() || String(stdout).trim()).split("\n").pop() || err.message;
          const why = err.killed ? `did not answer within ${RUN_TIMEOUT_MS / 1000}s` : detail;
          reject(new Error(`${path.basename(program)} ${why}`));
        } else resolve(String(stdout));
      },
    );
  });
}

/**
 * List PRs through `cfg.provider` (`claude` | `codex`). Resolves to the PR
 * list; rejects with a message fit for the error banner. Aborting `signal`
 * kills the turn in flight.
 */
async function listPrs(cfg, ticketKeys = [], signal) {
  const harness = cfg.provider;
  const bin = which(harness);
  if (!bin) throw new Error(`\`${harness}\` not found on your PATH — install it or pick another provider in Settings.`);
  const text = prompt(cfg, ticketKeys);
  const cwd = os.homedir();
  const model = String(cfg.model || "").trim();

  let answer;
  if (harness === "claude") {
    const servers = serversFor(cfg);
    if (!servers.length) {
      throw new Error("Name the MCP servers that reach your code host in Settings (see `claude mcp list`).");
    }
    const args = [
      "-p", text,
      "--output-format", "json",
      "--json-schema", JSON.stringify(SCHEMA),
      "--model", model || DEFAULT_CLAUDE_MODEL,
      "--max-turns", "25",
      // `mcp__<server>` grants every tool on that server; nothing else is
      // pre-approved, and a headless turn denies the rest.
      "--allowedTools", ...servers.map((s) => `mcp__${s}`),
      "--disallowedTools", ...CLAUDE_DISALLOWED,
    ];
    answer = parseClaude(await run(bin, args, cwd, signal));
  } else if (harness === "codex") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nebulax-prs-"));
    try {
      const schema = path.join(dir, "schema.json");
      const out = path.join(dir, "answer.json");
      fs.writeFileSync(schema, JSON.stringify(SCHEMA));
      const args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--output-schema", schema, "--output-last-message", out];
      if (model) args.push("--model", model);
      args.push(text);
      await run(bin, args, cwd, signal);
      answer = JSON.parse(fs.readFileSync(out, "utf8").trim());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } else {
    throw new Error(`unknown provider "${harness}"`);
  }

  const list = collectAnswer(answer);
  if (answer && answer.error && !list.length) throw new Error(`${harness} could not list pull requests: ${answer.error}`);
  return list;
}

module.exports = { listPrs, parseClaude, collectAnswer, serversFor, prompt, SCHEMA };
