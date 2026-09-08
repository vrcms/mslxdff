import { loadUseGroup, saveUseGroup, getEffectiveUseGroup, getUseGroupEnv } from "../../state/schemas/use-group.js";
import { argValue } from "../policy.js";

function parseInput(v) {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "on", "yes", "enable", "enabled", "open"].includes(s)) return true;
  if (["0", "false", "off", "no", "disable", "disabled", "close", "closed"].includes(s)) return false;
  return null;
}

export async function handleUseGroup(args) {
  const hasFlag = args.some((a) => ["-use-group", "--use-group", "-use_group", "--use_group", "-usegroup", "--usegroup"].includes(a));
  if (!hasFlag) return false;

  // 取值：支持 -use-group true / -use-group=true / --use-group=off
  let raw = argValue(args, "-use-group", "--use-group", "-use_group", "--use_group", "-usegroup", "--usegroup");
  // 兼容 -use-group=true 这种等号形态
  if (raw === null || raw === undefined) {
    const eq = args.find((a) => a.startsWith("-use-group=") || a.startsWith("--use-group=") || a.startsWith("-use_group=") || a.startsWith("--use_group="));
    if (eq) raw = eq.split("=")[1];
  }
  // 如果 flag 后面紧跟的不是另一个 flag，则视为值；否则视为查询
  if (raw !== null && raw !== undefined && String(raw).startsWith("-")) raw = null;

  const envVal = getUseGroupEnv();
  const effective = getEffectiveUseGroup();
  const stored = loadUseGroup();

  if (raw === null || raw === undefined || raw === "") {
    // 查询模式
    console.log(`use-group: ${effective ? "on" : "off"} (effective)`);
    console.log(`  stored: ${stored ? "on" : "off"} (state.json useGroup)`);
    if (envVal !== null) console.log(`  env MSLXDFF_USE_GROUP=${envVal ? "on" : "off"} (overrides stored)`);
    console.log(`  default: on`);
    console.log(`  usage: mslxdff -use-group on|off  (opencode 供应商本机失败时是否走组员网络，默认 on)`);
    console.log(`  env:   MSLXDFF_USE_GROUP=0|1  (优先级高于 state)`);
    process.exit(0);
  }

  const parsed = parseInput(raw);
  if (parsed === null) {
    console.error(`invalid value for -use-group: ${raw} (expected on/off/true/false/1/0)`);
    process.exit(1);
  }

  if (envVal !== null) {
    console.log(`note: env MSLXDFF_USE_GROUP=${envVal ? "on" : "off"} is set and overrides stored value; unset env to use stored value`);
  }

  saveUseGroup(parsed);
  console.log(`use-group set to ${parsed ? "on" : "off"} (stored in state.json)`);
  console.log(`  opencode 供应商：本机失败时 ${parsed ? "允许" : "不再"} 通过组员网络请求上游`);
  if (!parsed) console.log(`  提示：opencode 请求将仅在本机重试，不再走 peer/broadband 组员中继`);
  process.exit(0);
}
