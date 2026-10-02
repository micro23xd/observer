// mcp.test.mjs — unit tests for the MCP protocol layer (no server, stub api).

import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMcpMessage, TOOLS, PROTOCOL_VERSION } from "./mcp.mjs";

const stubApi = {
  sessions: async () => [{ sessionId: "s1", repo: "demo", status: "working" }],
  digest: async (since) => ({ sinceMs: 1800000, rows: [{ sessionId: "s1", since }] }),
  session: async (id) => (id === "s1" ? { sessionId: "s1", turns: 3 } : null),
  sessionEvents: async (id, types, limit) => (id === "s1" ? [{ kind: "tool", tool: "Edit", types, limit }] : null),
  transcriptText: async (id, max) => (id === "s1" ? { text: "raw\nlines", truncated: false, bytes: 9, max } : null),
  // Steering stubs: steerCreate echoes an armed directive; throws when disabled.
  steerCreate: (req) => {
    if (req.sessionId === "disabled") throw new Error("steering is disabled (master switch is off)");
    return { id: "d7", status: req.kind === "block_tool" ? "proposed" : "armed", ...req };
  },
  steerList: (sid) => [{ id: "d7", sessionId: sid || "s1", kind: "nudge", status: "armed" }],
  steerCancel: (id) => (id === "d7" ? { id, status: "cancelled" } : null),
};

test("initialize: echoes protocolVersion and advertises tools capability", async () => {
  const r = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, stubApi);
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, "2025-06-18");
  assert.deepEqual(r.result.capabilities, { tools: {} });
  assert.equal(r.result.serverInfo.name, "observer");
});

test("initialize: falls back to pinned version when client omits it", async () => {
  const r = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, stubApi);
  assert.equal(r.result.protocolVersion, PROTOCOL_VERSION);
});

test("notifications get no response", async () => {
  assert.equal(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, stubApi), null);
});

test("tools/list returns the 10 tools (5 read + 3 steer + 2 control) with schemas", async () => {
  const r = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, stubApi);
  assert.equal(r.result.tools.length, 10);
  assert.deepEqual(r.result.tools.map((t) => t.name).sort(),
    ["cancel_steer", "list_sessions", "list_steers", "recent_activity", "release_control",
      "request_control", "session_events", "session_summary", "session_transcript", "steer_session"]);
  for (const t of r.result.tools) assert.equal(t.inputSchema.type, "object");
  assert.equal(TOOLS.length, 10);
});

test("tools/call list_sessions wraps api output as text content", async () => {
  const r = await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_sessions", arguments: {} } }, stubApi);
  assert.equal(r.result.content[0].type, "text");
  assert.deepEqual(JSON.parse(r.result.content[0].text), [{ sessionId: "s1", repo: "demo", status: "working" }]);
  assert.ok(!r.result.isError);
});

test("tools/call forwards arguments", async () => {
  const r = await handleMcpMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "session_events", arguments: { session_id: "s1", types: "tool", limit: 10 } } }, stubApi);
  const ev = JSON.parse(r.result.content[0].text);
  assert.equal(ev[0].types, "tool");
  assert.equal(ev[0].limit, 10);
});

test("tools/call missing required arg => isError", async () => {
  const r = await handleMcpMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "session_summary", arguments: {} } }, stubApi);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /missing required argument: session_id/);
});

test("tools/call unknown session => isError", async () => {
  const r = await handleMcpMessage({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "session_summary", arguments: { session_id: "nope" } } }, stubApi);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /no such session/);
});

test("tools/call unknown tool => isError", async () => {
  const r = await handleMcpMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "delete_everything", arguments: {} } }, stubApi);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /unknown tool/);
});

test("unknown method with id => -32601", async () => {
  const r = await handleMcpMessage({ jsonrpc: "2.0", id: 8, method: "resources/list" }, stubApi);
  assert.equal(r.error.code, -32601);
});

test("transcript tool annotates truncation", async () => {
  const api = { ...stubApi, transcriptText: async () => ({ text: "tail", truncated: true, bytes: 64 }) };
  const r = await handleMcpMessage({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "session_transcript", arguments: { session_id: "s1" } } }, api);
  assert.match(r.result.content[0].text, /truncated to last 64 bytes/);
});

test("steer_session passes the api result through (id/status armed for a nudge)", async () => {
  const r = await handleMcpMessage({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "steer_session", arguments: { session_id: "s1", kind: "nudge", text: "add tests" } } }, stubApi);
  assert.ok(!r.result.isError);
  const o = JSON.parse(r.result.content[0].text);
  assert.equal(o.id, "d7");
  assert.equal(o.status, "armed");
});

test("steer_session block_tool comes back proposed (needs approval)", async () => {
  const r = await handleMcpMessage({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "steer_session", arguments: { session_id: "s1", kind: "block_tool", text: "no migrations", tool_match: "Bash" } } }, stubApi);
  assert.equal(JSON.parse(r.result.content[0].text).status, "proposed");
});

test("steer_session surfaces 'disabled' as an isError result", async () => {
  const r = await handleMcpMessage({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "steer_session", arguments: { session_id: "disabled", kind: "nudge", text: "x" } } }, stubApi);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /steering is disabled/);
});

test("steer_session missing kind => isError", async () => {
  const r = await handleMcpMessage({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "steer_session", arguments: { session_id: "s1", text: "x" } } }, stubApi);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /missing required argument: kind/);
});

test("list_steers forwards session_id filter", async () => {
  const r = await handleMcpMessage({ jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "list_steers", arguments: { session_id: "s9" } } }, stubApi);
  assert.equal(JSON.parse(r.result.content[0].text)[0].sessionId, "s9");
});

test("cancel_steer unknown id => isError", async () => {
  const r = await handleMcpMessage({ jsonrpc: "2.0", id: 15, method: "tools/call", params: { name: "cancel_steer", arguments: { id: "nope" } } }, stubApi);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /no such directive/);
});
