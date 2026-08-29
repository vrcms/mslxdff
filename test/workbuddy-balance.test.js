import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fetchBalance, getCachedBalance, clearBalanceCache, setCachedBalance } from "../src/providers/workbuddy-balance.js";

function stub(handler) {
  const srv = createServer((req, res) => {
    let body=""; req.on("data", c=>body+=c); req.on("end", ()=> handler(req,res,body));
  });
  return new Promise(r=> srv.listen(0,"127.0.0.1",()=>r(srv)));
}
function urlOf(srv){ return `http://127.0.0.1:${srv.address().port}`; }
async function closeSrv(srv){ await new Promise(r=>srv.close(r)); srv.closeAllConnections?.(); }

test("fetchBalance aggregates Status 0 and counts dailyPacks and nextExpire", async()=>{
  clearBalanceCache();
  const srv = await stub((req,res)=>{
    assert.equal(req.url, "/v2/billing/meter/get-user-resource");
    assert.equal(req.headers["x-user-id"], "uid1");
    res.writeHead(200,{"Content-Type":"application/json"});
    res.end(JSON.stringify({ data:{ Response:{ Data:{ Accounts:[
      { Status:0, CycleCapacityRemainPrecise:"100", CycleCapacitySizePrecise:"100", PackageName:"CodeBuddy个人版国内运营裂变包", CycleEndTime:"2026-09-01 00:00:00" },
      { Status:0, CycleCapacityRemainPrecise:"50", CycleCapacitySizePrecise:"500", PackageName:"CodeBuddy个人版体验版", CycleEndTime:"2026-08-30 00:00:00" },
      { Status:3, CycleCapacityRemainPrecise:"100", CycleCapacitySizePrecise:"100", PackageName:"裂变包", CycleEndTime:"2026-08-29 00:00:00" },
    ] } } } }));
  });
  try{
    const b = await fetchBalance({ uid:"uid1", key:"k", domain:"www.codebuddy.cn", baseUrl: urlOf(srv) });
    assert.equal(b.total, 150);
    assert.equal(b.totalStr, "150.00");
    assert.equal(b.dailyPacks, 1);
    assert.equal(b.activeCount, 2);
    assert.equal(b.nextExpire, "2026-08-30 00:00:00");
    // cached
    const cached = getCachedBalance("uid1");
    assert.deepEqual(cached.total, 150);
  } finally { await closeSrv(srv); }
});

test("fetchBalance returns null on 500", async()=>{
  clearBalanceCache();
  const srv = await stub((req,res)=>{ res.writeHead(500); res.end("err"); });
  try{
    const b = await fetchBalance({ uid:"uid1", key:"k", baseUrl: urlOf(srv) });
    assert.equal(b, null);
  } finally { await closeSrv(srv); }
});

test("getCachedBalance TTL 5min", async()=>{
  clearBalanceCache();
  setCachedBalance("u2", { total:99, dailyPacks:1, activeCount:1, nextExpire:null });
  assert.ok(getCachedBalance("u2"));
  // simulate expired by tweaking fetchedAt
  const m = (await import("../src/providers/workbuddy-balance.js")).getBalanceCache();
  const v = m.get("u2"); v.fetchedAt = Date.now() - 6*60*1000;
  assert.equal(getCachedBalance("u2"), null);
});
