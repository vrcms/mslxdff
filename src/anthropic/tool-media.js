/**
 * 工具结果里的媒体：抽取 → 排队 → 冲刷成一条 user 消息。
 *
 * 1:1 照抄 cc-switch `src-tauri/src/proxy/tool_media.rs:40-145`：
 *  · 抽取：把 tool_result content 里的媒体块**原地换成一行文本标记**，媒体本体单独收起来；
 *    原本是字符串的 content 抽完仍是字符串（给原始 data URL / 字符串化 JSON 再套一层引号
 *    会改变模型看到的东西）；原本是结构化的则走 canonical JSON。
 *  · 排队：把 `[media output of tool call <id>]` 文本 + 媒体挂在待冲刷表上。
 *  · 冲刷：**在同轮的普通消息之前**插一条 `role:"user"` 消息承载全部媒体 ——
 *    OpenAI Chat 的 `role:"tool"` 消息不能带图片分片，故媒体必须另开一条 user 轮。
 *
 * 为什么在 /v1/messages 做：改前这里是**静默丢图**（tool_result 里的截图/图片直接消失），
 * 模型看不到用户给的图，只能靠文字猜。
 */

export const MEDIA_MOVED_MARKER = "[mslxdff: media moved to the following user turn]";

/**
 * Anthropic 图片块 → OpenAI Chat 图片分片（base64 / url 两种 source）。
 * 本仓唯一的「块 → 分片」判据，request-body 的 user 消息图片也走它。
 * @param {any} block
 * @returns {{type: "image_url", image_url: {url: string}} | null}
 */
export function imagePartOf(block) {
  const src = block?.source || {};
  if (src.type === "base64" && src.data) {
    return { type: "image_url", image_url: { url: `data:${src.media_type || "image/png"};base64,${src.data}` } };
  }
  if (src.type === "url" && src.url) return { type: "image_url", image_url: { url: String(src.url) } };
  return null;
}

/** 递归把媒体块换成文本标记，媒体本体收进 out。返回替换个数。 */
function stripMedia(value, out) {
  if (Array.isArray(value)) return value.map((v) => stripMedia(v, out));
  if (value && typeof value === "object") {
    const part = imagePartOf(value);
    if (part) {
      out.push(part);
      return { type: "text", text: MEDIA_MOVED_MARKER };
    }
    const o = {};
    for (const k of Object.keys(value)) o[k] = stripMedia(value[k], out);
    return o;
  }
  return value;
}

/**
 * 规划一条 tool_result 的 content：抽出媒体并给出 tool 消息该放的文本。
 * @param {unknown} content Anthropic tool_result 的 content（字符串或块数组）
 * @param {(v: unknown) => string} canonicalJson 键序规范化序列化（避免本模块反向依赖）
 * @returns {{text: string, media: any[]} | null} 无媒体返回 null（保持旧字节不变）
 */
export function planToolResultMedia(content, canonicalJson) {
  const wasString = typeof content === "string";
  const media = [];
  const replaced = stripMedia(content, media);
  if (!media.length) return null;
  const text = wasString ? String(replaced) : canonicalJson(replaced);
  return { text, media };
}

/** 把一条工具调用的媒体挂到待冲刷表（照抄 queue_chat_tool_output_media）。 */
export function queueToolMedia(pending, toolUseId, media) {
  if (!Array.isArray(media) || !media.length) return;
  pending.push({ type: "text", text: `[mslxdff: media output of tool call ${toolUseId}]` });
  pending.push(...media);
}

/** 冲刷成一条 user 消息（照抄 flush_pending_chat_tool_media：整批一起给，顺序不变）。 */
export function flushToolMedia(messages, pending) {
  if (!pending.length) return;
  messages.push({ role: "user", content: pending.splice(0, pending.length) });
}
