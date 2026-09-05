import { execFile } from "node:child_process";
import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { FORBIDDEN } from "./config.js";
import { logDir } from "../logs.js";
import { defaultStateFile, loadProviderKeys, loadProviderConfigs } from "../state.js";
import { compatFetch } from "../compat.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const allowedRoots = [
  resolve(pkgRoot),
  resolve(logDir()),
  resolve(dirname(defaultStateFile())),
];

function isAllowed(p) {
  const abs = resolve(p);
  // 展开 ~/ 形式
  const expanded = abs.startsWith("~/") ? join(process.env.HOME || process.env.USERPROFILE || "", abs.slice(2)) : abs;
  const chk = resolve(expanded);
  return allowedRoots.some((r) => chk === r || chk.startsWith(r + "/") || chk.startsWith(r + "\\"));
}

function parseCommand(str) {
  // 支持引号包裹
  const out = [];
  let cur = "";
  let q = null;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q) {
      if (c === q) q = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
    } else if (c === " " || c === "\t") {
      if (cur) { out.push(cur); cur = ""; }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function getToolDefs() {
  return [
    {
      type: "function",
      function: {
        name: "run_command",
        description: "执行一条 mslxdff CLI 命令（不含 mslxdff 前缀）。仅限 cli_help_mini 所列命令，禁止 -uninstall；禁止 mslxdff \"hi\" --model X / --model X \"hi\" / -chat --model X 等幻觉命令，探活模型必须用 curl 工具 POST 本机 /v1/chat/completions。",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "例如: -model set hy3-free 或 -group list 或 -log 20；模型探活禁止用此工具，必须用 curl POST http://localhost:8989/v1/chat/completions" },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "读取项目内的文件内容（src/ docs/ logs/ 等），用于查看日志或配置。禁止读取项目外文件。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "相对项目根或绝对路径，如 src/logs.js 或 ~/.config/mslxdff/events.log" },
            limit: { type: "number", description: "最多读取字符数，默认 8000" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "curl",
        description: "网络/HTTP 探活，检测上游或本机服务可用性。支持任意 http(s) URL，返回状态码、耗时、响应头与前几千字符。常用： upstream(上游模型列表)、local/health(本机健康)、local/models(本机模型列表)。探活指定模型必须用 POST http://localhost:8989/v1/chat/completions body {\"model\":\"<provider/模型>\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}。简写会自动补全为完整 URL。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "要请求的 URL 或简写：upstream、upstream/models、upstream/chat、local、local/health、local/models、health、models，或完整 http(s) URL" },
            method: { type: "string", description: "HTTP 方法，默认 GET", enum: ["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH", "OPTIONS"] },
            headers: { type: "object", description: "附加请求头，键值均为字符串", additionalProperties: { type: "string" } },
            body: { type: "string", description: "请求体（POST/PUT 时），字符串，如 JSON" },
            timeoutMs: { type: "number", description: "超时毫秒，默认 8000，最大 15000" },
          },
          required: ["url"],
        },
      },
    },
  ];
}

export function validateCommand(cmd) {
  const low = String(cmd || "").toLowerCase();
  for (const f of FORBIDDEN) if (low.includes(f)) return `forbidden: ${f} 已拦截，禁止执行`;
  return null;
}

export async function execCommand(command) {
  const err = validateCommand(command);
  if (err) return { ok: false, output: err };
  const args = parseCommand(String(command).trim());
  if (!args.length) return { ok: false, output: "empty command" };
  // 关键路径打点：exec 本身耗时（fork+加载）是 -chat 最大的本地开销，后续可改直调以省 300-500ms
  const bin = join(pkgRoot, "bin/mslxdff.js");
  const t0 = performance.now();
  const res = await new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { timeout: 15000, maxBuffer: 1024 * 500 }, (e, stdout, stderr) => {
      const out = String(stdout || "") + (stderr ? `\n${stderr}` : "");
      if (e) {
        resolve({ ok: false, output: out.slice(0, 8000) || String(e.message).slice(0, 2000) });
      } else {
        resolve({ ok: true, output: out.slice(0, 8000) || "(no output)" });
      }
    });
  });
  res._ms = Math.round(performance.now() - t0);
  return res;
}

