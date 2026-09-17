import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayClient } from "../src/chat/gateway.js";

const TMP_DIRS = [];
process.on("exit", () => { for (const d of TMP_DIRS) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

function jsonRes(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
}

async function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

function tmpStateFile(obj) {
  const dir = mkdtempSync(join(tmpdir(), "mslxdff-gwport-"));
  TMP_DIRS.push(dir);
  const sf = join(dir, "state.json");
  writeFileSync(sf, JSON.stringify(obj));
  return sf;
}

test("默认 getPort：读 state.port（修复前 ESM 死 require 静默忽略，落到 defaultPort）", async () => {
  const sf = tmpStateFile({ token: "t", port: 8123 });
  await withEnv({ MSLXDFF_STATE_FILE: sf, MSLXDFF_PORT: undefined, MSLXDFF_CHAT_TRACE: "0" }, async () => {
    let url = null;
    const gw = createGatewayClient({
      fetchImpl: async (u) => { url = String(u); return jsonRes({ model: "big-pickle", choices: [{ message: { role: "assistant", content: "ok" } }] }); },
      loadToken: async () => "tok",
    });
    const r = await gw.chatViaGateway({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.ok, true);
    assert.ok(url.startsWith("http://127.0.0.1:8123/"), `默认端口应来自 state.port，实际 ${url}`);
  });
});

test("默认 getPort：state 无 port 时回落 env MSLXDFF_PORT", async () => {
  const sf = tmpStateFile({ token: "t" });
  await withEnv({ MSLXDFF_STATE_FILE: sf, MSLXDFF_PORT: "8777", MSLXDFF_CHAT_TRACE: "0" }, async () => {
    let url = null;
    const gw = createGatewayClient({
      fetchImpl: async (u) => { url = String(u); return jsonRes({ model: "big-pickle", choices: [{ message: { role: "assistant", content: "ok" } }] }); },
      loadToken: async () => "tok",
    });
    await gw.chatViaGateway({ messages: [{ role: "user", content: "hi" }] });
    assert.ok(url.startsWith("http://127.0.0.1:8777/"), `应回落 env 端口，实际 ${url}`);
  });
});

test("默认 getPort：state/env 皆无时回落 defaultPort 参数", async () => {
  const sf = tmpStateFile({ token: "t" });
  await withEnv({ MSLXDFF_STATE_FILE: sf, MSLXDFF_PORT: undefined, MSLXDFF_CHAT_TRACE: "0" }, async () => {
    let url = null;
    const gw = createGatewayClient({
      defaultPort: 8999,
      fetchImpl: async (u) => { url = String(u); return jsonRes({ model: "big-pickle", choices: [{ message: { role: "assistant", content: "ok" } }] }); },
      loadToken: async () => "tok",
    });
    await gw.chatViaGateway({ messages: [{ role: "user", content: "hi" }] });
    assert.ok(url.startsWith("http://127.0.0.1:8999/"), `应回落 defaultPort，实际 ${url}`);
  });
});
