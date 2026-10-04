const test = require("node:test");
const assert = require("node:assert/strict");
const { linkPrs, keysOf, tkey } = require("../src/shared/links");
const { parseClaude, collectAnswer, serversFor, prompt, SCHEMA } = require("../src/main/agent-prs");

const t1 = { id: { connection: "c", native: "1" }, key: "AQ-1" };
const t2 = { id: { connection: "c", native: "2" }, key: "AQ-2" };

test("a PR links to tickets named in its title, branch or the provider's own list", () => {
  const prs = [
    { url: "https://x/1", title: "AQ-1: fix login", headRef: "" },
    { url: "https://x/2", title: "tidy", headRef: "feat/aq-2-tidy" },
    { url: "https://x/3", title: "no key", headRef: "main", tickets: ["aq-1"] },
    { url: "https://x/4", title: "ZZ-9 elsewhere", headRef: "" },
  ];
  const { prsByTicket, ticketsByPr } = linkPrs([t1, t2], prs);
  assert.deepEqual(prsByTicket.get(tkey(t1.id)).map((p) => p.url), ["https://x/1", "https://x/3"]);
  assert.deepEqual(ticketsByPr.get("https://x/2"), [t2]);
  assert.equal(ticketsByPr.has("https://x/4"), false, "a key not on the board links nothing");
});

test("a removed ticket takes no new links", () => {
  const { ticketsByPr } = linkPrs([{ ...t1, removed_reason: "gone" }], [{ url: "u", title: "AQ-1" }]);
  assert.equal(ticketsByPr.size, 0);
  assert.deepEqual(keysOf({ title: "AQ-1 and AQ-1", headRef: "aq-3" }), ["AQ-1", "AQ-3"]);
});

test("claude's structured output is read past shell noise", () => {
  const answer = { error: null, prs: [] };
  const out = `zsh noise\n${JSON.stringify({ is_error: false, result: "", structured_output: answer })}\n`;
  assert.deepEqual(parseClaude(out), answer);
  assert.throws(() => parseClaude(JSON.stringify({ is_error: true, result: "Not logged in" })), /Not logged in/);
});

test("an agent's answer is normalized, de-duplicated and bucketed", () => {
  const pr = (over) => ({
    url: "https://bb/1", number: 1, title: "AQ-1 fix", repo: "w/r", author: "me", state: "OPEN", draft: false,
    bucket: "mine", updatedAt: null, mergedAt: null, headRef: null, reviewDecision: null, checks: null,
    comments: 0, additions: 0, deletions: 0, tickets: ["AQ-1"], ...over,
  });
  const list = collectAnswer({
    prs: [pr({}), pr({ bucket: "review" }), pr({ url: "javascript:alert(1)" }), pr({ url: "https://bb/2", bucket: "odd", state: "MERGED" })],
  });
  assert.deepEqual(list.map((p) => [p.url, p.bucket]), [["https://bb/1", "review"], ["https://bb/2", "closed"]]);
  assert.equal(list[0].headRef, "");
});

test("MCP servers come from settings, else from the code host's name", () => {
  assert.deepEqual(serversFor({ mcpServers: "mcp__bitbucket, github" }), ["bitbucket", "github"]);
  assert.deepEqual(serversFor({ source: "Bitbucket" }), ["bitbucket"]);
  assert.deepEqual(serversFor({ source: "Gitea" }), []);
});

test("the prompt carries the ticket keys and the schema is strict", () => {
  assert.match(prompt({ source: "Bitbucket" }, ["AQ-1", "AQ-2"]), /AQ-1, AQ-2/);
  const item = SCHEMA.properties.prs.items;
  assert.deepEqual([...item.required].sort(), Object.keys(item.properties).sort());
});
