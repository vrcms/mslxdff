#!/usr/bin/env node
// workbuddy-checkin.js — WorkBuddy 每日签到 100 积分（可单独跑，也被 token-auto 自动调用）
// 接口：POST https://www.codebuddy.cn/v2/billing/meter/daily-checkin
//      + https://copilot.tencent.com/v2/billing/meter/daily-checkin（双域容灾，任意成功即算成功）
// 奖励：每次签到新增 1 个 "CodeBuddy个人版国内运营裂变包" 100 credits，有效期 30 天（滚动累计，当前你有 29×100+500 体验版≈3400）
// 已签到返回 {"code":10001,"msg":"今天已签到，请明天再来"} 视为成功（幂等）
// 用法：node workbuddy-checkin.js [--json]  |  可加入 Windows 任务计划每天 09:00 跑一次

import fs from "node:fs";
import path from "node:path";
import { compatFetch } from "./src/compat.js";

const AUTH_DIR = process.env.WORKBUDDY_AUTH_DIR || path.join(process.cwd(), "auths");
const asJson = process.argv.includes("--json");

const ENDPOINTS = [
  "https://www.codebuddy.cn/v2/billing/meter/daily-checkin",
  "https://copilot.tencent.com/v2/billing/meter/daily-checkin",
];

function log(...a) { if (!asJson) console.log(...a); }

