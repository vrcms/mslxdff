import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.js";
import { createRouter } from "../src/routes.js";

function stubWorkbuddy() {
  const srv = createServer((req, res) => {
    let body="";
    req.on("data",c=>body+=c);
    req.on("end",()=>{
      if (req.url.includes("/v2/chat/completions")) {
        const j = JSON.parse(body || "{}");
        // workbuddy forces stream true
        if (j.stream !== true) { res.writeHead(400); res.end("stream must be true"); return; }
        if (j.model !== "hy3") { res.writeHead(400); res.end("model mismatch"); return; }
        res.writeHead(200, {"Content-Type":"text/event-stream"});
        res.end("data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n");
      } else if (req.url.includes("/console/enterprises/personal/models")) {
        res.writeHead(200, {"Content-Type":"application/json"});
        res.end(JSON.stringify({
          data: {
            models: [
              { id:"hy3", credits:"x0.00 credits", vendor:"tencent" },
              { id:"glm-5.3", credits:"x0.79 credits" },
              { id:"hunyuan-chat", credits:"" },
            ],
            agents: [{name:"cli", models:["hy3","hunyuan-chat"]}]
          }
        }));
      } else {
        res.writeHead(404); res.end("not found "+req.url);
      }
    });
  });
  return new Promise(r=>srv.listen(0,"127.0.0.1",()=>r(srv)));
}
function urlOf(srv){ return `http://127.0.0.1:${srv.address().port}`; }
async function closeSrv(srv){ await new Promise(r=>srv.close(r)); srv.closeAllConnections?.(); }

test("E2E workbuddy via mslxdff /v1/chat (HTTP) — dispatcher + router", async () => {
  const wb = await stubWorkbuddy();
  const wbUrl = urlOf(wb);
  // temporary state file with workbuddy provider
  const file = mkdtempSync(join(tmpdir(),"mslxdff-wb-e2e-")) + "/state.json";
  const { saveProviderConfig } = await import("../src/state.js");
  saveProviderConfig("workbuddy", { baseUrl: wbUrl, keys:["k1"], auths:[{uid:"u1", domain:"www.codebuddy.cn", enterpriseId:"", refreshToken:"rt1"}], allowedModels:["hy3","hunyuan-chat"] }, {file});
  const { loadToken } = await import("../src/state.js");
  const { token } = await loadToken({file});
  process.env.MSLXDFF_STATE_FILE = file;
  const { createWorkbuddyProvider } = await import("../src/providers/workbuddy.js");
  const { createProviderDispatcher } = await import("../src/providers/dispatcher.js");
  const wbProvider = createWorkbuddyProvider({ baseUrl: wbUrl, apiKeys:["k1"], auths:[{uid:"u1", domain:"www.codebuddy.cn", enterpriseId:"", refreshToken:"rt1"}], file });
  const opencodeStub = { id:"opencode", chat: async()=>new Response(JSON.stringify({choices:[]}),{status:200, headers:{"Content-Type":"application/json"}}), listModels: async()=>[ {id:"big-pickle"} ], close: async()=>{} };
  const dispatcher = createProviderDispatcher([opencodeStub, wbProvider]);
  const router = createRouter({ token, upstream: dispatcher });
  const srv = startServer({ router, signals:false }, 0);
  await srv.ready();
  const port = srv.server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method:"POST",
      headers:{ Authorization:`Bearer ${token}`, "Content-Type":"application/json" },
      body: JSON.stringify({ model:"workbuddy/hy3", messages:[{role:"user", content:"hi"}], stream:false })
    });
    if (r.status !== 200) {
      const txt = await r.text();
      assert.fail(`expected 200 got ${r.status} body ${txt.slice(0,500)}`);
    }
    const ct = r.headers.get("content-type") || "";
    assert.ok(ct.includes("text/event-stream"), `workbuddy forces SSE, got ${ct}`);
    const txt = await r.text();
    assert.ok(txt.includes("hello"), txt.slice(0,200));
  } finally {
    await srv.close(); srv.server.closeAllConnections?.();
    await closeSrv(wb);
    delete process.env.MSLXDFF_STATE_FILE;
  }
});

test("E2E workbuddy models aggregation via dispatcher (allowlist)", async () => {
  const wb = await stubWorkbuddy();
  const wbUrl = urlOf(wb);
  const file = mkdtempSync(join(tmpdir(),"mslxdff-wb-e2e-")) + "/state.json";
  const { saveProviderConfig } = await import("../src/state.js");
  saveProviderConfig("workbuddy", { baseUrl: wbUrl, keys:["k1"], auths:[{uid:"u1", domain:"www.codebuddy.cn", enterpriseId:"", refreshToken:"rt1"}], allowedModels:["hy3"] }, {file});
  process.env.MSLXDFF_STATE_FILE = file;
  const { createWorkbuddyProvider } = await import("../src/providers/workbuddy.js");
  const { createProviderDispatcher } = await import("../src/providers/dispatcher.js");
  const wbProvider = createWorkbuddyProvider({ baseUrl: wbUrl, apiKeys:["k1"], auths:[{uid:"u1", domain:"www.codebuddy.cn", enterpriseId:"", refreshToken:"rt1"}], file });
  const opencodeStub = { id:"opencode", listModels: async()=>[ {id:"big-pickle"} ], close: async()=>{}, chat: async()=>new Response("{}",{status:200}) };
  const d = createProviderDispatcher([opencodeStub, wbProvider]);
  const list = await d.listModels();
  const ids = list.map(m=>m.id);
  assert.ok(ids.includes("workbuddy/hy3"), `should include hy3 ${ids}`);
  assert.ok(!ids.includes("workbuddy/glm-5.3"), "glm-5.3 filtered by allowlist");
  await d.close();
  await closeSrv(wb);
  delete process.env.MSLXDFF_STATE_FILE;
});
