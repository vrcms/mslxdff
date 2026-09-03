/**
 * 工具执行层 — 从 engine.js 抽出的工具段。
 * buildDedupKey 纯函数（去重键归一）；runTool 执行单工具调用并返回结果文本。
 * SKIPPED_DUP/forceNoTools 状态机仍在 engine runTurn 侧。
 */
export function buildDedupKey(name, args = {}) {
  if (name === "run_command") {
    const cmd = String(args.command || "").trim().toLowerCase().replace(/\s+/g, " ");
    const norm = cmd.replace(/^-+providers\b/, "-provider").replace(/\s+/g, " ").trim();
    return `run_command:${norm}`;
  }
  if (name === "curl") {
    const u = String(args.url || "").trim().toLowerCase();
    const m = String(args.method || "GET").toUpperCase();
    return `curl:${m}:${u}:${String(args.body || "").slice(0, 200)}`;
  }
  if (name === "read_file") {
    return `read_file:${String(args.path || "").trim().toLowerCase()}`;
  }
  return `${name}:${JSON.stringify(args)}`;
}

export async function runTool({
  name,
  args = {},
  userText = "",
  execCommand = async () => ({ ok: false, output: "no exec" }),
  readFileTool = async () => ({ ok: false, output: "no read" }),
  curlTool = async () => ({ ok: false, output: "no curl" }),
  onTrace = () => {},
} = {}) {
  const t1 = performance.now();
  if (name === "run_command") {
    const cmd = String(args.command || "").trim();
    const r = await execCommand(cmd);
    let result = `${r.ok ? "OK" : "FAIL"}: ${r.output}`;
    const lowCmd = cmd.toLowerCase().replace(/\s+/g, " ").trim();
    const asksModel = String(userText || "").toLowerCase().includes("模型");
    const isOnceAndDone =
      /^-+(showtoken|status|s|providers?\b|model\b|group\b|log\b|workbuddy\b|free\b|autostart\b|plugins\b)/.test(lowCmd) ||
      lowCmd === "-provider list" || lowCmd === "-providers list";
    if (isOnceAndDone && r.ok) {
      if (asksModel && lowCmd.includes("-provider")) {
        result += `\n\n[提示：此命令仅显示供应商配置，不包含模型列表。用户问的是“有哪些模型”，请用系统提示中的“可用模型”按前缀过滤回答，或调 curl local/models，不要再调 provider list]`;
      } else {
        result += `\n\n[系统提示：此查询已完成，结果即答案，请直接用中文回答用户，禁止再调用相同或同类查询工具]`;
      }
    }
    onTrace(`[tool] run_command "${cmd.slice(0, 40)}" · ${Math.round(performance.now() - t1)}ms · ${r.ok ? "OK" : "FAIL"} ${r.output.length}字`);
    return result;
  }
  if (name === "read_file") {
    const r = await readFileTool(args);
    let result = `${r.ok ? "OK" : "FAIL"}: ${r.output.slice(0, 6000)}`;
    if (r.ok) result += `\n\n[系统提示：文件已读取，请直接基于内容回答，禁止重复读取同一文件]`;
    onTrace(`[tool] read_file ${args.path} · ${Math.round(performance.now() - t1)}ms · ${r.ok ? "OK" : "FAIL"} ${r.output.length}字`);
    return result;
  }
  if (name === "curl") {
    const u = String(args.url || "").trim();
    const r = await curlTool(args);
    const result = `${r.ok ? "OK" : "FAIL"}: ${r.output.slice(0, 6000)}`;
    onTrace(`[tool] curl ${u} · ${Math.round(performance.now() - t1)}ms`);
    return result;
  }
  return `unknown tool ${name}`;
}
