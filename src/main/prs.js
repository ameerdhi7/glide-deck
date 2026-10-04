// Pull requests, from the provider picked in Settings: GitHub through the
// user's own `gh` login — the same tool the NebulaX TUI's PR rows use, so
// there is no second token to configure — or an agent CLI through its MCP
// servers (see agent-prs.js). Either way a poll yields three lists: PRs
// waiting on the user's review, the user's open PRs, and the user's recently
// closed or merged ones.

const { execFile } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { childEnv, which } = require("./env");
const { diffPrs } = require("./diff");
const { listPrs } = require("./agent-prs");
const { listBitbucketPrs } = require("./bitbucket-prs");

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

const PROVIDER_LABEL = { gh: "GitHub", claude: "Claude", codex: "Codex" };

class PrWatcher extends EventEmitter {
  /**
   * `ticketKeys()` names the board's tickets, so an agent provider can link
   * PRs to them; `bitbucketSources()` yields the Bitbucket connections whose
   * PRs join whichever provider's list.
   */
  constructor(settings, ticketKeys = () => [], bitbucketSources = async () => []) {
    super();
    this.settings = settings;
    this.ticketKeys = ticketKeys;
    this.bitbucketSources = bitbucketSources;
    this.prs = new Map();
    this.error = null;
    this.baselined = false;
    this.timer = null;
    this.inflight = false;
    this.lastPoll = 0;
    // Bumped on a provider switch so an answer still in flight is dropped.
    this.generation = 0;
    // Kills the poll's child process (gh, claude or codex) when it is dropped.
    this.abort = null;
  }

  config() {
    const c = this.settings.get().prs || {};
    return { ...c, provider: PROVIDER_LABEL[c.provider] ? c.provider : "gh" };
  }

  snapshot() {
    const provider = this.config().provider;
    return {
      prs: [...this.prs.values()],
      error: this.error,
      lastPoll: this.lastPoll,
      provider,
      providerLabel: PROVIDER_LABEL[provider],
      busy: this.inflight,
    };
  }

  start() {
    this.poll();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.cancel();
  }

  /** Drop the poll in flight: kill its process and ignore its answer. */
  cancel() {
    this.generation++;
    this.inflight = false;
    if (this.abort) this.abort.abort();
    this.abort = null;
  }

  /** A fresh abort signal for the poll about to start. */
  signal() {
    this.abort = new AbortController();
    return this.abort.signal;
  }

  /**
   * The provider or its settings changed: forget the old list without
   * announcing its PRs again as new, and ask the new one at once.
   */
  reset() {
    this.cancel();
    this.prs = new Map();
    this.error = null;
    this.baselined = false;
    this.lastPoll = 0;
    this.emit("prs", this.snapshot());
    this.poll();
  }

  schedule() {
    clearTimeout(this.timer);
    const cfg = this.config();
    const ms =
      cfg.provider === "gh"
        ? Math.max(15, Number(this.settings.get().prPollSeconds) || 60) * 1000
        : Math.max(2, Number(cfg.refreshMinutes) || 10) * 60000;
    this.timer = setTimeout(() => this.poll(), ms);
  }

  poll(attempt = 0) {
    if (this.inflight) return;
    const cfg = this.config();
    if (cfg.provider === "gh") return this.pollGh(attempt);
    this.inflight = true;
    const gen = this.generation;
    this.emit("prs", this.snapshot()); // shows "asking…" while the turn runs
    listPrs(cfg, this.ticketKeys(), this.signal()).then(
      (list) => this.withBitbucket(gen, list, null),
      (e) => this.withBitbucket(gen, null, e.message),
    );
  }

  /**
   * Add the Bitbucket connections' PRs to one provider outcome, then finish.
   * Bitbucket PRs showing means the poll counts as good even when the
   * provider failed; the provider's error still shows as a banner — unless
   * it is `soft` (gh missing or logged out) and Bitbucket answered, since
   * then the user simply isn't on GitHub.
   */
  async withBitbucket(gen, list, error, soft = false) {
    let bb = { prs: [], errors: [], read: 0 };
    try {
      bb = await listBitbucketPrs(await this.bitbucketSources());
    } catch (e) {
      bb.errors.push(`Bitbucket: ${e.message}`);
    }
    if (gen !== this.generation) return;
    if (soft && bb.read) {
      error = null;
      list = list || [];
    }
    const errors = [error, ...bb.errors].filter(Boolean);
    if (!list && !bb.prs.length) return this.finish(null, errors.join(" · ") || null);
    const seen = new Set((list || []).map((p) => p.url));
    const merged = [...(list || []), ...bb.prs.filter((p) => !seen.has(p.url))];
    this.finish(merged, errors.join(" · ") || null);
  }

  /**
   * One poll's outcome: with no list, the error keeps the last-known list on
   * screen; a list with an error is partial (one source failed) and shown.
   */
  finish(list, error) {
    this.inflight = false;
    this.lastPoll = Date.now();
    this.error = error || null;
    if (list) {
      const events = this.baselined ? diffPrs(this.prs, list) : [];
      this.prs = new Map(list.map((p) => [p.url, p]));
      this.baselined = true;
      if (events.length) this.emit("events", events);
    }
    this.emit("prs", this.snapshot());
    this.schedule();
  }

  pollGh(attempt) {
    const gh = (this.gh = this.gh || which("gh"));
    this.inflight = true;
    const gen = this.generation;
    if (!gh) return this.withBitbucket(gen, null, "GitHub CLI (`gh`) not found — install it and run `gh auth login` to see GitHub PRs.", true);
    const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
    execFile(
      gh,
      ["api", "graphql", "-f", `query=${query(since)}`],
      { env: childEnv(), timeout: 30000, maxBuffer: 8 * 1024 * 1024, signal: this.signal() },
      (err, stdout, stderr) => {
        if (gen !== this.generation) return;
        if (err) {
          const msg = (stderr || err.message || "").trim().split("\n")[0];
          // GitHub's search API throws the odd 502 under load; one quick
          // retry hides it rather than flashing an error banner.
          if (attempt === 0 && /HTTP 5\d\d|timed? ?out|ETIMEDOUT|ECONNRESET/i.test(msg)) {
            this.inflight = false;
            clearTimeout(this.timer);
            this.timer = setTimeout(() => this.poll(1), 3000);
            return;
          }
          return this.withBitbucket(
            gen,
            null,
            /auth|login|token/i.test(msg)
              ? "`gh` is not logged in — run `gh auth login` in the Terminal view."
              : `GitHub lookup failed: ${msg}`,
            /auth|login|token/i.test(msg),
          );
        }
        let list;
        try {
          list = collect(JSON.parse(stdout).data);
        } catch (e) {
          return this.withBitbucket(gen, null, `could not read GitHub's answer: ${e.message}`);
        }
        this.withBitbucket(gen, list, null);
      },
    );
  }
}

module.exports = { PrWatcher, collect, normalize };
