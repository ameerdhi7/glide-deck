const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Connections, parseConfigPaths, normalize, tokenHint, envName } = require("../src/main/connections");

function fixture(config = {}, local) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conns-"));
  const paths = { config: path.join(dir, "config.json"), local: path.join(dir, "config.local.json") };
  fs.writeFileSync(paths.config, JSON.stringify(config));
  if (local) fs.writeFileSync(paths.local, JSON.stringify(local));
  const c = new Connections({ get: () => ({ nebulaBin: "" }) });
  c.paths = paths;
  const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
  return { c, paths, read };
}

test("parses nebula config path output", () => {
  const out = "config.json         /a b/config.json\nconfig.local.json   /a b/config.local.json\nagent_presets.json  /x\n";
  assert.deepStrictEqual(parseConfigPaths(out), { config: "/a b/config.json", local: "/a b/config.local.json" });
  assert.strictEqual(parseConfigPaths("nope"), null);
});

test("save splits the token into the local layer and keeps every other key", async () => {
  const { c, paths, read } = fixture({ theme: "ocean", connections: [] }, { editor: "vim" });
  const id = await c.save(
    { kind: "jira", label: "Work Jira", base_url: "https://acme.atlassian.net/jira/software/", account: "me@acme.io" },
    { token: "secret-token-1234" },
  );
  assert.strictEqual(id, "work-jira");
  const cfg = read(paths.config);
  assert.strictEqual(cfg.theme, "ocean");
  assert.deepStrictEqual(cfg.connections, [{ id: "work-jira", kind: "jira", label: "Work Jira", base_url: "https://acme.atlassian.net", account: "me@acme.io" }]);
  assert.ok(!JSON.stringify(cfg).includes("secret-token"));
  const local = read(paths.local);
  assert.strictEqual(local.editor, "vim");
  assert.strictEqual(local.secrets.connections["work-jira"].token, "secret-token-1234");
  assert.strictEqual(fs.statSync(paths.local).mode & 0o777, 0o600);

  const listed = (await c.list()).connections[0];
  assert.strictEqual(listed.hasToken, true);
  assert.strictEqual(listed.tokenHint, "••••1234");
  assert.strictEqual(listed.token, undefined);
});

test("an edit keeps the stored token and keys the form doesn't show", async () => {
  const { c, paths, read } = fixture(
    { connections: [{ id: "bb", kind: "bitbucket", label: "BB", account: "old", board_id: "7" }] },
    { secrets: { connections: { bb: { token: "keep-me" } } } },
  );
  await c.save({ id: "bb", kind: "bitbucket", label: "BB", account: "new", repos: "acme/api, acme/web" }, { token: "" });
  const conn = read(paths.config).connections[0];
  assert.strictEqual(conn.account, "new");
  assert.strictEqual(conn.board_id, "7");
  assert.deepStrictEqual(conn.repos, ["acme/api", "acme/web"]);
  assert.strictEqual(read(paths.local).secrets.connections.bb.token, "keep-me");
});

test("a new connection never takes an existing id; remove drops its token", async () => {
  const { c, paths, read } = fixture({ connections: [{ id: "linear", kind: "agent" }] });
  const id = await c.save({ kind: "agent", label: "Linear", source: "Linear", mcp_servers: "linear" });
  assert.strictEqual(id, "linear-2");
  await c.save({ id: "linear-2", kind: "agent", label: "Linear" }, { token: "t" });
  await c.remove("linear-2");
  assert.deepStrictEqual(read(paths.config).connections.map((x) => x.id), ["linear"]);
  assert.deepStrictEqual(read(paths.local).secrets.connections, {});
});

test("an unreadable config is refused, not overwritten", async () => {
  const { c, paths } = fixture();
  fs.writeFileSync(paths.config, "{ broken");
  await assert.rejects(c.save({ kind: "jira", label: "x" }), /not valid JSON/);
  assert.strictEqual(fs.readFileSync(paths.config, "utf8"), "{ broken");
});

test("helpers", () => {
  assert.strictEqual(envName("aau-jira"), "NEBULA_TOKEN_AAU_JIRA");
  assert.strictEqual(tokenHint(""), "");
  assert.strictEqual(tokenHint("short"), "••••");
  assert.strictEqual(normalize({ kind: "agent", harness: "codex", source: "Asana" }).harness, "codex");
  assert.strictEqual(normalize({ kind: "weird" }).kind, "jira");
});
