// -provider deepseek health：逐账号探活（防禁言体系）
// 用法：mslxdff -provider deepseek health [--json]
// 对池内每个账号发最小真实请求（Hello world + PoW），检测 muted/限频/凭据坏；
// 禁言账号自动冷却 5min（解封后再次探活即自动恢复）。不经过组员、直连本机凭据。
export async function handleDeepseekHealth(id, sub, rest) {
  if (id !== "deepseek" && id !== "ds") return false;
  if (sub !== "health" && sub !== "check") return false;

  const args = rest || [];
  const jsonOut = args.some((a) => a === "--json" || a === "-json");

  const { loadProviderKeys } = await import("../../../state.js");
  const keys = loadProviderKeys("deepseek") || [];
  if (!keys.length) {
    console.error("❌ 没有 DeepSeek 凭据，先登录：");
    console.error("  mslxdff -provider deepseek login --token <userToken>");
    process.exit(1);
  }

  const { createAuthPool } = await import("../../../providers/deepseek/auth.js");
  const { deepseekHealth } = await import("../../../providers/deepseek/health.js");
  const authPool = createAuthPool({ tokens: keys });

  if (!jsonOut) {
    console.log(`🔍 DeepSeek 探活中（${keys.length} 个账号，逐个发最小请求）...`);
  }
  const report = await deepseekHealth({ authPool });

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const r of report) {
      console.log(`  ${r.ok ? "✓" : "✗"} ...${r.tokenTail}  ${r.detail}`);
    }
    const okCount = report.filter((r) => r.ok).length;
    console.log(`\n结果：${okCount}/${report.length} 健康`);
    if (okCount === 0) {
      console.log("全部账号异常 —— 修复建议：");
      console.log("  1. chat.deepseek.com 登录后 F12 → Application → Local Storage → 复制 userToken");
      console.log("  2. mslxdff -provider deepseek login --token <userToken>  追加账号");
      console.log("  3. 禁言账号等待解除后再次探活即自动恢复");
    }
  }
  if (report.length && report.every((r) => !r.ok)) process.exitCode = 1;
  return true;
}
