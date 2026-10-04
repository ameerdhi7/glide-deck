const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { isStale, ruleMs, worktreeTimes } = require("../src/main/rotator");

const DAY = 86400_000;
const now = Date.parse("2026-09-29T12:00:00Z");

test("a rule's cutoff in ms, zero when unusable", () => {
  assert.equal(ruleMs({ olderThan: 2, unit: "days" }), 2 * DAY);
  assert.equal(ruleMs({ olderThan: 1, unit: "weeks" }), 7 * DAY);
  assert.equal(ruleMs({ olderThan: 0, unit: "days" }), 0);
  assert.equal(ruleMs({ olderThan: 3, unit: "months" }), 0);
});

test("stale by last activity or by creation, never with a running session", () => {
  const w = { created: now - 10 * DAY, active: now - DAY, running: 0 };
  const rule = { olderThan: 3, unit: "days", basis: "activity" };
  assert.equal(isStale(w, rule, now), false);
  assert.equal(isStale(w, { ...rule, basis: "created" }, now), true);
  assert.equal(isStale({ ...w, running: 1 }, { ...rule, basis: "created" }, now), false);
  // A folder that's gone has no times: leave it to the daemon.
  assert.equal(isStale({ created: 0, active: 0, running: 0 }, rule, now), false);
});

test("reads a linked worktree's creation and git activity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rot-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
  git("worktree", "add", "-q", "-b", "feat", path.join(dir, "wt"));
  const t = worktreeTimes(path.join(dir, "wt"));
  assert.ok(t.created > 0 && t.active >= t.created);
  assert.deepEqual(worktreeTimes(path.join(dir, "missing")), { created: 0, active: 0 });
  fs.rmSync(dir, { recursive: true, force: true });
});
