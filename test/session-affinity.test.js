import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createUpstreamClient } from "../src/upstream.js";
import { createOpenCodeProvider } from "../src/providers/opencode.js";
import { createProviderDispatcher } from "../src/providers/dispatcher.js";

function stubServer(handler) {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}
function urlOf(srv) { return `http://127.0.0.1:${srv.address().port}`; }
async function closeSrv(srv) { await new Promise((r) => srv.close(r)); srv.closeAllConnections?.(); }

test("客户端会话头经 dispatcher→provider→upstream 透传为 x-opencode-session；无头时回退稳定哈希", async () => {
  const seen = [];
  const srv = await stubServer((req, res) => {
    seen.push(req.headers["x-opencode-session"]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  try {
    const upstream = createUpstreamClient({ baseUrl: urlOf(srv) });
    const provider = createOpenCodeProvider({ upstream });
    const dispatcher = createProviderDispatcher([provider], {
      isAllowed: () => true,
      getAllowedModels: () => [],
      getAllowAny: () => true,
    });
    const messages = [{ role: "system", content: "s" }, { role: "user", content: "u" }];

    await dispatcher.chat({ model: "big-pickle", messages, stream: false }, { sessionId: "ses_from_opencode_plugin_1" });
    assert.equal(seen[0], "ses_from_opencode_plugin_1", "客户端会话头必须原样透传给上游");

    await dispatcher.chat({ model: "big-pickle", messages, stream: false });
    await dispatcher.chat({ model: "big-pickle", messages, stream: false });
    assert.equal(seen[1], seen[2], "无会话头时内容哈希兜底必须稳定（非随机）");
    assert.notEqual(seen[1], "ses_from_opencode_plugin_1");
    assert.match(seen[1], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  } finally { await closeSrv(srv); }
});
