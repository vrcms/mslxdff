import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createWorkbuddyProvider } from "../src/providers/workbuddy.js";
import { clearBalanceCache, setCachedBalance } from "../src/providers/workbuddy-balance.js";

function stub(handler){
  const srv = createServer((req,res)=>{
    let body=""; req.on("data",c=>body+=c); req.on("end",()=> handler(req,res,body));
  });
  return new Promise(r=> srv.listen(0,"127.0.0.1",()=>r(srv)));
}
function urlOf(srv){ return `http://127.0.0.1:${srv.address().port}`; }
async function closeSrv(srv){ await new Promise(r=>srv.close(r)); srv.closeAllConnections?.(); }

test("auto rotation: A 402 insufficient -> B succeeds with uid header", async()=>{
  clearBalanceCache();
  let calls=[];
  const srv = await stub((req,res,body)=>{
    const uid=req.headers["x-user-id"];
    calls.push(uid);
    if(uid==="uidA"){
      res.writeHead(402,{"Content-Type":"application/json"});
      res.end(JSON.stringify({code:402, msg:"insufficient balance"}));
    } else if(uid==="uidB"){
      res.writeHead(200,{"Content-Type":"text/event-stream"});
      res.end("data: ok\n\n");
    } else {
      res.writeHead(500); res.end("unknown");
    }
  });
  try{
    const p = createWorkbuddyProvider({
      baseUrl: urlOf(srv),
      apiKeys:["kA","kB"],
      auths:[{uid:"uidA", domain:"www.codebuddy.cn", refreshToken:""},{uid:"uidB", domain:"www.codebuddy.cn", refreshToken:""}],
      cooldownMs: 30000,
    });
    const res = await p.chat({model:"hy3", messages:[]});
    assert.equal(res.status,200);
    assert.equal(res.headers.get("x-mslxdff-workbuddy-uid"), "uidB");
    assert.deepEqual(calls, ["uidA","uidB"]);
    await p.close();
  } finally { await closeSrv(srv); }
});

test("balance cache 0 skips A without request", async()=>{
  clearBalanceCache();
  setCachedBalance("uidA", {total:0, dailyPacks:0, activeCount:0, nextExpire:null, fetchedAt: Date.now()});
  let calls=[];
  const srv = await stub((req,res)=>{
    calls.push(req.headers["x-user-id"]);
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    res.end("data: ok\n\n");
  });
  try{
    const p = createWorkbuddyProvider({
      baseUrl: urlOf(srv),
      apiKeys:["kA","kB"],
      auths:[{uid:"uidA", domain:"www.codebuddy.cn", refreshToken:""},{uid:"uidB", domain:"www.codebuddy.cn", refreshToken:""}],
    });
    const res = await p.chat({model:"hy3", messages:[]});
    assert.equal(res.headers.get("x-mslxdff-workbuddy-uid"), "uidB");
    assert.deepEqual(calls, ["uidB"]);
    await p.close();
  } finally { await closeSrv(srv); }
});

test("manual pin header forces C", async()=>{
  clearBalanceCache();
  let seenUid=null;
  const srv = await stub((req,res)=>{
    seenUid=req.headers["x-user-id"];
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    res.end("data: ok\n\n");
  });
  try{
    const p = createWorkbuddyProvider({
      baseUrl: urlOf(srv),
      apiKeys:["kA","kB","kC"],
      auths:[{uid:"uidA"},{uid:"uidB"},{uid:"uidC"}],
    });
    const res = await p.chat({model:"hy3", messages:[]}, {workbuddyUid:"uidC"});
    assert.equal(seenUid,"uidC");
    assert.equal(res.headers.get("x-mslxdff-workbuddy-uid"), "uidC");
    await p.close();
  } finally { await closeSrv(srv); }
});

test("manual pin not found returns 403 uid-not-found", async()=>{
  clearBalanceCache();
  const srv = await stub((req,res)=>{ res.writeHead(200); res.end("ok"); });
  try{
    const p = createWorkbuddyProvider({ baseUrl: urlOf(srv), apiKeys:["kA"], auths:[{uid:"uidA"}]});
    const res = await p.chat({model:"hy3", messages:[]}, {workbuddyUid:"uidX"});
    assert.equal(res.status,403);
    assert.equal(res.headers.get("x-mslxdff-workbuddy-reason"), "uid-not-found");
    await p.close();
  } finally { await closeSrv(srv); }
});
