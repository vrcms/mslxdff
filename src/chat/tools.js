import { execFile } from "node:child_process";
import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FORBIDDEN } from "./config.js";
import { logDir } from "../logs.js";
import { defaultStateFile } from "../state.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const allowedRoots = [
  resolve(pkgRoot),
  resolve(logDir()),
  resolve(dirname(defaultStateFile())),
  resolve(process.cwd()),
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
        description: "执行一条 mslxdff CLI 命令（不含 mslxdff 前缀）。仅限 cli_help_mini 所列命令，禁止 -uninstall。",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "例如: -model set hy3-free 或 -group list 或 -log 20" },
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
  const bin = join(pkgRoot, "bin/mslxdff.js");
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { timeout: 15000, maxBuffer: 1024 * 500 }, (e, stdout, stderr) => {
      const out = String(stdout || "") + (stderr ? `\n${stderr}` : "");
      if (e) {
        // 命令自身 exit 1 也算“执行过”，把输出返回给模型判断
        resolve({ ok: false, output: out.slice(0, 8000) || String(e.message).slice(0, 2000) });
      } else {
        resolve({ ok: true, output: out.slice(0, 8000) || "(no output)" });
      }
    });
  });
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
