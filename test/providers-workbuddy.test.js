import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createWorkbuddyProvider } from "../src/providers/workbuddy.js";

function stub(handler) {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}
function urlOf(srv) { return `http://127.0.0.1:${srv.address().port}`; }
async function closeSrv(srv) { await new Promise((r) => srv.close(r)); srv.closeAllConnections?.(); }

test("workbuddy chat posts to /v2/chat/completions with stream true and workbuddy headers", async () => {
  let seen = null;
  let seenBody = null;
  const srv = await stub((req, res, body) => {
    seen = req.headers;
    seenBody = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end("data: ok\n\n");
  });
  try {
    const p = createWorkbuddyProvider({
      baseUrl: urlOf(srv),
      apiKeys: ["k-test"],
      auths: [{ uid: "uid1", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "rt1" }],
    });
    const res = await p.chat({ model: "hy3", messages: [{ role: "user", content: "hi" }], stream: false });
    assert.equal(res.status, 200);
    assert.equal(seen["authorization"], "Bearer k-test");
    assert.equal(seen["x-user-id"], "uid1");
    assert.equal(seen["x-domain"], "www.codebuddy.cn");
    assert.equal(seen["x-product"], "SaaS");
    assert.ok(seen["user-agent"].includes("WorkBuddy"));
    assert.equal(seenBody.stream, true, "must force stream true");
    assert.equal(seenBody.model, "hy3");
    await p.close();
  } finally { await closeSrv(srv); }
});

test("workbuddy chat 401 triggers refresh and replays", async () => {
  let chatCalls = 0;
  let refreshSeen = null;
  const srv = await stub((req, res, body) => {
    if (req.url.includes("/v2/plugin/auth/token/refresh")) {
      refreshSeen = req.headers;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, data: { accessToken: "k-new", refreshToken: "rt-new", expiresIn: 5184000 } }));
      return;
    }
    chatCalls++;
    if (chatCalls === 1) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 401 }));
    } else {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: refreshed\n\n");
    }
  });
  try {
    const p = createWorkbuddyProvider({
      baseUrl: urlOf(srv),
      apiKeys: ["k-old"],
      auths: [{ uid: "uid1", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "rt-old" }],
    });
    const res = await p.chat({ model: "hy3", messages: [] });
    assert.equal(res.status, 200);
    assert.equal(refreshSeen["x-refresh-token"], "rt-old");
    assert.equal(refreshSeen["x-user-id"], "uid1");
    assert.equal(chatCalls, 2);
    await p.close();
  } finally { await closeSrv(srv); }
});

test("workbuddy listModels maps and sorts by credits and prefixes", async () => {
  const srv = await stub((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: {
        models: [
          { id: "glm-5.3", credits: "x0.79 credits", vendor: "zhipu" },
          { id: "hy3", credits: "x0.00 credits", vendor: "tencent" },
          { id: "deepseek-v4-flash", credits: "x0.17 credits" },
          { id: "hunyuan-chat", credits: "" },
        ],
        agents: [{ name: "cli", models: ["hy3"] }],
      },
    }));
  });
  try {
    const p = createWorkbuddyProvider({
      baseUrl: urlOf(srv),
      apiKeys: ["k1"],
      auths: [{ uid: "u", domain: "www.codebuddy.cn", enterpriseId: "", refreshToken: "rt" }],
    });
    const list = await p.listModels();
    assert.deepEqual(list.map((m) => m.id), ["workbuddy/hy3", "workbuddy/hunyuan-chat", "workbuddy/deepseek-v4-flash", "workbuddy/glm-5.3"]);
    // second call cached
    const list2 = await p.listModels();
    assert.equal(list2.length, 4);
    await p.close();
  } finally { await closeSrv(srv); }
});

test("dispatcher routes workbuddy/hy3 to workbuddy and strips prefix", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createProviderDispatcher } = await import("../src/providers/dispatcher.js");
  function tmpStateFile() { const d=mkdtempSync(join(tmpdir(),"mslxdff-wb-disp-")); return join(d,"state.json"); }
  const file = tmpStateFile();
  process.env.MSLXDFF_STATE_FILE = file;
  const seen=[];
  const workbuddy = {
    id:"workbuddy",
    chat: async (body)=>{ seen.push(body.model); return new Response(JSON.stringify({ok:true}),{status:200}); },
    listModels: async ()=>[ {id:"workbuddy/hy3"}, {id:"workbuddy/glm-5.3-flash"} ],
    close: async()=>{},
  };
  const opencode = { id:"opencode", chat: async()=>new Response("{}",{status:200}), listModels: async()=>[ {id:"a-free"} ], close: async()=>{} };
  const d = createProviderDispatcher([opencode, workbuddy]);
  const res = await d.chat({model:"workbuddy/hy3", messages:[]});
  assert.equal(res.status,200);
  assert.deepEqual(seen, ["hy3"]);
  await d.close();
  delete process.env.MSLXDFF_STATE_FILE;
});

test("dispatcher filters workbuddy listModels by allowlist", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createProviderDispatcher } = await import("../src/providers/dispatcher.js");
  const { saveProviderAllowedModels } = await import("../src/state.js");
  function tmpStateFile() { const d=mkdtempSync(join(tmpdir(),"mslxdff-wb-disp-")); return join(d,"state.json"); }
  const file = tmpStateFile();
  process.env.MSLXDFF_STATE_FILE = file;
  saveProviderAllowedModels("workbuddy", ["hy3"], {file});
  const workbuddy = {
    id:"workbuddy",
    listModels: async()=>[ {id:"workbuddy/hy3"}, {id:"workbuddy/glm-5.3-flash"}, {id:"workbuddy/hy4-preview"} ],
    close: async()=>{},
    chat: async()=>new Response("{}",{status:200}),
  };
  const opencode = { id:"opencode", listModels: async()=>[ {id:"a-free"} ], close: async()=>{}, chat: async()=>new Response("{}",{status:200}) };
  const d = createProviderDispatcher([opencode, workbuddy]);
  const list = await d.listModels();
  assert.deepEqual(list.map(m=>m.id), ["a-free", "workbuddy/hy3"]);
  await d.close();
  delete process.env.MSLXDFF_STATE_FILE;
});

test("dispatcher returns 403 for workbuddy allowlist violation", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createProviderDispatcher } = await import("../src/providers/dispatcher.js");
  const { saveProviderAllowedModels } = await import("../src/state.js");
  function tmpStateFile() { const d=mkdtempSync(join(tmpdir(),"mslxdff-wb-disp-")); return join(d,"state.json"); }
  const file = tmpStateFile();
  process.env.MSLXDFF_STATE_FILE = file;
  saveProviderAllowedModels("workbuddy", ["hy3"], {file});
  const workbuddy = { id:"workbuddy", chat: async()=>new Response("{}",{status:200}), listModels: async()=>[], close: async()=>{} };
  const opencode = { id:"opencode", chat: async()=>new Response("{}",{status:200}), listModels: async()=>[], close: async()=>{} };
  const d = createProviderDispatcher([opencode, workbuddy]);
  const res = await d.chat({model:"workbuddy/glm-5.3-flash", messages:[]});
  assert.equal(res.status,403);
  assert.equal(res.headers.get("x-mslxdff-allowlist"), "1");
  const j = await res.json();
  assert.match(j.error, /not allowed/);
  await d.close();
  delete process.env.MSLXDFF_STATE_FILE;
});