async function checkinOne({ uid, at, domain, enterpriseId }) {
  const headers = {
    Authorization: `Bearer ${at}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-User-Id": uid,
    "X-Domain": domain || "www.codebuddy.cn",
    "X-Product": "SaaS",
    "User-Agent": "CLI/2.115.0 WorkBuddy/2.115.0",
    Origin: "https://www.codebuddy.cn",
    Referer: "https://www.codebuddy.cn/",
    ...(enterpriseId ? { "X-Enterprise-Id": enterpriseId } : {}),
  };
  let last = null;
  for (const url of ENDPOINTS) {
    try {
      const res = await compatFetch(url, { method: "POST", headers, body: "{}" });
      const text = await res.text();
      let j; try { j = JSON.parse(text); } catch { j = { code: res.status, msg: text.slice(0, 200) }; }
      last = { url, status: res.status, body: j };
      // code 0 = 刚签到成功；10001 = 今天已签到（幂等成功）；其他则试下一个域
      if (j.code === 0 || j.code === 10001 || j.msg?.includes("已签到")) return { ok: true, ...last, already: j.code === 10001 };
      // 401/403 说明 token 过期，抛给上层去 refresh
      if (res.status === 401 || res.status === 403) return { ok: false, needRefresh: true, ...last };
    } catch (e) {
      last = { url, error: e.message };
    }
  }
  return { ok: false, ...last };
}

async function getBalance({ uid, at, domain }) {
  try {
    const body = JSON.stringify({
      PageNumber: 1, PageSize: 100, ProductCode: "p_tcaca", Status: [0, 3],
      PackageEndTimeRangeBegin: "2026-08-01 00:00:00",
      PackageEndTimeRangeEnd: "2030-01-01 00:00:00",
    });
    const r = await compatFetch("https://www.codebuddy.cn/v2/billing/meter/get-user-resource", {
      method: "POST",
      headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json", "X-User-Id": uid, "X-Domain": domain || "www.codebuddy.cn" },
      body,
    });
    const j = await r.json();
    const accs = j.data?.Response?.Data?.Accounts || [];
    const active = accs.filter(a => a.Status === 0);
    const total = active.reduce((s, a) => s + Number(a.CycleCapacityRemainPrecise || 0), 0);
    const dailyPacks = active.filter(a => a.PackageName?.includes("裂变包") && a.CycleCapacitySizePrecise === "100");
    return { total: total.toFixed(2), activeCount: active.length, dailyPacks: dailyPacks.length, nextExpire: active.sort((a,b)=> new Date(a.CycleEndTime)-new Date(b.CycleEndTime))[0]?.CycleEndTime };
  } catch { return null; }
}

async function processOne(f) {
  const full = path.join(AUTH_DIR, f);
  const doc = JSON.parse(fs.readFileSync(full, "utf8"));
  const uid = doc.account.uid, at = doc.auth.accessToken, domain = doc.auth.domain || "www.codebuddy.cn", ent = doc.account.enterpriseId || "";
  let refreshed = false;
  try {
    const exp = doc.auth.expiresAt || 0;
    if (exp && exp - Date.now()/1000 < 3600 && doc.auth.refreshToken) {
      const rr = await compatFetch("https://copilot.tencent.com/v2/plugin/auth/token/refresh", {
        method: "POST",
        headers: { "Content-Type":"application/json", Authorization:`Bearer ${at}`, "X-Refresh-Token": doc.auth.refreshToken, "X-User-Id": uid, "X-Domain": domain, "User-Agent":"CLI/2.115.0", Origin:"https://www.codebuddy.cn" },
        body: "{}",
      });
      const jj = await rr.json();
      if (jj.code === 0 && jj.data.accessToken) {
        doc.auth.accessToken = jj.data.accessToken;
        doc.auth.refreshToken = jj.data.refreshToken || doc.auth.refreshToken;
        try { doc.auth.expiresAt = JSON.parse(Buffer.from(jj.data.accessToken.split(".")[1],"base64").toString()).exp; } catch {}
        const tmp = full + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(doc,null,2), {mode:0o600}); fs.renameSync(tmp, full);
        refreshed = true;
        log(`[checkin] ${uid} token 已自动续期`);
      }
    }
  } catch {}
  const curAt = refreshed ? JSON.parse(fs.readFileSync(full,"utf8")).auth.accessToken : at;
  const r = await checkinOne({ uid, at: curAt, domain, enterpriseId: ent });
  const bal = await getBalance({ uid, at: curAt, domain });
  const row = { file: f, uid, ok: r.ok, already: !!r.already, code: r.body?.code, msg: r.body?.msg || "", balance: bal, url: r.url, refreshed };
  if (r.ok) {
    log(`${r.already ? "✓ 已签到" : "✓ 签到成功"} [${uid.slice(0,8)}] ${r.body?.msg || ""} — 余额 ${bal?.total || "?"} credits (${bal?.dailyPacks || 0} 个 100包 + 体验版), 下次过期 ${bal?.nextExpire || "?"}`);
    if (r.body?.data) log(`  奖励: ${JSON.stringify(r.body.data).slice(0,180)}`);
  } else {
    log(`✗ 签到失败 [${uid.slice(0,8)}] ${r.body?.msg || r.error || JSON.stringify(r.body).slice(0,180)} (${r.url || ""})`);
  }
  return row;
}

async function main() {
  if (!fs.existsSync(AUTH_DIR)) throw new Error(`auths 不存在: ${AUTH_DIR}，先 node workbuddy-token-auto.js`);
  const files = fs.readdirSync(AUTH_DIR).filter(f => f.startsWith("workbuddy-") && f.endsWith(".json"));
  if (!files.length) throw new Error("无 workbuddy-*.json，先跑 token 流程");
  // 并行限 3
  const results = [];
  const concurrency = 3;
  let idx = 0;
  async function worker() {
    while (idx < files.length) {
      const i = idx++;
      const row = await processOne(files[i]);
      results[i] = row;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));
  // 按 uid 排序保证报表稳定
  results.sort((a,b)=> String(a.uid).localeCompare(String(b.uid)));
  if (!asJson) {
    // 汇总表头
    if (results.length > 1) {
      console.log(`\n--- 汇总 ${results.length} 账号 ---`);
      for (const r of results) {
        const bal = r.balance;
        console.log(`  ${r.uid.slice(0,8)}  ${r.ok ? (r.already ? "已签到" : "成功") : "失败"}  total=${bal?.total||"?"}  packs=${bal?.dailyPacks||0}  expire=${bal?.nextExpire||"-"}  ${r.refreshed?"(refreshed)":""}`);
      }
    }
  }
  if (asJson) console.log(JSON.stringify({ results }, null, 2));
  if (results.some(r => !r.ok)) process.exitCode = 1;
}

main().catch(e => { console.error(e.message); process.exit(1); });
