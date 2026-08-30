import { test } from "node:test";
import assert from "node:assert/strict";
import { createProviderDispatcher } from "../src/providers/dispatcher.js";
import { createWorkbuddyProvider } from "../src/providers/workbuddy.js";
import { createServer } from "node:http";

function stub(handler){
  const srv=createServer((req,res)=>{ let b=""; req.on("data",c=>b+=c); req.on("end",()=> handler(req,res,b));});
  return new Promise(r=> srv.listen(0,"127.0.0.1",()=>r(srv)));
}
function urlOf(srv){ return `http://127.0.0.1:${srv.address().port}`; }
async function closeSrv(srv){ await new Promise(r=>srv.close(r)); srv.closeAllConnections?.(); }

test("dispatcher workbuddy/<uid>:model 剥 uid 并透传 workbuddyUid", async()=>{
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { saveProviderAllowedModels } = await import("../src/state.js");
  const file=mkdtempSync(join(tmpdir(),"mslxdff-wb-uid-"))+"/state.json";
  const prev=process.env.MSLXDFF_STATE_FILE;
  process.env.MSLXDFF_STATE_FILE=file;
  saveProviderAllowedModels("workbuddy",["hy3"],{file});
  let seenUid=null, seenModel=null;
  const wbSrv = await stub((req,res,body)=>{
    seenUid=req.headers["x-user-id"];
    seenModel=JSON.parse(body).model;
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    res.end("data: ok\n\n");
  });
  try{
    const wbUrl=urlOf(wbSrv);
    const p=createWorkbuddyProvider({ baseUrl: wbUrl, apiKeys:["kA","kB"], auths:[{uid:"uidA"},{uid:"uidB"}]});
    const d=createProviderDispatcher([{id:"opencode", chat: async()=>new Response("{}",{status:200}), listModels: async()=>[]}, p]);
    const res=await d.chat({model:"workbuddy/uidB:hy3", messages:[]});
    assert.equal(res.status,200);
    assert.equal(seenUid,"uidB");
    assert.equal(seenModel,"hy3");
    assert.equal(res.headers.get("x-mslxdff-workbuddy-uid"),"uidB");
    await d.close();
  } finally { await closeSrv(wbSrv); if(prev) process.env.MSLXDFF_STATE_FILE=prev; else delete process.env.MSLXDFF_STATE_FILE; }
});

test("dispatcher header x-mslxdff-workbuddy-uid 优先于 model 前缀", async()=>{
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { saveProviderAllowedModels } = await import("../src/state.js");
  const file=mkdtempSync(join(tmpdir(),"mslxdff-wb-uid-"))+"/state.json";
  const prev=process.env.MSLXDFF_STATE_FILE;
  process.env.MSLXDFF_STATE_FILE=file;
  saveProviderAllowedModels("workbuddy",["hy3"],{file});
  let seenUid=null;
  const wbSrv = await stub((req,res)=>{
    seenUid=req.headers["x-user-id"];
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    res.end("data: ok\n\n");
  });
  try{
    const wbUrl=urlOf(wbSrv);
    const p=createWorkbuddyProvider({ baseUrl: wbUrl, apiKeys:["kA","kB"], auths:[{uid:"uidA"},{uid:"uidB"}]});
    const d=createProviderDispatcher([{id:"opencode", chat: async()=>new Response("{}",{status:200}), listModels: async()=>[]}, p]);
    // model 前缀是 uidA，但 header 指定 uidB，应以 header 为准
    const res=await d.chat({model:"workbuddy/uidA:hy3", messages:[]}, {workbuddyUid:"uidB"});
    assert.equal(seenUid,"uidB");
    await d.close();
  } finally { await closeSrv(wbSrv); if(prev) process.env.MSLXDFF_STATE_FILE=prev; else delete process.env.MSLXDFF_STATE_FILE; }
});

test("dispatcher workbuddy allowlist 仍对剥后 raw 生效", async()=>{
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { saveProviderAllowedModels } = await import("../src/state.js");
  const file=mkdtempSync(join(tmpdir(),"mslxdff-wb-uid-"))+"/state.json";
  process.env.MSLXDFF_STATE_FILE=file;
  saveProviderAllowedModels("workbuddy",["hy3"],{file});
  let called=false;
  const p={ id:"workbuddy", chat: async()=>{ called=true; return new Response("{}",{status:200}); }, listModels: async()=>[], close: async()=>{}};
  const d=createProviderDispatcher([{id:"opencode", chat: async()=>new Response("{}",{status:200}), listModels: async()=>[]}, p]);
  const res=await d.chat({model:"workbuddy/uidA:glm-5.3", messages:[]});
  assert.equal(res.status,403);
  assert.equal(res.headers.get("x-mslxdff-allowlist"),"1");
  assert.equal(called,false);
  await d.close();
  delete process.env.MSLXDFF_STATE_FILE;
});
