#!/usr/bin/env node
// workbuddy-token-auto.js — 一键自动化获取 WorkBuddy token（流程化，Windows 免 DevTools）
// 流程：whistle MITM(8899) → codebuddy CLI 走代理发 "hi" → 从 whistle 抓 Authorization/refresh → 写 auths/workbuddy-<uid>.json → 停 whistle
// 下次刷新只需调 POST /v2/plugin/auth/token/refresh，无需再走 MITM。Node>=20 零依赖（需已装 WorkBuddy 5.3.14 且已登录）
// 用法：node workbuddy-token-auto.js
// 可选 env：WORKBUDDY_AUTH_DIR=./auths  WHISTLE_PORT=8899

import fs from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";

const AUTH_DIR = process.env.WORKBUDDY_AUTH_DIR || path.join(process.cwd(), "auths");
const PORT = Number(process.env.WHISTLE_PORT) || 8899;
function findCodebuddyBin() {
  const candidates = [
    process.env.CODEBUDDY_BIN,
    "D:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy",
    "C:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy",
    path.join(process.env.LOCALAPPDATA || "", "Programs/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy"),
    path.join(process.env.APPDATA || "", "WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy"),
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  // 兜底：where codebuddy
  try { const out = execSync("where codebuddy", { encoding: "utf8" }).split("\n")[0].trim(); if (out && fs.existsSync(out)) return out; } catch {}
  return candidates[0];
}
const CODEBUDDY_BIN = findCodebuddyBin();

function log(...a) { console.log(...a); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function whistleRunning() {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/cgi-bin/get-data`); return r.ok; } catch { return false; }
}

async function ensureWhistleInstalled() {
  try { execSync("npx whistle --version", { stdio: "pipe", timeout: 8000 }); return; } catch {}
  log("[flow] 未检测到 whistle，正在 npx 安装...");
  execSync("npm i -g whistle", { stdio: "inherit", timeout: 60000 });
}
async function startWhistle() {
  if (await whistleRunning()) { log(`[flow] whistle 已在 ${PORT} 运行`); return; }
  await ensureWhistleInstalled();
  log(`[flow] 启动 whistle :${PORT} ... (首次会装 RootCA，需点一次确认)`);
  execSync(`npx whistle start --port ${PORT}`, { stdio: "pipe", timeout: 15000 });
  for (let i = 0; i < 15; i++) {
    await sleep(800);
    if (await whistleRunning()) { log(`[flow] whistle 就绪`); return; }
  }
  throw new Error("whistle 启动超时");
}

async function stopWhistle() {
  try { execSync(`npx whistle stop`, { stdio: "pipe", timeout: 8000 }); log("[flow] whistle 已停"); } catch {}
}

async function runCodebuddyViaProxy() {
  log(`[flow] 用 codebuddy 走代理发 "hi" 触发 token...`);
  const env = {
    ...process.env,
    HTTP_PROXY: `http://127.0.0.1:${PORT}`,
    HTTPS_PROXY: `http://127.0.0.1:${PORT}`,
    http_proxy: `http://127.0.0.1:${PORT}`,
    https_proxy: `http://127.0.0.1:${PORT}`,
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
  };
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CODEBUDDY_BIN, "-p", "--model", "auto", "hi"], { env, stdio: "pipe" });
    let out = "", err = "";
    child.stdout.on("data", d => out += d);
    child.stderr.on("data", d => err += d);
    child.on("close", code => resolve({ code, out, err }));
    child.on("error", reject);
    setTimeout(() => { try { child.kill(); } catch {} }, 20000);
  });
}

async function captureRefreshToken() {
  // 从 whistle 拿最近一次 /v2/plugin/auth/token/refresh 的请求头与响应
  for (let i = 0; i < 10; i++) {
    await sleep(600);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/cgi-bin/get-data?url=https://copilot.tencent.com/v2/plugin/auth/token/refresh`);
      const j = await res.json();
      const data = j?.data?.data || j?.data;
      for (const id of Object.keys(data || {}).reverse()) {
        const v = data[id];
        if (!v?.req?.headers) continue;
        const reqAt = v.req.headers["authorization"] || v.req.headers["Authorization"] || "";
        const xRefresh = v.req.headers["x-refresh-token"] || v.req.headers["X-Refresh-Token"] || "";
        const uid = v.req.headers["x-user-id"] || v.req.headers["X-User-Id"] || "";
        const domain = v.req.headers["x-domain"] || v.req.headers["X-Domain"] || "www.codebuddy.cn";
        const ent = v.req.headers["x-enterprise-id"] || "";
        if (!reqAt || !xRefresh) continue;
        // res body base64 解
        let newAt = "", newRt = "", expiresIn = 0;
        try {
          const decoded = Buffer.from(v.res.base64, "base64").toString("utf8");
          const obj = JSON.parse(decoded);
          newAt = obj.data.accessToken || "";
          newRt = obj.data.refreshToken || xRefresh;
          expiresIn = obj.data.expiresIn || 5184000;
        } catch {}
        if (!newAt) newAt = reqAt.replace(/^Bearer\s+/i, "");
        if (!newRt) newRt = xRefresh;
        return { uid: uid || "a06ef5f8-7d84-4be5-8485-e6b81c3ce62b", ent, domain, accessToken: newAt, refreshToken: newRt, expiresIn };
      }
    } catch {}
  }
  return null;
}