export async function readFileTool({ path, limit }) {
  const raw = String(path || "").trim();
  if (!raw) return { ok: false, output: "empty path" };
  let target = raw;
  if (target.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    target = join(home, target.slice(2));
  } else if (!target.startsWith("/") && !/^[A-Za-z]:/.test(target)) {
    // 相对路径视作项目根相对
    target = join(pkgRoot, target);
  }
  if (!isAllowed(target)) return { ok: false, output: `not allowed: ${raw}（仅限项目目录或日志目录）` };
  try {
    if (!existsSync(target)) return { ok: false, output: `not found: ${raw}` };
    const st = statSync(target);
    if (st.isDirectory()) {
      // 列目录
      const { readdirSync } = await import("node:fs");
      const files = readdirSync(target).slice(0, 80);
      return { ok: true, output: `dir ${raw}:\n` + files.join("\n") };
    }
    const cap = Number(limit) > 0 ? Math.min(Number(limit), 20000) : 8000;
    const data = readFileSync(target, "utf8");
    const txt = data.length > cap ? data.slice(0, cap) + `\n... (truncated ${data.length - cap} chars)` : data;
    return { ok: true, output: txt || "(empty file)" };
  } catch (e) {
    return { ok: false, output: String(e.message).slice(0, 2000) };
  }
}

function resolveLocalPort() {
  // 复用 state 的端口优先级：state.port > MSLXDFF_PORT env > 8989
  try {
    const f = defaultStateFile();
    const j = JSON.parse(readFileSync(f, "utf8"));
    const p = j?.port;
    if (Number.isInteger(p) && p > 0) return p;
  } catch {}
  const env = Number(process.env.MSLXDFF_PORT);
  if (Number.isInteger(env) && env > 0) return env;
  return 8989;
}

function resolveLocalToken() {
  try {
    const f = defaultStateFile();
    const j = JSON.parse(readFileSync(f, "utf8"));
    const t = j?.token;
    if (typeof t === "string" && t.trim()) return t.trim();
  } catch {}
  return "";
}

