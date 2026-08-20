import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createUpstreamClient } from "../src/upstream.js";

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
    assert.equal(seen["authorization"],"Bearer public");
    assert.equal(seen["x-opencode-project"],"global");
    assert.match(seen["x-opencode-session"], /^ses_[0-9a-f]{32}$/);
    assert.match(seen["x-opencode-request"], /^msg_[0-9a-f]{32}$/);
    assert.equal(seen["user-agent"],"opencode");
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
    for(const r of reqs) assert.match(r, /^msg_[0-9a-f]{32}$/);
  } finally{ await closeSrv(srv); }
});
