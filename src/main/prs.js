// Pull requests, straight from GitHub through the user's own `gh` login —
// the same tool the NebulaX TUI's PR rows use, so there is no second token to
// configure. One GraphQL call per poll fetches three lists: PRs waiting on
// the user's review, the user's open PRs, and the user's recently closed or
// merged ones.

const { execFile } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { childEnv, which } = require("./env");
const { diffPrs } = require("./diff");

const PR_FIELDS = `
  ... on PullRequest {
    number title url isDraft state updatedAt mergedAt headRefName
    author { login }
    repository { nameWithOwner }
    reviewDecision
    comments { totalCount }
    additions deletions
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  }`;

function query(since) {
  return `query {
    review: search(query: "is:pr is:open review-requested:@me archived:false sort:updated-desc", type: ISSUE, first: 30) { nodes { ${PR_FIELDS} } }
    mine: search(query: "is:pr is:open author:@me archived:false sort:updated-desc", type: ISSUE, first: 50) { nodes { ${PR_FIELDS} } }
    closed: search(query: "is:pr is:closed author:@me archived:false updated:>=${since} sort:updated-desc", type: ISSUE, first: 20) { nodes { ${PR_FIELDS} } }
  }`;
}

/** Flatten one GraphQL PR node into the shape the app uses. */
function normalize(node, bucket) {
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  return {
    url: node.url,
    number: node.number,
    title: node.title,
    repo: node.repository?.nameWithOwner || "",
    author: node.author?.login || "",
    draft: !!node.isDraft,
    state: node.state,
    updatedAt: node.updatedAt,
    mergedAt: node.mergedAt || null,
    headRef: node.headRefName || "",
    reviewDecision: node.reviewDecision || null,
    checks: rollup?.state || null,
    comments: node.comments?.totalCount || 0,
    additions: node.additions || 0,
    deletions: node.deletions || 0,
    bucket,
  };
}

/** The three lists → one de-duplicated list; a PR in `review` wins. */
function collect(data) {
  const out = new Map();
  for (const bucket of ["review", "mine", "closed"]) {
    for (const node of data?.[bucket]?.nodes || []) {
      if (!node || !node.url || out.has(node.url)) continue;
      out.set(node.url, normalize(node, bucket));
    }
  }
  return [...out.values()];
}

class PrWatcher extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.prs = new Map();
    this.error = null;
    this.baselined = false;
    this.timer = null;
    this.inflight = false;
    this.lastPoll = 0;
  }

  snapshot() {
    return { prs: [...this.prs.values()], error: this.error, lastPoll: this.lastPoll };
  }

  start() {
    this.poll();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  schedule() {
    clearTimeout(this.timer);
    const secs = Math.max(15, Number(this.settings.get().prPollSeconds) || 60);
    this.timer = setTimeout(() => this.poll(), secs * 1000);
  }

  poll(attempt = 0) {
    if (this.inflight) return;
    const gh = which("gh");
    if (!gh) {
      this.error = "GitHub CLI (`gh`) not found — install it and run `gh auth login` to see PRs.";
      this.emit("prs", this.snapshot());
      this.schedule();
      return;
    }
    this.inflight = true;
    const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
    execFile(
      gh,
      ["api", "graphql", "-f", `query=${query(since)}`],
      { env: childEnv(), timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        this.inflight = false;
        this.lastPoll = Date.now();
        if (err) {
          const msg = (stderr || err.message || "").trim().split("\n")[0];
          // GitHub's search API throws the odd 502 under load; one quick
          // retry hides it rather than flashing an error banner.
          if (attempt === 0 && /HTTP 5\d\d|timed? ?out|ETIMEDOUT|ECONNRESET/i.test(msg)) {
            clearTimeout(this.timer);
            this.timer = setTimeout(() => this.poll(1), 3000);
            return;
          }
          this.error = /auth|login|token/i.test(msg)
            ? "`gh` is not logged in — run `gh auth login` in the Terminal view."
            : `GitHub lookup failed: ${msg}`;
          this.emit("prs", this.snapshot());
          this.schedule();
          return;
        }
        let list;
        try {
          list = collect(JSON.parse(stdout).data);
        } catch (e) {
          this.error = `could not read GitHub's answer: ${e.message}`;
          this.emit("prs", this.snapshot());
          this.schedule();
          return;
        }
        const events = this.baselined ? diffPrs(this.prs, list) : [];
        this.prs = new Map(list.map((p) => [p.url, p]));
        this.error = null;
        this.baselined = true;
        this.emit("prs", this.snapshot());
        if (events.length) this.emit("events", events);
        this.schedule();
      },
    );
  }
}

module.exports = { PrWatcher, collect, normalize };