function expandCurlUrl(raw) {
  const s = String(raw || "").trim();
  const low = s.toLowerCase();
  const port = resolveLocalPort();
  const localBase = `http://127.0.0.1:${port}`;
  // 完整 http(s) 直接用
  if (/^https?:\/\//i.test(s)) return s;
  // 简写映射
  if (low === "upstream" || low === "upstream/models" || low === "upstream/models/") return "https://opencode.ai/zen/v1/models";
  if (low === "upstream/chat" || low === "upstream/chat/completions") return "https://opencode.ai/zen/v1/chat/completions";
  if (low === "local" || low === "local/health" || low === "health") return `${localBase}/health`;
  if (low === "local/models" || low === "models" || low === "v1/models") return `${localBase}/v1/models`;
  if (low === "local/chat" || low === "v1/chat/completions") return `${localBase}/v1/chat/completions`;
  // 供应商简写：bai/models、openrouter/models 等 → 该供应商 baseUrl + /models
  const provMatch = low.match(/^([a-z0-9_-]+)\/models\/?$/);
  if (provMatch) {
    try {
      const pid = provMatch[1];
      const cfgs = loadProviderConfigs();
      const cfg = cfgs[pid];
      if (cfg?.baseUrl) return `${cfg.baseUrl.replace(/\/+$/, "")}/models`;
    } catch {}
  }
  // 裸路径视作本机相对
  if (s.startsWith("/")) return `${localBase}${s}`;
  return s;
}

export async function curlTool({ url, method, headers, body, timeoutMs }) {
  const raw = String(url || "").trim();
  if (!raw) return { ok: false, output: "empty url" };
  let target = expandCurlUrl(raw);
  // 仅允许 http(s)
  if (!/^https?:\/\//i.test(target)) return { ok: false, output: `only http(s) allowed: ${raw} -> ${target}` };
  let m = String(method || "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH", "OPTIONS"].includes(m)) return { ok: false, output: `unsupported method: ${m}` };
  const timeout = Math.min(Math.max(Number(timeoutMs) || 8000, 500), 15000);
  // 组装头
  const h = {};
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) if (typeof v === "string") h[String(k)] = v;
  }
  // 上游自动补最小可用头
  if (/opencode\.ai/i.test(target)) {
    if (!h["x-opencode-client"]) h["x-opencode-client"] = "desktop";
    if (!h["Authorization"] && !h["authorization"]) h["Authorization"] = "Bearer public";
    if (!h["Accept"]) h["Accept"] = m === "GET" ? "*/*" : "application/json";
    if (!h["Content-Type"] && m !== "GET" && m !== "HEAD") h["Content-Type"] = "application/json";
  }
  // 本机自动带 token（/v1/* 需要鉴权）；/v1/models 必须是 GET，模型常误用 POST 直接纠正
  if (/127\.0\.0\.1|localhost/i.test(target) && /\/v1\//i.test(target)) {
    const hasAuth = !!(h["Authorization"] || h["authorization"]);
    if (!hasAuth) {
      const tok = resolveLocalToken();
      if (tok) h["Authorization"] = `Bearer ${tok}`;
    }
    if (/\/v1\/models/i.test(target) && m === "POST") m = "GET";
  }
  // 已配置供应商自动带 key（curl 直连供应商时免手动传头）
  if (!h["Authorization"] && !h["authorization"]) {
    try {
      const cfgs = loadProviderConfigs();
      for (const [pid, cfg] of Object.entries(cfgs)) {
        const base = String(cfg?.baseUrl || "").replace(/\/+$/, "");
        if (!base) continue;
        if (target.toLowerCase().startsWith(base.toLowerCase())) {
          const keys = loadProviderKeys(pid);
          if (keys.length) { h["Authorization"] = `Bearer ${keys[0]}`; break; }
        }
      }
      // 兜底：api.b.ai 即 bai 供应商（env 或 state）
      if (!h["Authorization"] && /api\.b\.ai/i.test(target)) {
        const k = loadProviderKeys("bai")[0];
        if (k) h["Authorization"] = `Bearer ${k}`;
      }
    } catch {}
  }
  // fetch 走兼容层（undici 优先，老 Node 兜底）
  const fetchImpl = compatFetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`curl timed out after ${timeout}ms`)), timeout);
  const t0 = performance.now();
  try {
    const opts = { method: m, headers: h, signal: controller.signal };
    if (body != null && m !== "GET" && m !== "HEAD") opts.body = String(body);
    const res = await fetchImpl(target, opts);
    const ms = Math.round(performance.now() - t0);
    // 抓响应头（过滤成可读）
    const rh = {};
    try {
      for (const [k, v] of res.headers.entries()) rh[k] = v;
    } catch {}
    let txt = "";
    try {
      // 限制读取大小，避免超大 body
      const ab = await res.arrayBuffer();
      const buf = Buffer.from(ab);
      const lim = 6000;
      txt = buf.toString("utf8").slice(0, lim);
      if (buf.length > lim) txt += `\n... (truncated ${buf.length - lim} bytes)`;
    } catch (e) {
      txt = String(e.message || e).slice(0, 1000);
    }
    const headerLines = Object.entries(rh).slice(0, 20).map(([k, v]) => `${k}: ${v}`).join("\n");
    const out = [
      `${m} ${target}`,
      `status: ${res.status} ${res.statusText || ""}`.trim(),
      `latency: ${ms}ms`,
      headerLines ? `headers:\n${headerLines}` : "headers: (none)",
      `body (${txt.length} chars):`,
      txt || "(empty body)",
    ].join("\n");
    // 2xx 视为 ok，其余仍返回 ok:true 但带状态，便于模型判断（网络层面成功）
    return { ok: true, output: out.slice(0, 8000) };
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    return { ok: false, output: `curl failed: ${String(e.message || e).slice(0, 1200)}\nurl: ${target}\nlatency: ${ms}ms` };
  } finally {
    clearTimeout(timer);
  }
}