async function saveAuth({ uid, ent, domain, accessToken, refreshToken }) {
  const expAt = (() => { try { return JSON.parse(Buffer.from(accessToken.split(".")[1], "base64").toString()).exp; } catch { return Math.floor(Date.now() / 1000) + 5184000; } })();
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const file = path.join(AUTH_DIR, `workbuddy-${uid}.json`);
  const doc = {
    account: { uid, enterpriseId: ent, nickname: "mslxd" },
    auth: { accessToken, refreshToken, expiresAt: expAt, domain },
  };
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
  fs.renameSync(tmp, file);
  log(`[flow] 已写 ${file} (exp ${new Date(expAt * 1000).toLocaleString()})`);
  try { if (process.platform === "win32") spawn("clip", { input: accessToken }); log("[flow] 已复制 accessToken 到剪贴板"); } catch {}
  return file;
}

async function main() {
  log("============================================================");
  log("  WorkBuddy token 一键流程化（whistle + codebuddy CLI）");
  log("  全新电脑：装 WorkBuddy→登录一次 → Node>=20 → node workbuddy-token-auto.js 即可");
  log("============================================================");
  if (!fs.existsSync(CODEBUDDY_BIN)) {
    throw new Error(`未找到 codebuddy：${CODEBUDDY_BIN}\n请先安装 WorkBuddy 5.3.14 并登录一次（https://copilot.tencent.com）`);
  }
  await startWhistle();
  // 若已有 auths 且未过期，直接刷新即可（无需 MITM）
  const existing = fs.existsSync(AUTH_DIR) ? fs.readdirSync(AUTH_DIR).filter(f => f.startsWith("workbuddy-") && f.endsWith(".json")) : [];
  if (existing.length) {
    log(`[flow] 检测到已有 ${existing.join(", ")}，尝试直接 refresh...`);
    try {
      const j = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, existing[0]), "utf8"));
      const at = j.auth.accessToken, rt = j.auth.refreshToken, uid = j.account.uid;
      const res = await fetch("https://copilot.tencent.com/v2/plugin/auth/token/refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${at}`,
          "X-Refresh-Token": rt,
          "X-User-Id": uid,
          "X-Domain": j.auth.domain || "www.codebuddy.cn",
          "User-Agent": "CLI/2.115.0 WorkBuddy/2.115.0",
          "Origin": "https://www.codebuddy.cn",
          "Referer": "https://www.codebuddy.cn/",
        },
        body: "{}",
      });
      const text = await res.text();
      const obj = JSON.parse(text);
       if (obj.code === 0 && obj.data.accessToken) {
        await saveAuth({ uid, ent: j.account.enterpriseId || "", domain: j.auth.domain || "www.codebuddy.cn", accessToken: obj.data.accessToken, refreshToken: obj.data.refreshToken || rt });
        log("[flow] refresh 成功，无需 MITM，已更新 auths");
        // refresh 后顺手签到（幂等，已签过则提示已签到）
        try { const { spawn } = await import("node:child_process"); spawn("node", [path.join(process.cwd(), "workbuddy-checkin.js")], { stdio: "inherit" }); } catch {}
        await stopWhistle();
        return;
      } else {
        log(`[flow] refresh 失败 ${text.slice(0,200)}，走 MITM 重新捕获`);
      }
    } catch (e) { log("[flow] refresh 异常", e.message, "走 MITM"); }
  }

  const { code, out, err } = await runCodebuddyViaProxy();
  log(`[flow] codebuddy 退出 code=${code} out=${out.slice(0,120)} err=${err.slice(0,300)}`);
  await sleep(1200);
  const cap = await captureRefreshToken();
  if (!cap) throw new Error("未从 whistle 捕获到 token，请确认 WorkBuddy 已登录且能正常对话");
  await saveAuth(cap);
  await stopWhistle();
  // 捕获后自动签到
  try { const { spawn } = await import("node:child_process"); spawn("node", [path.join(process.cwd(), "workbuddy-checkin.js")], { stdio: "inherit" }); } catch {}
  log("============================================================");
  log("  完成！下次直接 node workbuddy-token-auto.js 会走 refresh，无需再抓包");
  log("============================================================");
}

main().catch(e => { console.error(e); process.exit(1); });
