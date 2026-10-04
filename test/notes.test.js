const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Notes } = require("../src/main/settings");

test("notes save, rescope, persist and delete", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-"));
  const notes = new Notes(dir);
  const a = notes.save({ body: "general thought" });
  assert.deepStrictEqual(a.scope, { kind: "general" });
  const b = notes.save({ scope: { kind: "ticket", id: "jira\u0000AQ-1", label: "AQ-1 · Fix it" }, body: "ticket note" });
  notes.save({ ...a, scope: { kind: "project", id: "p1", label: "web" } });
  notes.save({ scope: { kind: "bogus" }, body: "x" });

  const reread = new Notes(dir).list();
  assert.strictEqual(reread.length, 3);
  assert.strictEqual(reread.find((n) => n.id === a.id).scope.kind, "project");
  assert.strictEqual(reread.find((n) => n.body === "x").scope.kind, "general");

  notes.remove(b.id);
  assert.ok(!new Notes(dir).list().some((n) => n.id === b.id));
});
