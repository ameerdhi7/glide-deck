// Worktree rotation: when it's on, checkouts older than the user's cutoff are
// removed through the daemon on a timer — the same `worktrees/delete` the
// Worktrees view's Delete button sends, never forced, so a checkout with
// uncommitted changes is kept and reported. Checkouts with a running
// session are never touched.

const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const UNIT_MS = { hours: 3600_000, days: 86400_000, weeks: 7 * 86400_000 };
// How often a rotation looks for stale checkouts while it's on.
const CHECK_MS = 15 * 60_000;
// The first look waits for the daemon's tree to arrive.
const FIRST_CHECK_MS = 30_000;

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * When a checkout was made and when git last moved in it. A linked worktree's
 * `.git` is a file pointing at its admin dir (`<repo>/.git/worktrees/<name>`),
 * whose HEAD, index and reflog change on every checkout, commit or stage.
 * `{created, active}` in epoch ms; 0 when the folder is gone.
 */
function worktreeTimes(dir) {
  let created = 0;
  let gitdir = "";
  try {
    const st = fs.statSync(path.join(dir, ".git"));
    created = st.birthtimeMs || st.mtimeMs;
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir, ".git"), "utf8"));
      if (m) gitdir = path.resolve(dir, m[1].trim());
    }
  } catch {
    return { created: 0, active: 0 };
  }
  const active = Math.max(
    created,
    mtime(dir),
    ...(gitdir ? ["HEAD", "index", path.join("logs", "HEAD")].map((f) => mtime(path.join(gitdir, f))) : []),
  );
  return { created, active };
}

/** The cutoff in ms for a rotation rule, or 0 when the rule is unusable. */
function ruleMs(rule) {
  const n = Number(rule && rule.olderThan);
  return n > 0 && UNIT_MS[rule.unit] ? n * UNIT_MS[rule.unit] : 0;
}

/**
 * Whether one checkout (a `worktreeSnapshot` row) is due for rotation now:
 * past the cutoff by the rule's clock, and no session running in it.
 */
function isStale(w, rule, now = Date.now()) {
  const cutoff = ruleMs(rule);
  const t = rule.basis === "created" ? w.created : w.active;
  return !!cutoff && !!t && !w.running && now - t > cutoff;
}

class WorktreeRotator extends EventEmitter {
  constructor(settings, bridge) {
    super();
    this.settings = settings;
    this.bridge = bridge;
    this.timer = null;
    this.running = false;
    // The checkouts the pass in flight is working through.
    this.due = [];
    // What the last pass did, for the Worktrees view.
    this.last = null;
  }

  rule() {
    return this.settings.get().rotate;
  }

  status() {
    return { running: this.running, due: this.due, last: this.last };
  }

  /** (Re)arm the timer from the current settings; off clears it. */
  schedule(delay = CHECK_MS) {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.rule().enabled) return;
    // Re-arm only if this timer is still the current one: stop() or a newer
    // schedule() during the pass must not be undone when it finishes.
    const timer = setTimeout(() => this.run().finally(() => this.timer === timer && this.schedule()), delay);
    this.timer = timer;
  }

  start() {
    this.schedule(FIRST_CHECK_MS);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * One pass: every stale checkout, one at a time. `manual` runs even with
   * rotation off (the view's "Rotate now"). Resolves the pass's summary.
   */
  async run({ manual = false } = {}) {
    const rule = this.rule();
    if (this.running || (!manual && !rule.enabled) || !ruleMs(rule)) return this.last;
    if (this.bridge.status.state !== "connected") return this.last;
    const now = Date.now();
    const due = this.bridge.worktreeSnapshot().worktrees.filter((w) => isStale(w, rule, now));
    this.running = true;
    this.due = due.map((w) => w.id);
    this.emit("status", this.status());
    const deleted = [];
    const kept = [];
    for (const w of due) {
      const r = await this.bridge.deleteWorktree(w.id, false);
      this.emit("progress", { id: w.id, ...r });
      if (r.ok) deleted.push(w.branch);
      else kept.push({ branch: w.branch, error: r.error || "could not delete" });
    }
    this.running = false;
    this.due = [];
    this.last = { ts: Date.now(), manual, deleted, kept };
    this.emit("status", this.status());
    if (deleted.length || kept.length) this.emit("rotated", this.last);
    return this.last;
  }
}

module.exports = { WorktreeRotator, worktreeTimes, isStale, ruleMs };
