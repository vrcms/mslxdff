// mslxdff -provider workbuddy login — WorkBuddy 官方设备授权流（对标 clinebot login）。
// 学自 Sliverkiss/workbuddy2api（cmd/login）：POST /v2/plugin/auth/state 拿 state+authUrl →
// 浏览器登录 → GET /v2/plugin/auth/token?state= 轮询 → GET /v2/plugin/login/account?state= 拿 uid。
// 不走 whistle/MITM，不依赖 codebuddy CLI，自然支持多账号追加。

const BASE = "https://copilot.tencent.com";
// UA 是上游指纹：集中一处，版本过期时改这里或用 MSLXDFF_WORKBUDDY_UA 覆盖。
const UA = process.env.MSLXDFF_WORKBUDDY_UA || "CLI/2.63.2 CodeBuddy/2.63.2";
const ORIGIN = "https://www.codebuddy.cn";

function baseHeaders() {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    "User-Agent": UA,
  };
}

async function readEnvelope(res) {
  const txt = await res.text();
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error(`WorkBuddy 返回非 JSON: ${txt.slice(0, 200)}`); }
  return j;
}

export async function requestDeviceState(fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`${BASE}/v2/plugin/auth/state?platform=CLI`, {
    method: "POST",
    headers: baseHeaders(),
    body: "{}",
    signal: AbortSignal.timeout(20000),
  });
  const j = await readEnvelope(res);
  if (j.code !== 0 || !j.data?.state || !j.data?.authUrl) {
    throw new Error(`获取授权失败: code=${j.code} ${j.msg || ""}`.trim());
  }
  return { state: j.data.state, authUrl: j.data.authUrl };
}

// 单次轮询：pending（业务 code 非 0）返回 null；HTTP 5xx 抛错；成功返回 token bundle。
export async function pollDeviceToken(fetchImpl = globalThis.fetch, state) {
  let res;
  try {
    res = await fetchImpl(`${BASE}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
      headers: baseHeaders(),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) { throw new Error(`轮询失败: ${e.message}`); }
  if (res.status >= 500) throw new Error(`token 端点故障: HTTP ${res.status}`);
  const j = await readEnvelope(res);
  if (j.code !== 0 || !j.data?.accessToken) return null; // pending: "login ing"
  return {
    accessToken: j.data.accessToken,
    refreshToken: j.data.refreshToken || "",
    expiresIn: Number(j.data.expiresIn) || 5184000,
    domain: j.data.domain || "www.codebuddy.cn",
  };
}

export async function fetchDeviceAccount(fetchImpl = globalThis.fetch, state, accessToken) {
  const res = await fetchImpl(`${BASE}/v2/plugin/login/account?state=${encodeURIComponent(state)}`, {
    headers: { ...baseHeaders(), Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20000),
  });
  const j = await readEnvelope(res);
  if (j.code !== 0 || !j.data?.uid) throw new Error(`获取账号失败: code=${j.code} ${j.msg || ""}`.trim());
  return { uid: j.data.uid, enterpriseId: j.data.enterpriseId || "", nickname: j.data.nickname || "" };
}

// 从本机桌面端登录态直接导入（学自 xiaofan6ya/workbuddy2api）：
// 桌面端明文存着当前登录号的 token，定位逻辑在 desktop-info.js（跨平台发现，不硬编码盘符/厂商目录）。
// 桌面已登录新号时用这个，无需浏览器、无需抓包。
export async function importDesktopAccount({ file, localAppData, roots, save } = {}) {
  const { resolveDesktopInfoPath, readDesktopAccount } = await import("../../../providers/workbuddy/desktop-info.js");
  const { homedir } = await import("node:os");
  const { path: fp, via } = resolveDesktopInfoPath({ file, roots, extraRoots: localAppData ? [localAppData] : [], homedir: homedir() });
  const saveFn = save || (await import("../../../providers/workbuddy/account-store.js")).saveWorkbuddyAccount;
  const saved = await saveFn(readDesktopAccount(fp));
  return { ...saved, desktopFile: fp, via };
}

export async function handleWorkbuddyLogin(id, sub, rest = [], deps = {}) {
  if (id !== "workbuddy" && id !== "wb") return false;
  if (sub === "import" || sub === "import-desktop" || sub === "from-desktop") {
    const fileArg = rest.find((x) => String(x).startsWith("--file="))?.slice("--file=".length);
    try {
      const saved = await importDesktopAccount({ file: fileArg, save: deps.saveAccount });
      console.log(`✅ 已从桌面端导入账号（现 ${saved.accounts} 个账号）：${saved.file}`);
      console.log("下一步：mslxdff -workbuddy balance  验证余额");
    } catch (e) {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    }
    process.exit(0);
  }
  if (sub !== "login" && sub !== "auth" && sub !== "oauth") return false;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;

  console.log("🚀 启动 WorkBuddy 设备授权流程...\n");
  let dev;
  try {
    dev = await requestDeviceState(fetchImpl);
  } catch (e) {
    console.error(`❌ 获取授权失败: ${e.message}`);
    process.exit(1);
  }
  console.log("=".repeat(60));
  console.log("1️⃣  在浏览器打开下面这个链接（用要添加的账号登录）：");
  console.log(`    ${dev.authUrl}`);
  console.log("2️⃣  登录成功后回到这里，无需回车，自动继续");
  console.log("=".repeat(60));
  console.log("\n🔄 等待你登录（自动轮询，每 5s，最多 5 分钟）...\n");

  const deadline = Date.now() + 5 * 60 * 1000;
  let bundle = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      bundle = await pollDeviceToken(fetchImpl, dev.state);
      if (bundle) break;
      process.stdout.write(".");
    } catch (e) {
      console.log(`\n   轮询出错: ${e.message}`);
    }
  }
  if (!bundle) {
    console.error("\n❌ 登录超时，请确认浏览器已完成登录后重跑 mslxdff -provider workbuddy login");
    process.exit(1);
  }
  console.log("\n✅ 授权成功！获取账号信息...");
  let acct;
  try {
    acct = await fetchDeviceAccount(fetchImpl, dev.state, bundle.accessToken);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
  const expiresAt = Math.floor(Date.now() / 1000) + bundle.expiresIn;
  const save = deps.saveAccount || (await import("../../../providers/workbuddy/account-store.js")).saveWorkbuddyAccount;
  const saved = await save({ uid: acct.uid, enterpriseId: acct.enterpriseId, nickname: acct.nickname, accessToken: bundle.accessToken, refreshToken: bundle.refreshToken, expiresAt, domain: bundle.domain });
  console.log("=".repeat(60));
  console.log(`✅ 登录成功! 账号: ${acct.nickname || acct.uid} (${acct.uid.slice(0, 8)}…，现 ${saved.accounts} 个账号${saved.updated ? "·旧号凭证已更新" : ""})`);
  console.log("=".repeat(60));
  console.log("\n下一步：");
  console.log("  mslxdff -restart                         重启网关使新账号生效");
  console.log("  mslxdff -workbuddy balance               看多号余额（新号次日自动纳入每日签到）");
  console.log("\n多账号：重复 login 追加，每号独立 uid，对话自动轮换");
  process.exit(0);
}
