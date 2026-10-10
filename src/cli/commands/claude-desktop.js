import { loadToken, loadModelPicks, loadPreferredModel } from "../../state.js";
import { getPreferredModel } from "../../auto.js";
import { effectivePort } from "../policy.js";
import { claudeDesktopConfigDir, readClaudeDesktopProfile } from "../../sync-claude-desktop.js";
import { ROLE_SLOTS, planSlots, slotRole } from "../../claude-desktop/slots.js";
import { detectManagedPolicy, readAppCatalogIds, appDataDirOf, currentAliases, probeMessages } from "../../claude-desktop/doctor.js";
import { normalizeModel } from "../../reasoning.js";
import { applyClaudeDesktop, retireClaudeDesktop } from "../../claude-desktop/apply.js";

/**
 * `-claude-desktop status|slots|check` —— Claude Desktop on 3P 的体检命令（只读，不发配置变更）。
 * 存在的理由：App 里的 Test connection 只给一个红点，这里要回答「哪一环坏、下一步敲什么」。
 */
export async function handleClaudeDesktop(args = [], flag = "-claude-desktop") {
  if (!args.includes(flag) && !args.includes(`-${flag}`)) return false;
  const idx = args.findIndex((x) => x === flag || x === `-${flag}`);
  const sub = String(args[idx + 1] || "status").toLowerCase();
  const rest = args.slice(idx + 2);
  if (["-h", "--help", "help"].includes(sub)) { printUsage(); process.exit(0); }
  if (!["status", "slots", "check"].includes(sub)) {
    console.error(`未知子命令: ${sub}`);
    printUsage();
    process.exit(1);
  }
  const dir = claudeDesktopConfigDir();
  const managed = detectManagedPolicy();
  const profile = readClaudeDesktopProfile({ dir });

  if (sub === "slots") return slotsReport(dir);
  if (sub === "check") return checkReport({ args, rest, dir, profile });
  return statusReport({ dir, managed, profile });

  function statusReport({ dir, managed, profile }) {
    console.log(`Claude Desktop 3P profile: ${dir}`);
    console.log(`  托管策略: ${managed.managed ? `⚠ 有（${managed.source}）` : "无"} —— ${managed.note}`);
    if (!profile.exists) {
      console.log(`  状态: 空 —— ${profile.error}`);
      console.log(`  下一步: mslxdff -setto claude-desktop   （写 profile + 角色槽 alias）`);
      console.log(`  或手工: 打开 Claude Desktop → 登录界面 ☰/菜单栏 → Help → Troubleshooting → Enable Developer Mode → Developer → Configure Third-Party Inference…`);
      return process.exit(0);
    }
    if (profile.error) console.log(`  ⚠ ${profile.error}`);
    console.log(`  生效配置: ${profile.appliedName || "(无名)"}  id=${profile.appliedId}`);
    console.log(`  其它条目: ${profile.entries.filter((e) => String(e?.id || "") !== profile.appliedId).map((e) => e?.name || e?.id).join(", ") || "无"}`);
    const p = profile.profile || {};
    console.log(`  provider=${p.inferenceProvider || "-"}  credential=${p.inferenceCredentialKind || "-"}  scheme=${p.inferenceGatewayAuthScheme || "-"}`);
    console.log(`  baseUrl=${p.inferenceGatewayBaseUrl || "-"}`);
    if (managed.managed) console.log(`  ⚠ 有托管策略在，App 会忽略这份本地配置 —— 先清托管策略或改由 MDM 下发`);
    const models = Array.isArray(p.inferenceModels) ? p.inferenceModels : [];
    if (!models.length) {
      console.log(`  inferenceModels: 空 —— App 会走 /v1/models 自动发现，而发现只认 Claude 形态 id，你池子里的模型不会出现`);
      console.log(`  下一步: mslxdff -setto claude-desktop`);
    } else {
      const aliases = currentAliases();
      console.log(`  inferenceModels: ${models.length} 行`);
      for (const m of models) {
        const name = typeof m === "string" ? m : String(m?.name || "");
        const label = typeof m === "string" ? "" : String(m?.labelOverride || "");
        const target = aliases[name];
        const mark = !isSlot(name) ? "⚠ 非角色槽（App 可能拒）" : target ? `→ ${target}` : "⚠ 无 alias（请求会被当未知模型丢组员转发→超时 502）";
        console.log(`    ${name.padEnd(28)} ${slotRole(name).padEnd(7)} ${label ? `[${label}]`.padEnd(30) : ""}${mark}`);
      }
      const missing = models.map((m) => (typeof m === "string" ? m : String(m?.name || ""))).filter((n) => n && !aliases[n]);
      if (missing.length) {
        console.log(`  下一步: mslxdff -setto claude-desktop   （补 ${missing.length} 条 alias，daemon 热读、不用重启）`);
      } else {
        console.log(`  ✓ 每条槽位都有 alias；验证: mslxdff -claude-desktop check`);
      }
    }
    console.log(`  ⚠ App 不热重载：改完必须完全退出并重新打开 Claude Desktop`);
    process.exit(0);
  }

  async function slotsReport(dir) {
    const catalog = readAppCatalogIds({ appDir: appDataDirOf(dir) });
    console.log(`App 签名模型目录: ${catalog.file}`);
    if (!catalog.ok) {
      console.log(`  状态: ${catalog.error}`);
      console.log(`  说明: 槽位清单退回内置默认（${ROLE_SLOTS.length} 个），App 首次联网启动后重跑本命令可核对实况`);
    } else {
      console.log(`  version=${catalog.version}  可识别 claude-* id ${catalog.ids.length} 个`);
      const known = new Set(catalog.ids);
      const missing = ROLE_SLOTS.filter((s) => !known.has(s));
      const extra = catalog.ids.filter((i) => !ROLE_SLOTS.includes(i));
      console.log(`  内置槽位: ${ROLE_SLOTS.join(" ")}`);
      if (missing.length) console.log(`  ⚠ 内置槽位在本机 App 目录里查不到（写了可能被拒）: ${missing.join(" ")}`);
      if (extra.length) console.log(`  ℹ App 还认得但没当槽位用的 id: ${extra.join(" ")}`);
      if (!missing.length) console.log(`  ✓ 内置槽位与 App 目录一致`);
    }
    process.exit(0);
  }

  async function checkReport({ rest, dir, profile }) {
    const { positional: only } = splitArgs(rest);
    let rows;
    try {
      const p = profile.profile || {};
      const models = Array.isArray(p.inferenceModels) ? p.inferenceModels : [];
      if (models.length && !only.length) {
        rows = models.map((m) => {
          const name = typeof m === "string" ? m : String(m?.name || "");
          return { slot: name, model: String((typeof m === "string" ? null : m?.labelOverride) || currentAliases()[name] || ""), label: "" };
        }).filter((r) => r.slot);
      } else {
        const picks = only.length ? only : loadModelPicks();
        rows = planSlots({ picks, preferred: loadPreferredModel() || getPreferredModel() || "" }).rows;
      }
    } catch (e) {
      console.error(`没有可探测的槽位：${String(e?.message || e)}`);
      process.exit(1);
    }
    let token = "";
    try { token = (await loadToken()).token || ""; } catch { /* 下面按空 token 报 */ }
    const port = effectivePort(rest);
    console.log(`逐槽探活 http://127.0.0.1:${port}/v1/messages（max_tokens=16，串行，最慢的一条会决定总耗时）`);
    console.log(`  ${"槽位".padEnd(28)} ${"结果".padEnd(6)} ${"耗时".padEnd(8)} ${"actual-model".padEnd(28)} 说明`);
    let bad = 0;
    for (const r of rows) {
      const res = await probeMessages({ port, token, model: r.slot });
      const okMark = res.ok ? "✓" : "✗";
      if (!res.ok) bad++;
      const note = res.ok ? (res.text ? `正文「${res.text}」` : "200") : classifyFailure(res, r);
      console.log(`  ${r.slot.padEnd(28)} ${okMark.padEnd(6)} ${(res.ms + "ms").padEnd(8)} ${(res.actualModel || "-").padEnd(28)} ${note}`);
    }
    if (bad) {
      console.log(`\n${bad}/${rows.length} 条不通。常见判据：`);
      console.log(`  · actual-model 空 + 30~90s 超时 → 槽位没 alias，被当未知模型丢组员转发：跑 mslxdff -setto claude-desktop`);
      console.log(`  · 401 → token 不对或已轮换：mslxdff -showtoken 后重跑 -setto claude-desktop`);
      console.log(`  · 502 且 actual-model 有值 → 该真模型上游失效：mslxdff -model pick 换一条，或 -stats 看冷却`);
      console.log(`  · connection refused → 网关没起：mslxdff -d`);
      process.exit(1);
    }
    console.log(`\n✓ 全部槽位可跑。下一步：完全退出并重启 Claude Desktop → 登录界面选 3P 配置 → Code tab 里选模型（下拉显示的是 labelOverride 写的真模型名）`);
    process.exit(0);
  }
}

