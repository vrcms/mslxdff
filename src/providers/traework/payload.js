// OpenAI → SOLO llm_utils_chat 请求体改写（照抄 traework2api internal/upstream/payload.go）。
import { DEFAULT_MODEL, FUNCTION } from "./constants.js";

// tool_choice 归一化（上游 Go struct 是 string 类型）。
export function normalizeToolChoice(obj) {
  const suppress = () => { delete obj.tools; delete obj.functions; };
  if (!("tool_choice" in obj)) return;
  const tc = obj.tool_choice;
  if (typeof tc === "string") {
    if (String(tc).trim().toLowerCase() === "none") { delete obj.tool_choice; suppress(); }
    return;
  }
  if (tc && typeof tc === "object" && !Array.isArray(tc)) {
    const typ = String(tc.type || "").trim().toLowerCase();
    if (typ === "none") { delete obj.tool_choice; suppress(); }
    else if (typ === "auto" || typ === "required") obj.tool_choice = typ;
    else if (typ === "function") {
      const name = String(tc.function?.name || tc.name || "").trim();
      obj.tool_choice = name || "auto";
    } else delete obj.tool_choice;
    return;
  }
  delete obj.tool_choice;
}

// tools：缺 function 剔除；function.parameters 对象 → JSON 字符串。
export function normalizeTools(obj) {
  const raw = obj.tools;
  if (raw === undefined) return;
  if (!Array.isArray(raw) || !raw.length) return;
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const fn = item.function;
    if (!fn || typeof fn !== "object") continue;
    if (fn.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)) {
      try { fn.parameters = JSON.stringify(fn.parameters); } catch {}
    }
    out.push(item);
  }
  if (!out.length) { delete obj.tools; return; }
  obj.tools = out;
}

// 单 pass 改写；无法解析时原样返回。
export function prepareBody(src) {
  let obj;
  if (typeof src === "string") {
    if (!src) return src;
    try { obj = JSON.parse(src); } catch { return src; }
  } else if (src && typeof src === "object") {
    obj = { ...src };
  } else return src;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return src;
  obj.stream = true;
  obj.function = FUNCTION;
  if (Array.isArray(obj.messages)) {
    for (const mi of obj.messages) {
      if (!mi || typeof mi !== "object") continue;
      if (mi.role === "assistant" && Array.isArray(mi.tool_calls)) {
        const kept = [];
        for (const tci of mi.tool_calls) {
          if (!tci || typeof tci !== "object") continue;
          const tc = { ...tci };
          if (tc.function && typeof tc.function === "object") {
            tc.function_call = tc.function;
            delete tc.function;
          }
          const fc = tc.function_call;
          if (fc && typeof fc === "object" && !String(fc.name || "").trim()) continue;
          kept.push(tc);
        }
        if (!kept.length) delete mi.tool_calls;
        else mi.tool_calls = kept;
      }
      if (!("content" in mi) || mi.content == null) continue;
      if (typeof mi.content === "string") mi.content = [{ type: "text", text: mi.content }];
    }
  }
  let model = String(obj.model || "").trim() || DEFAULT_MODEL;
  obj.config_name = model;
  obj.model = model;
  normalizeToolChoice(obj);
  normalizeTools(obj);
  return obj;
}
