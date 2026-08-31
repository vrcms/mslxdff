import { loadTimezone, loadTimezoneState, saveTimezone, clearTimezone, getTimezoneEnv, isValidTimezone, DEFAULT_TZ } from "../../state/schemas/timezone.js";
import { getTimezone } from "../../time.js";

export async function handleTimezone(args) {
  if (!(args.includes("-timezone") || args.includes("--timezone") || args.includes("-tz") || args.includes("--tz") || args.includes("-time") || args.includes("--time"))) return false;
  const idx = args.findIndex((x) => ["-timezone","--timezone","-tz","--tz","-time","--time"].includes(x));
  const sub = args[idx + 1];
  const rest = args.slice(idx + 2);
  const env = getTimezoneEnv();
  const current = loadTimezoneState();
  const effective = getTimezone();

  if (!sub || sub === "status" || sub === "list" || sub === "show") {
    console.log(`timezone: ${effective} ${env ? `(env ${env} 覆盖)` : ""}`.trim());
    console.log(`  state: ${current}  ${current === DEFAULT_TZ ? "(默认 Asia/Shanghai)" : ""}`);
    if (env) console.log(`  env  : ${env}  (MSLXDFF_TZ 覆盖 state)`);
    else console.log(`  env  : (未设 MSLXDFF_TZ)`);
    console.log(`\n可用示例: Asia/Shanghai, UTC, America/New_York, Europe/London, Asia/Tokyo`);
    console.log(`用法:`);
    console.log(`  mslxdff -timezone set Asia/Shanghai   设为上海时间（默认）`);
    console.log(`  mslxdff -timezone set UTC             设为 UTC`);
    console.log(`  mslxdff -timezone clear               恢复默认 (${DEFAULT_TZ})`);
    console.log(`  MSLXDFF_TZ=UTC mslxdff -status        临时用 UTC（env 覆盖，不落盘）`);
    process.exit(0);
  }
  if (sub === "clear" || sub === "reset") {
    clearTimezone();
    console.log(`timezone 已清除，恢复默认: ${DEFAULT_TZ}`);
    process.exit(0);
  }
  let target = "";
  if (sub === "set") target = rest[0];
  else target = sub;
  if (!target) {
    console.error("usage: mslxdff -timezone set <Timezone>  e.g. Asia/Shanghai, UTC");
    console.error("       mslxdff -timezone <Timezone>  直接设置");
    process.exit(1);
  }
  if (!isValidTimezone(target)) {
    console.error(`无效时区: ${target}`);
    console.error(`示例: Asia/Shanghai, UTC, America/New_York`);
    process.exit(1);
  }
  saveTimezone(target);
  console.log(`timezone 已设为: ${target}（已写入 state.json，${env ? "但当前 env MSLXDFF_TZ 仍覆盖，需 unset 后生效" : "立即生效"}）`);
  process.exit(0);
}
