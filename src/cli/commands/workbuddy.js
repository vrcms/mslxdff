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
      try {
        const { existsSync, unlinkSync } = await import("node:fs");
        const { join } = await import("node:path");
        const dir = process.env.WORKBUDDY_AUTH_DIR || join(process.cwd(), "auths");
        const fp = join(dir, `workbuddy-${uid}.json`);
        if (existsSync(fp)) { unlinkSync(fp); console.log(`removed file ${fp}`); }
      } catch {}
    }
    try { const { getBalanceCache } = await import("../../providers/workbuddy-balance.js"); getBalanceCache().delete(uid); } catch {}
    console.log(`removed workbuddy ${uid} (now ${auths.length} account(s))`);
    process.exit(0);
  } else {
    console.error("usage: mslxdff -workbuddy checkin | balance [--json] | list | remove <uid>");
    process.exit(1);
  }
}