function classifyFailure(res) {
  if (res.status === 401) return "401：token 不对/已轮换 → mslxdff -showtoken 后重跑 -setto claude-desktop";
  if (res.status === 0) return `请求没回来：${res.error}`;
  if (!res.actualModel) return `HTTP ${res.status}，且无 actual-model → 槽位没 alias（被当未知模型丢组员）`;
  return `HTTP ${res.status}：${res.error}`;
}

function isSlot(name) {
  return ROLE_SLOTS.includes(String(name || ""));
}

function printUsage() {
  console.log(`用法:
  mslxdff -claude-desktop status        看 profile / 托管策略 / 槽位 alias 是否齐（只读盘）
  mslxdff -claude-desktop slots         看 App 签名模型目录认得哪些槽位 id（内置清单与实况比对）
  mslxdff -claude-desktop check [id...] 逐槽向本机 /v1/messages 探活（等价 App 那个 Test connection，但给原因）
  写配置: mslxdff -setto claude-desktop [modelId ...] [--max N] [--no-alias] [--official]`);
}

/**
 * `-setto claude-desktop [modelId ...] [--max N] [--max-effort <lvl>] [--no-alias] [--check] [--official]`
 * 由 `src/cli/commands/sync.js` 的 `-setto` 责任链转发进来（sync.js 只留 4 行，避免顶到 20KB 体积门）。
 */
