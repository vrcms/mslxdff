import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { compatFetch, timeoutSignal } from "../compat.js";
import { loadModelAliases, snapshotModelAliases } from "../providers/model-id.js";

/**
 * Claude Desktop on 3P 的只读体检面（`-claude-desktop status|slots|check`）。
 * 三态分开、各不越界：`status` 只读盘、`slots` 只读 App 目录、`check` 才发请求。
 * 目的：App 里那个 "Test connection" 只会给你一个红点，这里要给出**是哪一环坏**（托管策略吞了本地配置？
 * profile 没登记？槽位没 alias？网关没起？模型上游 502？），以及下一步命令。
 */

/** 托管策略探测：App 的规则是「机器策略一旦存在，本地 configLibrary 与用户策略整体被忽略」。 */
export function detectManagedPolicy({ platform = process.platform, env = process.env, run = spawnSync } = {}) {
  const out = { managed: false, machinePolicy: false, source: "", note: "" };
  if (platform === "win32") {
    // reg.exe 的输出表头随系统语言变（"Found 3 value(s)" / "找到 3 个值"），所以计数不认表头，
    // 只认值行本身：`    <名称>    REG_SZ    <数据>` —— 类型标记恒为 ASCII。
    const probe = (key) => {
      try {
        const r = run("reg", ["query", key], { encoding: "utf8" });
        if (r?.status !== 0) return { ok: false, values: 0 };
        const rows = String(r.stdout || "").split(/\r?\n/).filter((l) => /^\s+\S+\s+REG_/.test(l));
        return { ok: true, values: rows.length };
      } catch { return { ok: false, values: 0 }; }
    };
    if (!probe("HKCU\\SOFTWARE").ok) {
      out.note = "reg.exe 读不动（权限或环境受限）→ 托管策略以 App 的 Help → Troubleshooting → Generate Diagnostic Report 为准";
      return out;
    }
    const hklm = probe("HKLM\\SOFTWARE\\Policies\\Claude");
    const hkcu = probe("HKCU\\SOFTWARE\\Policies\\Claude");
    if (hklm.values > 0) {
      out.managed = true; out.machinePolicy = true; out.source = "HKLM\\SOFTWARE\\Policies\\Claude";
      out.note = `机器策略有 ${hklm.values} 个值 → App 整体忽略 HKCU 策略与本地 configLibrary，本工具写的配置不会生效（要么改由 MDM 下发，要么清掉这些策略值）`;
    } else if (hkcu.values > 0) {
      out.managed = true; out.source = "HKCU\\SOFTWARE\\Policies\\Claude";
      out.note = `用户策略有 ${hkcu.values} 个值 → 它是托管源、优先于本地 configLibrary（同名键被忽略）；要么把这套键写进策略，要么清掉策略值`;
    } else out.note = "未见托管策略值，本地 configLibrary 生效";
    return out;
  }
  if (platform === "darwin") {
    const p = "/Library/Managed Preferences/com.anthropic.claudefordesktop.plist";
    if (existsSync(p)) { out.managed = true; out.machinePolicy = true; out.source = p; out.note = "托管配置存在 → 本地 configLibrary 被忽略，in-app 窗口也会是只读"; }
    else out.note = "未见托管 plist，本地 configLibrary 生效";
    return out;
  }
  const lp = "/etc/claude-desktop/managed-settings.json";
  if (existsSync(lp)) { out.managed = true; out.machinePolicy = true; out.source = lp; out.note = "root 所有的托管文件存在 → 本地 configLibrary 被忽略"; }
  else out.note = "未见 /etc/claude-desktop/managed-settings.json，本地 configLibrary 生效";
  return out;
}

/** App 目录父路径（configLibrary 的同级就是 Claude-3p 根）。 */
export function appDataDirOf(configDir) {
  const s = String(configDir || "");
  return s.replace(/[\\/]+configLibrary[\\/]*$/i, "") || s;
}

/**
 * 解 App 自带的签名模型目录 → 它「认得」的模型 id 集合（槽位清单的实况来源）。
 * 文件是 `{documentBytes: base64(JSON)}`，JSON 里 `surfaces.<cc|ccd|ccr|chat|cowork>.model_selector_state[]`。
 */
export function readAppCatalogIds({ appDir } = {}) {
  const out = { ok: false, file: "", version: null, ids: [], error: "" };
  if (!appDir) { out.error = "未给 appDir"; return out; }
  const file = join(appDir, "model-catalog", "published.json");
  out.file = file;
  if (!existsSync(file)) { out.error = "App 还没落模型目录（首次联网启动后才有）"; return out; }
  let doc;
  try {
    const wrapper = JSON.parse(readFileSync(file, "utf8"));
    if (!wrapper?.documentBytes) throw new Error("缺 documentBytes");
    doc = JSON.parse(Buffer.from(String(wrapper.documentBytes), "base64").toString("utf8"));
    out.version = doc?.version ?? null;
  } catch (e) {
    out.error = `解析失败：${String(e?.message || e)}`;
    return out;
  }
  const set = new Set();
  const surfaces = doc?.surfaces && typeof doc.surfaces === "object" ? doc.surfaces : {};
  for (const s of Object.values(surfaces)) {
    const rows = Array.isArray(s?.model_selector_state) ? s.model_selector_state : [];
    for (const r of rows) {
      if (r?.model) set.add(String(r.model));
      if (r?.id) set.add(String(r.id));
      for (const alt of (Array.isArray(r?.thinking_by_model) ? r.thinking_by_model : [])) {
        if (alt?.id) set.add(String(alt.id));
      }
    }
  }
  out.ids = [...set].filter((x) => x.startsWith("claude-")).sort();
  out.ok = out.ids.length > 0;
  if (!out.ok) out.error = "目录里没解析出任何 claude-* 模型 id";
  return out;
}

/** alias 表现状（只读快照，先装载再取）。 */
export function currentAliases() {
  try { loadModelAliases(); } catch { /* 文件不存在=空表 */ }
  return snapshotModelAliases();
}

/**
 * 单槽探活：向本机 `/v1/messages` 发一发 1-token 请求，看网关是否把槽位翻译成能跑的真模型。
 * `max_tokens` 给 16 而非 1：思考型模型会把极小预算全花在 reasoning 上、吐空正文轮（ADR-0043 那条路上游即 502）。
 */
export async function probeMessages({ port = 8989, token = "", model = "", timeoutMs = 90000, fetchImpl } = {}) {
  const started = Date.now();
  const out = { model, ok: false, status: 0, ms: 0, actualModel: "", text: "", error: "" };
  if (!token) { out.error = "无 token（mslxdff -showtoken）"; out.ms = 0; return out; }
  const doFetch = fetchImpl || compatFetch;
  try {
    const res = await doFetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      signal: timeoutSignal(timeoutMs),
    });
    out.status = res.status || 0;
    out.actualModel = String(res.headers?.get?.("x-mslxdff-actual-model") || "");
    let bodyText = "";
    try { bodyText = await res.text(); } catch { /* 读不到体也不覆盖状态码 */ }
    out.ms = Date.now() - started;
    if (out.status === 200) {
      out.ok = true;
      try {
        const j = JSON.parse(bodyText);
        const first = Array.isArray(j?.content) ? j.content.find((c) => c?.type === "text") : null;
        out.text = String(first?.text || "").slice(0, 40);
      } catch { out.text = "(响应体非 JSON)"; }
    } else {
      out.error = (bodyText || "").slice(0, 160) || `HTTP ${out.status}`;
    }
    return out;
  } catch (e) {
    out.ms = Date.now() - started;
    out.error = String(e?.message || e);
    return out;
  }
}
