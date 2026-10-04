const test = require("node:test");
const assert = require("node:assert");
const { normalize, bucketFor } = require("../src/main/bitbucket-prs");

const me = { uuid: "{me}" };
const sam = { uuid: "{sam}", display_name: "Sam" };
const pr = (fields) => ({
  id: 7,
  title: "t",
  state: "OPEN",
  author: sam,
  links: { html: { href: "https://bitbucket.org/w/r/pull-requests/7" } },
  destination: { repository: { full_name: "w/r" } },
  reviewers: [],
  participants: [],
  ...fields,
});

test("with read:user, PRs sort into review / mine / closed", () => {
  assert.equal(bucketFor(pr({ reviewers: [me] }), me), "review");
  assert.equal(bucketFor(pr({ reviewers: [me], participants: [{ user: me, approved: true, state: "approved" }] }), me), null);
  assert.equal(bucketFor(pr({ author: me }), me), "mine");
  assert.equal(bucketFor(pr({ author: me, state: "MERGED" }), me), "closed");
  assert.equal(bucketFor(pr({}), me), null, "someone else's PR you're not on");
  assert.equal(bucketFor(pr({ state: "MERGED" }), me), null);
});

test("without read:user, every PR of the watched repos shows", () => {
  assert.equal(bucketFor(pr({}), null), "open");
  assert.equal(bucketFor(pr({ state: "DECLINED" }), null), "closed");
});

test("normalize maps state and review decision", () => {
  const p = normalize(pr({ author: me, participants: [{ user: sam, state: "changes_requested" }] }), me);
  assert.equal(p.bucket, "mine");
  assert.equal(p.repo, "w/r");
  assert.equal(p.reviewDecision, "CHANGES_REQUESTED");
  assert.equal(normalize(pr({ state: "DECLINED" }), null).state, "CLOSED");
});

test("an account id from Jira is enough to tell your PRs from everyone else's", () => {
  const me = { account_id: "712020:me" };
  const pr = (author, reviewers = []) => ({ state: "OPEN", author, reviewers, participants: [] });
  assert.equal(bucketFor(pr({ account_id: "712020:me" }), me), "mine");
  assert.equal(bucketFor(pr({ account_id: "712020:sam" }, [{ account_id: "712020:me" }]), me), "review");
  assert.equal(bucketFor(pr({ account_id: "712020:sam" }), me), null);
});
