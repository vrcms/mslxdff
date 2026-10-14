import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createUpstreamClient } from "../src/upstream.js";
import { counterFromTimeHex } from "../src/opencode-identity.js";

function stubServer(handler) {
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}
function urlOf(srv) { return `http://127.0.0.1:${srv.address().port}`; }
async function closeSrv(srv) { await new Promise((r)=>srv.close(r)); srv.closeAllConnections?.(); }

test("upstream emits 9Router-parity headers (session/request/project/UA)", async () => {
  let seen;
  const srv = await stubServer((req,res,body)=>{
    seen=req.headers;
    res.writeHead(200,{"Content-Type":"application/json"});
    res.end("{}");
  });
  try{
    const client = createUpstreamClient({ baseUrl:urlOf(srv) });
    await client.chat({ model:"deepseek-v4-flash-free", messages:[{role:"user",content:"hi"}], stream:true });
    assert.equal(seen["x-opencode-client"],"desktop");
    assert.equal(seen["authorization"],"");
    assert.equal(seen["x-opencode-project"],"global");
    assert.match(seen["x-opencode-session"], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assert.match(seen["x-opencode-request"], /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assert.match(seen["user-agent"], /^opencode\/\d+\.\d+\.\d+$/);
    assert.equal(seen["accept"],"text/event-stream");
  } finally{ await closeSrv(srv); }
});

test("Accept is */* for non-stream, text/event-stream for stream (default stream)", async () => {
  const cases = [
    { body:{stream:false}, expect:"*/*" },
    { body:{stream:true}, expect:"text/event-stream" },
    { body:{}, expect:"text/event-stream" }, // default true (9Router parity)
  ];
  for(const {body,expect} of cases){
    let seen;
    const srv = await stubServer((req,res)=>{
      seen=req.headers;
      res.writeHead(200,{"Content-Type":"application/json"});res.end("{}");
    });
    try{
      const client=createUpstreamClient({baseUrl:urlOf(srv)});
      await client.chat(body);
      assert.equal(seen.accept, expect, `body=${JSON.stringify(body)}`);
    } finally{ await closeSrv(srv); }
  }
});

test("x-opencode-request is unique per call, session format stable", async () => {
  const reqs=[];
  const srv=await stubServer((req,res)=>{
    reqs.push(req.headers["x-opencode-request"]);
    res.writeHead(200,{"Content-Type":"application/json"});res.end("{}");
  });
  try{
    const client=createUpstreamClient({baseUrl:urlOf(srv)});
    await client.chat({stream:false});
    await client.chat({stream:false});
    assert.equal(reqs.length,2);
    assert.notEqual(reqs[0],reqs[1]);
    for(const r of reqs) assert.match(r, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  } finally{ await closeSrv(srv); }
});

test("同会话 session 稳定（system+首条 user 哈希）、多轮不漂移、跨会话分散", async () => {
  const seen=[];
  const srv=await stubServer((req,res)=>{
    seen.push(req.headers["x-opencode-session"]);
    res.writeHead(200,{"Content-Type":"application/json"});res.end("{}");
  });
  try{
    const client=createUpstreamClient({baseUrl:urlOf(srv)});
    const base=[{role:"system",content:"sys-prompt"},{role:"user",content:"第一问"}];
    await client.chat({model:"m",stream:false,messages:base});
    await client.chat({model:"m",stream:false,messages:[...base,{role:"assistant",content:"答复"},{role:"user",content:"追问"}]});
    await client.chat({model:"m",stream:false,messages:[{role:"system",content:"sys-prompt"},{role:"user",content:"另一个会话"}]});
    assert.equal(seen[0],seen[1],"同一会话多轮必须稳定（上游粘性路由/缓存亲和依赖它）");
    assert.notEqual(seen[0],seen[2],"不同会话应分散");
    for(const s of seen) assert.match(s, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  } finally{ await closeSrv(srv); }
});

test("无 messages 时回退进程级固定 session（不再每请求随机）", async () => {
  const seen=[];
  const srv=await stubServer((req,res)=>{
    seen.push(req.headers["x-opencode-session"]);
    res.writeHead(200,{"Content-Type":"application/json"});res.end("{}");
  });
  try{
    const client=createUpstreamClient({baseUrl:urlOf(srv)});
    await client.chat({stream:false});
    await client.chat({stream:false});
    assert.equal(seen[0],seen[1]);
  } finally{ await closeSrv(srv); }
});

test("id 时间段是倒序时钟：低 12 位反解出的 counter 必须落在免费层接受窗口 [0,63]", async () => {
  // 2026-10-13 现网取证：正序时钟 id 形状过正则但反解出 counter=4094 → 403 FreeTierError。
  // 这条断言锁的就是那件事——闸门只认反解回来的 per-ms 计数，不认形状。
  let seen;
  const srv=await stubServer((req,res)=>{
    seen=req.headers;
    res.writeHead(200,{"Content-Type":"application/json"});res.end("{}");
  });
  try{
    const client=createUpstreamClient({baseUrl:urlOf(srv)});
    await client.chat({stream:false});
    for (const pair of [["session", seen["x-opencode-session"]], ["request", seen["x-opencode-request"]]]) {
      const [name, id] = pair;
      const hex = String(id).slice(4, 16);
      assert.match(hex, /^[0-9a-f]{12}$/, `${name} 时间段必须 12 位小写 hex`);
      const c = counterFromTimeHex(hex);
      assert.ok(c >= 0 && c <= 63, `${name} 反解 counter=${c} 越出免费层窗口 [0,63]（上游回 403 FreeTierError）`);
    }
  } finally{ await closeSrv(srv); }
});
