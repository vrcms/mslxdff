#!/usr/bin/env node
// workbuddy-models.js — 列出 WorkBuddy 官方模型、价格、CLI 可用集（低消耗优先排序）
// 用法：node workbuddy-models.js [--json]
// 读 auths/workbuddy-*.json 的 token 调 https://copilot.tencent.com/console/enterprises/personal/models
// 输出按 credits 升序（0 消耗最前），方便选最省积分的模型做测试

import fs from "node:fs";
import path from "node:path";
import { compatFetch } from "./src/compat.js";

const AUTH_DIR = process.env.WORKBUDDY_AUTH_DIR || path.join(process.cwd(), "auths");
const asJson = process.argv.includes("--json");

function findAuth() {
  if (!fs.existsSync(AUTH_DIR)) throw new Error(`auths 目录不存在: ${AUTH_DIR}，先 node workbuddy-token-auto.js`);
  const files = fs.readdirSync(AUTH_DIR).filter(f => f.startsWith("workbuddy-") && f.endsWith(".json"));
  if (!files.length) throw new Error("无 workbuddy-*.json，先跑 token 流程");
  return path.join(AUTH_DIR, files[0]);
}

function creditsValue(c) {
  if (!c || !String(c).trim()) return 0;
  const m = String(c).match(/x([\d.]+)/);
  return m ? parseFloat(m[1]) : 999;
}

async function main() {
  const authFile = findAuth();
  const j = JSON.parse(fs.readFileSync(authFile, "utf8"));
  const at = j.auth.accessToken, uid = j.account.uid, domain = j.auth.domain || "www.codebuddy.cn";
  const headers = {
    Authorization: `Bearer ${at}`,
    Accept: "application/json",
    "X-User-Id": uid,
    "X-Domain": domain,
    "X-Product": "SaaS",
    "User-Agent": "CLI/2.115.0 WorkBuddy/2.115.0",
    Origin: "https://www.codebuddy.cn",
    Referer: "https://www.codebuddy.cn/",
  };
  const res = await compatFetch("https://copilot.tencent.com/console/enterprises/personal/models", { headers });
  if (!res.ok) throw new Error(`models ${res.status} ${await res.text().then(t=>t.slice(0,300))}`);
  const obj = await res.json();
  const models = obj.data.models;
  const cliModels = new Set(obj.data.agents.find(a => a.name === "cli")?.models || []);

  // 按 credits 升序
  const sorted = [...models].sort((a, b) => creditsValue(a.credits) - creditsValue(b.credits));

  if (asJson) {
    console.log(JSON.stringify({ models: sorted, cliModels: [...cliModels] }, null, 2));
    return;
  }

  console.log(`共 ${models.length} 模型，CLI 可用 ${cliModels.size} 个（* 标注），按积分升序（0 最省）：\n`);
  console.log("credits   | CLI | id                 | maxIn/maxOut | vendor | name");
  console.log("----------|-----|--------------------|--------------|--------|----------------");
  for (const m of sorted) {
    const inCli = cliModels.has(m.id) ? "*" : " ";
    const cred = (m.credits && String(m.credits).trim()) ? String(m.credits).padEnd(9) : "x0.00    ";
    console.log(`${cred} |  ${inCli}  | ${m.id.padEnd(18)} | ${String(m.maxInputTokens||"-").padStart(6)}/${String(m.maxOutputTokens||"-").padEnd(6)} | ${String(m.vendor||"-").padEnd(6)} | ${m.name}`);
  }
  console.log("\n* = CLI agent 可用（直接 --model 指定）");
  console.log("测试建议：hy3(x0.00) / hy4-preview(x0.00) / hunyuan-chat(0) / hunyuan-2.0-thinking(x0.04) / glm-5.3-flash(x0.06) 最省；");
  console.log("避免直接用 glm-5.3(x0.79) / deepseek-v4-pro(x0.51) / kimi-k3-1(x1.62) / default(x2.20) 测试。");

  // 顺带查余额
  try {
    const body = JSON.stringify({
      PageNumber: 1, PageSize: 100, ProductCode: "p_tcaca", Status: [0, 3],
      PackageEndTimeRangeBegin: new Date().toISOString().slice(0,19).replace("T"," "),
      PackageEndTimeRangeEnd: new Date(Date.now()+365*101*24*3600*1000).toISOString().slice(0,19).replace("T"," "),
    });
    const r2 = await compatFetch("https://www.codebuddy.cn/v2/billing/meter/get-user-resource", {
      method: "POST",
      headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json", "X-User-Id": uid, "X-Domain": domain },
      body,
    });
    const t2 = await r2.json();
    const accounts = t2.data?.Response?.Data?.Accounts || [];
    const active = accounts.filter(a => a.Status === 0);
    const totalRemain = active.reduce((s, a) => s + Number(a.CycleCapacityRemainPrecise || a.CycleCapacityRemain || 0), 0);
    console.log(`\n余额：${active.length} 个有效套餐，合计剩余 ${totalRemain.toFixed(2)} credits（含 500 体验版 + 各赠送包）`);
    for (const a of active.slice(0,4)) {
      console.log(`  - ${a.PackageName} 剩余 ${a.CycleCapacityRemainPrecise} / ${a.CycleCapacitySizePrecise} (至 ${a.CycleEndTime})`);
    }
  } catch {}
}

main().catch(e => { console.error(e.message); process.exit(1); });
