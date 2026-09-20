import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export async function handleWorkbuddy(args) {
  if (!(args.includes("-workbuddy") || args.includes("--workbuddy") || args.includes("-wb"))) return false;
  const idx = args.findIndex((x) => x === "-workbuddy" || x === "--workbuddy" || x === "-wb");
  const sub = args[idx + 1];
  if (!sub || sub === "checkin" || sub === "daily-checkin" || sub === "check-in") {
    const { spawn } = await import("node:child_process");
    const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "workbuddy-checkin.js");
    // for src/cli/commands/workbuddy.js -> ../../../workbuddy-checkin.js is root/workbuddy-checkin.js
    const child = spawn(process.execPath, [script, ...args.slice(idx + 2)], { stdio: "inherit" });
    child.on("close", (code) => process.exit(code ?? 0));
    child.on("error", (err) => { console.error(`workbuddy checkin failed: ${err.message}`); process.exit(1); });
    await new Promise(() => {});
  } else if (sub === "growth" || sub === "earn" || sub === "tasks") {
    const asJson = args.includes("--json") || args.includes("-json");
    const ci = args.indexOf("--codes");
    const codes = ci >= 0 && args[ci + 1] ? String(args[ci + 1]).split(",").filter(Boolean) : undefined;
    const ai = args.indexOf("--account");
    const prefix = ai >= 0 && args[ai + 1] ? String(args[ai + 1]) : "";
    let items = await loadWorkbuddyAccounts();
    if (prefix) items = items.filter((it) => String(it.uid).startsWith(prefix));
    if (!items.length) { console.log("no workbuddy accounts — run node workbuddy-token-auto.js"); process.exit(0); }
    await refreshExpiringAccounts(items);
    const { runGrowthAll } = await import("../../providers/workbuddy/growth.js");
    if (!asJson) console.log(`workbuddy growth (${items.length} account(s), serial):`);
    const res = await runGrowthAll({
      accounts: items.map((it) => ({ uid: it.uid, at: it.key, domain: it.domain, enterpriseId: it.enterpriseId })),
      codes,
      onAccount: (row) => {
        if (asJson) return;
        const u = String(row.uid).slice(0, 8);
        if (!row.ok && row.error) { console.log(`  [${u}] 失败: ${row.error}`); return; }
        for (const t of row.tasks) {
          if (t.skipped) console.log(`  [${u}] ${t.task_code} 跳过(${t.skipped})`);
          else console.log(`  [${u}] ${t.task_code} 触发 ${t.fired}/${t.times} → ${t.status || "?"}${t.credit ? ` +${t.credit}` : ""}`);
        }
        console.log(`  [${u}] 合计 +${row.credit} 积分 / +${row.energy} 能量`);
      },
    });
    if (asJson) console.log(JSON.stringify(res, null, 2));
    else console.log(`总计 +${res.creditTotal} 积分`);
    process.exit(0);
  } else if (sub === "travel" || sub === "cat" || sub === "cat-travel") {
    const asJson = args.includes("--json") || args.includes("-json");
    const ai = args.indexOf("--account");
    const prefix = ai >= 0 && args[ai + 1] ? String(args[ai + 1]) : "";
    let items = await loadWorkbuddyAccounts();
    if (prefix) items = items.filter((it) => String(it.uid).startsWith(prefix));
    if (!items.length) { console.log("no workbuddy accounts — run node workbuddy-token-auto.js"); process.exit(0); }
    await refreshExpiringAccounts(items);
    const { runCatTravel } = await import("../../providers/workbuddy/cat-travel.js");
    if (!asJson) console.log(`workbuddy cat-travel (${items.length} account(s)):`);
    const rows = [];
    for (const it of items) {
      const u = String(it.uid).slice(0, 8);
      const r = await runCatTravel({
        uid: it.uid, at: it.key, domain: it.domain, enterpriseId: it.enterpriseId,
        onStep: asJson ? null : (s) => console.log(`  [${u}] ${s.step} ${s.ok ? "✓" : "✗"} ${s.message}${s.reward ? ` (+${s.reward})` : ""}`),
      });
      if (!asJson) console.log(`  [${u}] ${r.summary}`);
      rows.push({ uid: it.uid, outcome: r.outcome, credits: r.credits, ok: r.ok, steps: r.steps });
    }
    const total = rows.reduce((s, r) => s + (r.credits || 0), 0);
    if (asJson) console.log(JSON.stringify({ results: rows, credits: total }, null, 2));
    else console.log(`总计 +${total} 积分`);
    process.exit(0);
  } else if (sub === "balance" || sub === "balances" || sub === "credit" || sub === "credits") {
    const asJson = args.includes("--json") || args.includes("-json");
    const { loadProviderConfigs } = await import("../../state.js");
    const { fetchBalance } = await import("../../providers/workbuddy-balance.js");
    const cfg = loadProviderConfigs().workbuddy || {};
    const auths = Array.isArray(cfg.auths) ? cfg.auths : [];
    const keys = Array.isArray(cfg.keys) ? cfg.keys : [];
    let items = auths.map((a,i)=> ({ uid:a.uid, domain:a.domain, key: keys[i]||"" , auth:a }));
    if (!items.length) {
      try {
        const { readdirSync, readFileSync, existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const dir = process.env.WORKBUDDY_AUTH_DIR || join(process.cwd(), "auths");
        if (existsSync(dir)) {
          for (const f of readdirSync(dir).filter(x=>x.startsWith("workbuddy-")&&x.endsWith(".json"))) {
            try { const j=JSON.parse(readFileSync(join(dir,f),"utf8")); if(j?.account?.uid) items.push({uid:j.account.uid, domain:j.auth.domain||"www.codebuddy.cn", key:j.auth.accessToken, auth:{uid:j.account.uid, domain:j.auth.domain||"www.codebuddy.cn", enterpriseId:j.account.enterpriseId||""}}); } catch {}
          }
        }
      } catch {}
    }
    if (!items.length) { console.log("no workbuddy accounts — run node workbuddy-token-auto.js"); process.exit(0); }
    const results=[];
    for (const it of items) {
      const b = await fetchBalance({ uid: it.uid, key: it.key, auth: it.auth }).catch(()=>null);
      results.push({ uid: it.uid, domain: it.domain, balance: b });
    }
    if (asJson) { console.log(JSON.stringify({ results }, null, 2)); process.exit(0); }
    console.log(`workbuddy balances (${results.length}):`);
    for (const r of results) {
      const b=r.balance;
      if (!b) console.log(`  ${r.uid}  (balance unavailable)  domain=${r.domain}`);
      else console.log(`  ${r.uid}  total=${b.totalStr||b.total}  dailyPacks=${b.dailyPacks}  active=${b.activeCount}  nextExpire=${b.nextExpire||"-"}  domain=${r.domain}`);
    }
    process.exit(0);
  } else if (sub === "list" || sub === "ls" || sub === "status") {
    const { loadProviderConfigs } = await import("../../state.js");
    const cfg = loadProviderConfigs().workbuddy || {};
    const auths = Array.isArray(cfg.auths) ? cfg.auths : [];
    const keys = Array.isArray(cfg.keys) ? cfg.keys : [];
    if (!auths.length) { console.log("no workbuddy accounts in state — check auths/workbuddy-*.json"); process.exit(0); }
    console.log(`workbuddy accounts (${auths.length}):`);
    auths.forEach((a,i)=> {
      const k=(keys[i]||"").slice(0,4);
      console.log(`  [${i+1}] uid=${a.uid} domain=${a.domain||"www.codebuddy.cn"} enterprise=${a.enterpriseId||"-"} key=${k?k+"…":"(none)"} refresh=${a.refreshToken?"yes":"no"}`);
    });
    process.exit(0);
  } else if (sub === "remove" || sub === "rm" || sub === "del" || sub === "delete") {
    const target = args[idx+2];
    if (!target) { console.error("usage: mslxdff -workbuddy remove <uid> [--keep-file]"); process.exit(1); }
    const keep = args.includes("--keep-file");
    const { loadProviderConfigs, saveProviderConfig } = await import("../../state.js");
    const cfg = loadProviderConfigs().workbuddy || {};
    let auths = Array.isArray(cfg.auths)? [...cfg.auths]:[];
    let keys = Array.isArray(cfg.keys)? [...cfg.keys]:[];
    let rmIdx = auths.findIndex(a=> a.uid===target || a.uid.startsWith(target));
    if (rmIdx<0) { console.error(`uid not found: ${target}`); process.exit(1); }
    const uid = auths[rmIdx].uid;
    auths.splice(rmIdx,1); keys.splice(rmIdx,1);
    saveProviderConfig("workbuddy", { baseUrl: cfg.baseUrl||"https://copilot.tencent.com", keys, auths });
    if (!keep) {
      // 旧实现只删 cwd/auths 那一份，留下的旧副本会被读取兜底"复活"账号 → 扫所有候选目录
      try {
        const { existsSync, unlinkSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { resolveAuthDirs } = await import("../../providers/workbuddy/account-store.js");
        for (const dir of resolveAuthDirs()) {
          const fp = join(dir, `workbuddy-${uid}.json`);
          if (existsSync(fp)) { unlinkSync(fp); console.log(`removed file ${fp}`); }
        }
      } catch {}
    }
    try { const { getBalanceCache } = await import("../../providers/workbuddy-balance.js"); getBalanceCache().delete(uid); } catch {}
    console.log(`removed workbuddy ${uid} (now ${auths.length} account(s))`);
    process.exit(0);
  } else {
    console.error("usage: mslxdff -workbuddy checkin | growth [--codes a,b] [--account <uid>] | travel | balance [--json] | list | remove <uid>");
    process.exit(1);
  }
}

// 账号加载（state 优先，缺则扫 auths/workbuddy-*.json），供 growth/travel 使用。
async function loadWorkbuddyAccounts() {
  const { loadProviderConfigs } = await import("../../state.js");
  const cfg = loadProviderConfigs().workbuddy || {};
  const auths = Array.isArray(cfg.auths) ? cfg.auths : [];
  const keys = Array.isArray(cfg.keys) ? cfg.keys : [];
  const items = auths.map((a, i) => ({
    uid: a.uid, domain: a.domain || "www.codebuddy.cn", enterpriseId: a.enterpriseId || "",
    key: keys[i] || "", auth: a,
  })).filter((it) => it.uid && it.key);
  if (items.length) return items;
  try {
    const { listAccountDocs } = await import("../../providers/workbuddy/account-store.js");
    for (const { uid, doc } of listAccountDocs()) {
      const domain = doc.auth.domain || "www.codebuddy.cn";
      items.push({
        uid, domain, enterpriseId: doc.account.enterpriseId || "",
        key: doc.auth.accessToken,
        auth: { uid, domain, enterpriseId: doc.account.enterpriseId || "", refreshToken: doc.auth.refreshToken || "" },
      });
    }
  } catch {}
  return items;
}

// 临期 token 续期（<1h），refresh 结果经 store 回写 state 与 auths 文件。
async function refreshExpiringAccounts(items) {
  const { compatFetch } = await import("../../compat.js");
  const { createAuthService, decodeJwtExp } = await import("../../providers/workbuddy/auth.js");
  const keys = items.map((it) => it.key);
  const authList = items.map((it) => it.auth);
  const svc = createAuthService({ fetchImpl: compatFetch, store: { keys, authList } });
  await Promise.all(authList.map(async (auth, i) => {
    try {
      const exp = decodeJwtExp(keys[i]);
      if (exp && exp - Date.now() / 1000 < 3600) await svc.refreshTokenFor(keys[i], auth);
    } catch {}
  }));
  items.forEach((it, i) => { it.key = keys[i]; });
  return items;
}