export async function handleClaudeDesktopSetto(args = [], idx = -1) {
  const rest = args.slice(idx + 2);
  const bad = (msg) => { console.error(msg); process.exit(1); };
  // 带值参数必须成对吞掉再分位置参数：否则 `--max 3` 里的 "3" 会被当成模型 id 写进槽位（实测踩过）
  const { positional, flags, values, missing } = splitArgs(rest);
  if (missing) bad(`${missing} 需要取值`);
  const maxRaw = values["--max"];
  const effortRaw = values["--max-effort"];
  const unknown = flags.filter((f) => !["--max", "--max-effort", "--no-alias", "--check", "--official", "--port"].includes(f));
  if (unknown.length) bad(`未知参数: ${unknown.join(" ")}（可用：--max N / --max-effort <lvl> / --no-alias / --check / --official）`);
  if (maxRaw !== undefined && !(Number(maxRaw) > 0)) bad("--max 需要一个正整数（要写几条槽位），例如 --max 3");
  const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
  if (effortRaw !== undefined && !EFFORTS.includes(String(effortRaw))) bad(`--max-effort 只能是 ${EFFORTS.join(" | ")}`);

  const port = effectivePort(args);
  let token = "";
  try { token = (await loadToken()).token || ""; } catch { /* 下面统一按空 token 报错 */ }
  if (!token) bad("拿不到本机 token → 先跑 mslxdff -showtoken（或 mslxdff -refresh-token）");

  if (flags.includes("--official")) {
    const r = retireClaudeDesktop({ port });
    console.log(`claude-desktop: ${r.action === "retired" ? "已摘除 mslxdff 那条登记" : r.action === "unchanged" ? "本来就没登记（未改字节）" : "没有可摘的 _meta.json"}`);
    console.log(`  ${r.dir}\\_meta.json`);
    if (typeof r.remaining === "number") console.log(`  剩余条目: ${r.remaining}（用户/窗口自建的条目一字未动）`);
    console.log(`  alias 未自动删（删了会影响 Claude Code CLI）：要清就手工从 ${r.aliasFile} 里删掉 claude-sonnet-5 / claude-opus-5 / claude-haiku-5-5 这几条`);
    console.log(`  下一步：完全退出并重启 Claude Desktop，在登录界面选 Anthropic 登录即回官方模式`);
    process.exit(0);
  }

  let picks;
  if (positional.length) {
    picks = positional.map((x) => {
      const n = normalizeModel(String(x).trim());
      if (!n || n === "auto") bad(`modelId 不合法: ${x}`);
      return n;
    });
  } else {
    picks = loadModelPicks();
    if (!picks.length) bad("modelPicks 勾选集为空 → 无可写入的模型；先跑 mslxdff -model pick 勾选，或直接 mslxdff -setto claude-desktop <modelId> ...");
  }

  let r;
  try {
    r = await applyClaudeDesktop({
      picks,
      preferred: loadPreferredModel() || getPreferredModel() || "",
      port,
      token,
      max: maxRaw !== undefined ? Number(maxRaw) : undefined,
      maxEffort: effortRaw !== undefined ? String(effortRaw) : undefined,
      noAlias: flags.includes("--no-alias"),
      probe: flags.includes("--check"),
    });
  } catch (err) {
    console.error(`failed to sync to claude-desktop: ${String(err?.message || err)}`);
    process.exit(1);
  }

  console.log(`synced to claude-desktop: ${r.action} ${r.changed ? "" : "（已是目标状态，未改字节）"}@ ${r.dir}`);
  console.log(`  profile: ${r.configFile}`);
  console.log(`  登记:    ${r.metaFile}  appliedId=${r.configId}`);
  console.log(`  baseUrl: http://127.0.0.1:${port}  （App 自己拼 /v1/messages）  scheme=bearer`);
  console.log(`  inferenceModels: ${r.rows.length} 行（槽位 → 真模型）`);
  for (const row of r.rows) console.log(`    ${row.slot.padEnd(28)} ${slotRole(row.slot).padEnd(7)} → ${row.model}`);
  if (r.overflow) console.log(`  ⚠ 勾选集 ${r.rows.length + r.overflow} 条 > 槽位上限 ${r.slotCap}，已截断 ${r.overflow} 条（${r.dropped.slice(0, 3).join(", ")}${r.dropped.length > 3 ? " …" : ""}）；想换哪条上槽用 -setto claude-desktop <modelId> ...`);
  if (!r.aliasSkipped) {
    console.log(`  alias: ${r.aliasAdded.length} 条新增/确认、${r.aliasOverwritten.length} 条覆盖 → ${r.aliasFile}（daemon 热读，不用重启）`);
    for (const a of r.aliasOverwritten) console.log(`    ⚠ 覆盖 ${a.slot}: ${a.from} → ${a.to}`);
    console.log(`    ℹ 这些槽位 id 现在对**所有客户端**都指向池子模型（含终端里的 claude CLI）；不想动 alias 加 --no-alias`);
  } else {
    console.log(`  alias: 跳过（--no-alias）—— ⚠ 桌面端发来的槽位 id 会因无映射被当未知模型丢组员转发，30~90s 后 502`);
  }
  if (r.managed.managed) console.log(`  ⚠ 检测到托管策略（${r.managed.source}）：${r.managed.note}`);
  for (const b of r.backups) console.log(`  backup: ${b}`);
  for (const t of r.tmpLeftover) console.error(`  ⚠ 临时文件清理失败：${t}（内含明文 token，请手动删除）`);
  if (r.probes.length) {
    console.log(`  探活（本机 /v1/messages，max_tokens=16）:`);
    for (const p of r.probes) console.log(`    ${p.model.padEnd(28)} ${p.ok ? "✓" : "✗"} ${(p.ms + "ms").padEnd(8)} ${(p.actualModel || "-").padEnd(28)} ${p.ok ? "200" : p.error}`);
  }
  console.log(`  下一步：① mslxdff -claude-desktop check 逐槽验证 ② **完全退出并重启 Claude Desktop**（App 不热重载）③ 登录界面选这份 3P 配置`);
  console.log(`  ⚠ token 轮换后需重跑本命令（profile 里存的是明文 key）`);
  process.exit(0);
}

/** 位置参数 / 开关 / 带值参数三分（`--max`、`--max-effort`、`--port` 的值不得当成模型 id）。 */
export function splitArgs(rest = []) {
  const positional = [];
  const flags = [];
  const values = {};
  let missing = "";
  for (let i = 0; i < rest.length; i++) {
    const a = String(rest[i]);
    if (a === "--max" || a === "--max-effort" || a === "--port") {
      flags.push(a);
      const v = rest[++i];
      if (v === undefined || String(v).startsWith("-")) { missing = a; break; }
      values[a] = String(v);
      continue;
    }
    if (a.startsWith("-")) { flags.push(a); continue; }
    positional.push(a);
  }
  return { positional, flags, values, missing };
}
