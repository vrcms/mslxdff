// -provider deepseek login：把 chat.deepseek.com 凭据落盘 providerConfigs.deepseek.keys
// 三种用法：
//   login --token <userToken>     浏览器贴 token（F12 → Application → Local Storage → userToken）
//   login <email|mobile> <password>  账密登录换 token（Android 协议）
//   login                          打印用法引导
export async function handleDeepseekLogin(id, sub, rest) {
  if (id !== "deepseek" && id !== "ds") return false;
  if (sub !== "login" && sub !== "auth") return false;

  const args = rest || [];
  const tokenFlagIdx = args.findIndex((a) => a === "--token" || a === "-token" || a === "token");

  if (tokenFlagIdx < 0 && args.filter((a) => !String(a).startsWith("-")).length < 2) {
    printUsage();
    process.exit(0);
  }

  const { loadProviderKeys, saveProviderConfig, loadProviderConfig } = await import("../../../state.js");

  let token = null;
  let label = "";

  if (tokenFlagIdx >= 0) {
    token = String(args[tokenFlagIdx + 1] || "").trim();
    if (!token) {
      console.error("❌ --token 后面要贴 userToken 值");
      printUsage();
      process.exit(1);
    }
    label = "userToken（浏览器）";
  } else {
    const [loginValue, password] = args.filter((a) => !String(a).startsWith("-"));
    console.log("🚀 DeepSeek 账密登录中（Android 协议）...");
    try {
      const { loginDeepseek } = await import("../../../providers/deepseek/auth.js");
      const out = await loginDeepseek({ loginValue, password });
      token = out.token;
      label = `账密（${String(loginValue).slice(0, 3)}***）`;
      console.log(`✅ 登录成功，拿到 token`);
    } catch (e) {
      console.error(`❌ ${e.message}`);
      console.error(`\n换浏览器贴 token 方式：chat.deepseek.com 登录后 F12 → Application → Local Storage → 复制 userToken →`);
      console.error(`  mslxdff -provider deepseek login --token <userToken>`);
      process.exit(1);
    }
  }

  if (!token) {
    console.error("❌ 未拿到 token");
    process.exit(1);
  }

  const cur = loadProviderKeys("deepseek");
  if (cur.includes(token)) {
    console.log(`ℹ️ 该 token 已存在（现 ${cur.length} 个账号），跳过`);
  } else {
    const cfg = loadProviderConfig("deepseek") || {};
    const nextKeys = [...new Set([...(cfg.keys || cur), token].filter(Boolean))];
    saveProviderConfig("deepseek", { ...cfg, keys: nextKeys });
    console.log(`✅ 已写入 deepseek（现 ${nextKeys.length} 个账号）· 来源: ${label}`);
  }

  console.log("=".repeat(60));
  console.log("\n下一步：");
  console.log("  mslxdff -provider deepseek allowAny on   放行模型（默认 allowlist 空=全 blocked）");
  console.log("  mslxdff -provider deepseek models        查看支持的模型");
  console.log("  mslxdff -restart                         重启网关生效");
  console.log("\n用法：model 字段填 deepseek/deepseek-chat 或 deepseek/deepseek-reasoner");
  console.log("      （-search 后缀开启联网搜索：deepseek/deepseek-chat-search）");
  console.log("\n多账号：重复 login 追加，自动轮换 + 401/429/风控切号");
  console.log("注意：单账号同时仅 1 路输出；触发验证码时换号或稍后再试");
  process.exit(0);
}

function printUsage() {
  console.log("DeepSeek 登录（两种方式任选）：");
  console.log("");
  console.log("  方式 1（推荐，免密码）：浏览器贴 token");
  console.log("    1. 浏览器登录 https://chat.deepseek.com");
  console.log("    2. F12 → Application → Local Storage → https://chat.deepseek.com");
  console.log("    3. 找到 userToken，复制值");
  console.log("    4. mslxdff -provider deepseek login --token <userToken>");
  console.log("");
  console.log("  方式 2：账号密码（邮箱或手机号）");
  console.log("    mslxdff -provider deepseek login you@example.com yourpassword");
  console.log("    mslxdff -provider deepseek login 13800138000 yourpassword");
  console.log("");
  console.log("  登录后：mslxdff -provider deepseek allowAny on && mslxdff -restart");
}
