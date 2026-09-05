import { compatFetch, getUndici, timeoutSignal } from "../../../compat.js";
export async function handleClineLogin(id, sub) {
  if (sub !== "login" && sub !== "auth" && sub !== "oauth") return false;
  if (id !== "cline" && id !== "clinebot" && id !== "cline-bot") return false;

  const CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";
  const WORKOS_DEVICE = "https://api.workos.com/user_management/authorize/device";
  const WORKOS_AUTH = "https://api.workos.com/user_management/authenticate";
  const CLINE_REGISTER = "https://api.cline.bot/api/v1/auth/register";

  // 网络层：支持代理（读环境变量）+ 超时 + 人话报错。
  // 直连 api.workos.com 在部分网络下 TCP 会被墙（DNS 通但 443 超时），此时必须走代理。
  const PROXY_URL = (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "").trim();
  let dispatcher = null;
  if (PROXY_URL) {
    try {
      const { ProxyAgent } = getUndici();
      dispatcher = new ProxyAgent(PROXY_URL);
    } catch (e) {
      console.error(`⚠️ 代理变量 ${PROXY_URL} 不可用（${e.message}），回退直连`);
    }
  }
  function netHint(e, url) {
    const host = (() => { try { return new URL(url).host; } catch { return url; } })();
    const cause = e?.cause || e;
    const code = cause?.code || cause?.name || "";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `DNS 解析失败（${host}），检查 DNS/网络`;
    if (code === "ECONNREFUSED") return `连接被拒（${host}），检查代理是否开启`;
    if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || e?.name === "TimeoutError") return `连接 ${host} 超时（直连可能被墙），请开代理后重试：set HTTPS_PROXY=http://127.0.0.1:7890 再跑 login`;
    if (!PROXY_URL && /workos\.com|cline\.bot/.test(host)) return `直连 ${host} 失败（${code || e.message}），疑似被墙，请开代理后重试`;
    return `${code || e.message}`;
  }
  // 注意：dispatcher 为 null 时不能显式传给 fetch（undici 会断言失败），有代理才带。
  const extraOpts = dispatcher ? { dispatcher } : {};
  async function postForm(url, form) {
    const body = new URLSearchParams(form).toString();
    let res;
    try {
      res = await compatFetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, ...extraOpts, signal: timeoutSignal(20000) });
    } catch (e) { throw new Error(`连不上 WorkOS：${netHint(e, url)}`); }
    const txt = await res.text();
    try { return JSON.parse(txt); } catch { throw new Error(`WorkOS 返回非 JSON: ${txt.slice(0, 200)}`); }
  }
  async function postJson(url, obj) {
    let res;
    try {
      res = await compatFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj), ...extraOpts, signal: timeoutSignal(20000) });
    } catch (e) { throw new Error(`连不上 Cline：${netHint(e, url)}`); }
    const txt = await res.text();
    try { return JSON.parse(txt); } catch { throw new Error(`Cline 返回非 JSON: ${txt.slice(0, 200)}`); }
  }
  if (PROXY_URL && dispatcher) console.log(`🌐 检测到代理：${PROXY_URL}\n`);

  console.log("🚀 启动 Cline WorkOS 设备授权流程...\n");
  let device;
  try {
    device = await postForm(WORKOS_DEVICE, { client_id: CLIENT_ID });
  } catch (e) {
    console.error(`❌ 获取设备码失败: ${e.message}`);
    process.exit(1);
  }
  const device_code = device.device_code;
  const user_code = device.user_code;
  const auth_url = device.verification_uri_complete || device.verification_uri;
  const interval = Math.max(Number(device.interval || 5), 5);
  const expires_in = Number(device.expires_in || 300);
  if (!device_code || !user_code || !auth_url) {
    console.error("❌ WorkOS 返回不完整:", JSON.stringify(device).slice(0, 500));
    process.exit(1);
  }
  console.log("=".repeat(60));
  console.log("1️⃣  在浏览器打开下面这个链接：");
  console.log(`    ${auth_url}`);
  console.log("2️⃣  页面会要求输入设备码（可能已自动带好）：");
  console.log(`    ${user_code}`);
  console.log("3️⃣  用 Google / GitHub / 邮箱登录并授权");
  console.log("=".repeat(60));
  console.log(`\n🔄 等待你授权（自动轮询，每 ${interval}s，最多 ${expires_in}s）...`);
  console.log("   （已授权后会自动继续，无需回车）\n");

  const deadline = Date.now() + expires_in * 1000;
  let workos = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    try {
      const a = await postForm(WORKOS_AUTH, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code, client_id: CLIENT_ID });
      if (a.access_token) { workos = a; break; }
      const err = a.error;
      if (err === "slow_down") { await new Promise((r) => setTimeout(r, 5000)); }
      else if (err && err !== "authorization_pending") {
        console.log(`   [${err}] ${a.error_description || ""}`);
      } else {
        process.stdout.write(".");
      }
    } catch (e) {
      console.log(`\n   轮询出错: ${e.message}`);
    }
  }
  if (!workos) {
    console.error("\n❌ 授权超时，请重新运行 mslxdff -provider clinebot login");
    process.exit(1);
  }
  console.log("\n✅ WorkOS 授权成功！\n🔗 用 WorkOS token 在 Cline 注册...");
  let cline;
  try {
    cline = await postJson(CLINE_REGISTER, { accessToken: workos.access_token, refreshToken: workos.refresh_token });
  } catch (e) {
    console.error(`❌ Cline 注册失败: ${e.message}`);
    process.exit(1);
  }
  const rt = cline?.data?.refreshToken || cline?.refreshToken;
  const email = cline?.data?.userInfo?.email || cline?.data?.email || "unknown";
  if (!rt) {
    console.error("❌ 注册失败，未拿到 refreshToken:", JSON.stringify(cline).slice(0, 800));
    process.exit(1);
  }
  console.log("=".repeat(60));
  console.log(`✅ 登录成功! 账号: ${email}`);
  console.log(`🔑 refreshToken: ${rt.slice(0, 8)}…${rt.slice(-8)} (${rt.length} 字符)`);
  // 落盘到 state（同时写 cline 与 clinebot 两个 id，兼容）
  const { loadProviderKeys, saveProviderConfig, loadProviderConfig } = await import("../../../state.js");
  for (const pid of ["cline", "clinebot"]) {
    try {
      const cur = loadProviderKeys(pid);
      if (cur.includes(rt)) {
        console.log(`   ℹ️ ${pid} 已存在相同 token，跳过`);
        continue;
      }
      const cfg = loadProviderConfig(pid) || { baseUrl: "", keys: [] };
      const nextKeys = [...new Set([...(cfg.keys || cur), rt].filter(Boolean))];
      saveProviderConfig(pid, { baseUrl: cfg.baseUrl || "https://api.cline.bot", keys: nextKeys });
      console.log(`   ✅ 已写入 ${pid}（现 ${nextKeys.length} 个账号）`);
    } catch (e) {
      console.log(`   ⚠️ 写入 ${pid} 失败: ${e.message}`);
    }
  }
  console.log("=".repeat(60));
  console.log("\n下一步：");
  console.log("  mslxdff -restart                         重启网关使新账号生效");
  console.log("  mslxdff -provider clinebot bench --json  测速 deepseek 是否 200");
  console.log("  mslxdff -chat                             直接对话，模型选 deepseek/deepseek-v4-flash");
  console.log("\n多账号：重复 `mslxdff -provider clinebot login` 追加，二号自动做后备");
  process.exit(0);
}
