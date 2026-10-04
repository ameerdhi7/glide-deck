const test = require("node:test");
const assert = require("node:assert");
const { pick } = require("../src/main/sound");

const notify = { sound: true, sounds: { tickets: "Glass", prs: "Ping", connections: "Basso", worktrees: "" } };

test("the most urgent event with a sound picks it", () => {
  const events = [
    { category: "prs", level: "info" },
    { category: "connections", level: "error" },
  ];
  assert.equal(pick(events, notify), "Basso");
});

test("a kind set to None stays quiet", () => {
  assert.equal(pick([{ category: "worktrees", level: "warn" }], notify), "");
  assert.equal(pick([{ category: "worktrees", level: "warn" }, { category: "tickets", level: "info" }], notify), "Glass");
});

test("the master switch silences everything", () => {
  assert.equal(pick([{ category: "tickets", level: "info" }], { ...notify, sound: false }), "");
});
