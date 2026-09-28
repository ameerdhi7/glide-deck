const test = require("node:test");
const assert = require("node:assert/strict");
const { WebSocketServer } = require("ws");
const { NebulaBridge } = require("../src/main/bridge");

const id = { connection: "demo", native: "1" };
const ticket = { id, key: "AQ-1", summary: "Fix login", status_name: "To Do", evidence: [] };

test("bridge: first snapshot is a silent baseline, later deltas become events", async () => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on("listening", r));
  const port = wss.address().port;
  const send = (sock, kind, payload) => sock.send(JSON.stringify({ kind, payload }));
  wss.on("connection", (sock) => {
    send(sock, "tickets/snapshot", {
      tickets: [ticket],
      connections: [{ id: "demo", label: "Demo", health: "verified" }],
      inbox: [],
    });
    setTimeout(() => send(sock, "tickets/upsert", { ticket: { ...ticket, workflow: "ready", change_summary: "retry added" } }), 30);
    setTimeout(() => send(sock, "connections/status", { id: "demo", label: "Demo", health: "error", detail: "401" }), 60);
    setTimeout(() => send(sock, "tickets/removed", { id, reason: "unassigned" }), 90);
  });

  const bridge = new NebulaBridge({ get: () => ({ bridgePort: port, nebulaBin: "" }) });
  bridge.port = port;
  const events = [];
  bridge.on("events", (e) => events.push(...e));
  const connected = new Promise((r) => bridge.on("status", (s) => s.state === "connected" && r()));
  bridge.connect();
  await connected;
  await new Promise((r) => setTimeout(r, 200));

  assert.deepEqual(
    events.map((e) => e.kind),
    ["workflow-ready", "connection-error", "ticket-removed"],
  );
  assert.equal(events[0].body, "retry added");
  assert.equal(bridge.tickets.size, 0, "the removed ticket left the board");
  bridge.stop();
  wss.close();
});
