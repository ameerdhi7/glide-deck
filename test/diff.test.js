const test = require("node:test");
const assert = require("node:assert/strict");
const { diffTicket, diffSnapshot, diffConnection, diffPrs, ticketKey } = require("../src/main/diff");
const { progressOf, tally, needsYou } = require("../src/shared/progress");
const { collect } = require("../src/main/prs");

const id = { connection: "demo", native: "10001" };
const base = { id, key: "AQ-1", summary: "Fix login", status_name: "To Do", evidence: [], delivery: "no_pr" };

const kinds = (events) => events.map((e) => e.kind);

test("a ticket seen for the first time is announced as assigned", () => {
  const ev = diffTicket(undefined, base);
  assert.deepEqual(kinds(ev), ["ticket-new"]);
  assert.equal(ev[0].target.id, ticketKey(id));
});

test("workflow transitions become events with the right level", () => {
  const running = { ...base, workflow: "running", stage: "implement" };
  assert.deepEqual(kinds(diffTicket(base, running)), ["workflow-running"]);
  const needs = diffTicket(running, { ...running, workflow: "needs_input" });
  assert.equal(needs[0].level, "warn");
  const ready = diffTicket(running, { ...running, workflow: "ready", change_summary: "added retry" });
  assert.equal(ready[0].level, "success");
  assert.equal(ready[0].body, "added retry", "a ready card carries what changed");
});

test("an unchanged ticket produces nothing", () => {
  assert.deepEqual(diffTicket(base, { ...base }), []);
});

test("stage moves, Jira status moves, evidence and delivery are all reported", () => {
  const a = { ...base, workflow: "running", stage: "implement" };
  assert.deepEqual(kinds(diffTicket(a, { ...a, stage: "verify" })), ["stage"]);
  assert.deepEqual(kinds(diffTicket(base, { ...base, status_name: "In Progress" })), ["status"]);
  const ev = diffTicket(base, { ...base, evidence: [{ kind: "checks", state: "failed" }] });
  assert.deepEqual(kinds(ev), ["evidence-checks-failed"]);
  assert.equal(ev[0].level, "error");
  // running → running evidence is not news; only terminal states are
  assert.deepEqual(diffTicket(base, { ...base, evidence: [{ kind: "checks", state: "running" }] }), []);
  assert.deepEqual(kinds(diffTicket(base, { ...base, delivery: "merged" })), ["delivery-merged"]);
});

test("a reconnect snapshot reports changes and removals made while away", () => {
  const prev = new Map([
    [ticketKey(id), base],
    [ticketKey({ connection: "demo", native: "2" }), { ...base, id: { connection: "demo", native: "2" }, key: "AQ-2" }],
  ]);
  const ev = diffSnapshot(prev, [{ ...base, workflow: "ready" }]);
  assert.deepEqual(kinds(ev).sort(), ["ticket-removed", "workflow-ready"]);
});

test("connection health: errors and recoveries only", () => {
  const ok = { id: "jira", label: "Jira", health: "verified" };
  assert.deepEqual(diffConnection(undefined, ok), []);
  assert.deepEqual(kinds(diffConnection(ok, { ...ok, health: "error", detail: "401" })), ["connection-error"]);
  assert.deepEqual(kinds(diffConnection({ ...ok, health: "error" }, ok)), ["connection-ok"]);
  assert.deepEqual(diffConnection(ok, { ...ok, health: "authenticated" }), []);
});

const pr = {
  url: "https://github.com/o/r/pull/7",
  number: 7,
  title: "AQ-1 fix login",
  repo: "o/r",
  state: "OPEN",
  draft: false,
  bucket: "mine",
  reviewDecision: null,
  checks: "PENDING",
  comments: 0,
};

test("PR changes: review, checks, comments, merge, ready-for-review", () => {
  const prev = new Map([[pr.url, pr]]);
  assert.deepEqual(diffPrs(prev, [pr]), []);
  assert.deepEqual(kinds(diffPrs(prev, [{ ...pr, checks: "FAILURE" }])), ["pr-checks-failure"]);
  assert.deepEqual(kinds(diffPrs(prev, [{ ...pr, reviewDecision: "APPROVED" }])), ["pr-review-approved"]);
  assert.deepEqual(kinds(diffPrs(prev, [{ ...pr, comments: 2 }])), ["pr-comments"]);
  assert.equal(diffPrs(prev, [{ ...pr, comments: 2 }])[0].title, "o/r#7: 2 new comments");
  assert.deepEqual(kinds(diffPrs(prev, [{ ...pr, state: "MERGED", bucket: "closed" }])), ["pr-merged"]);
  const draft = new Map([[pr.url, { ...pr, draft: true }]]);
  assert.deepEqual(kinds(diffPrs(draft, [pr])), ["pr-ready"]);
});

test("PR newly in view: review requests and new PRs announce, old closed ones don't", () => {
  const empty = new Map();
  assert.deepEqual(kinds(diffPrs(empty, [{ ...pr, bucket: "review" }])), ["pr-review-requested"]);
  assert.deepEqual(kinds(diffPrs(empty, [pr])), ["pr-new"]);
  assert.deepEqual(diffPrs(empty, [{ ...pr, state: "MERGED", bucket: "closed" }]), []);
});

test("collect de-duplicates across lists, review wins", () => {
  const node = {
    url: pr.url,
    number: 7,
    title: "t",
    state: "OPEN",
    isDraft: false,
    repository: { nameWithOwner: "o/r" },
    comments: { totalCount: 3 },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  };
  const list = collect({ review: { nodes: [node] }, mine: { nodes: [node, {}] }, closed: { nodes: [] } });
  assert.equal(list.length, 1);
  assert.equal(list[0].bucket, "review");
  assert.equal(list[0].checks, "SUCCESS");
  assert.equal(list[0].comments, 3);
});

test("progress maps workflow and delivery onto the step road", () => {
  assert.equal(progressOf(base).step, 0);
  assert.equal(progressOf({ ...base, workflow: "queued" }).step, 1);
  assert.deepEqual(progressOf({ ...base, workflow: "running", stage: "verify" }), { step: 2, tone: "active", label: "verify" });
  assert.equal(progressOf({ ...base, workflow: "failed" }).tone, "err");
  assert.equal(progressOf({ ...base, workflow: "ready" }).step, 3);
  assert.equal(progressOf({ ...base, workflow: "ready", evidence: [{ kind: "review", state: "passed" }] }).step, 4);
  assert.equal(progressOf({ ...base, workflow: "ready", delivery: "open" }).step, 5);
  assert.equal(progressOf({ ...base, delivery: "merged" }).step, 6);
  assert.equal(progressOf({ ...base, status_category: "done" }).step, 6);
});

test("tally buckets every live ticket exactly once and skips removed ones", () => {
  const list = [
    base,
    { ...base, workflow: "running" },
    { ...base, workflow: "needs_input" },
    { ...base, workflow: "ready" },
    { ...base, delivery: "merged" },
    { ...base, removed_reason: "unassigned" },
  ];
  const { buckets, total } = tally(list);
  assert.equal(total, 5);
  assert.deepEqual(buckets, { done: 1, pr: 0, ready: 1, active: 1, attention: 1, queued: 0, todo: 1 });
  assert.equal(needsYou({ ...base, unread_pr_activity: 1 }), true);
});
