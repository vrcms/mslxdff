// relay 的读取层工具（从 stream.js 拆出：HEAD 版已 19.8KB / 20KB 硬门，先拆后写）。
// 全部是「不碰闸门、不碰 res、不碰计时」的纯 IO 适配：字节→文本、取消上游、注释帧判定、读取迭代。
// 语义与拆出前逐字一致 —— 这里只搬家，不改行为。
import { enrichSseChunkText, enrichNonStreamJson as enrichNonStreamJsonFn } from "./fallback.js";
import { extractUsageFromSseText as extractUsageFn } from "../metrics.js";
import { scanNonStreamBody as scanNonStreamBodyFn } from "./stream-scan.js";

// SDK 通道（TextEncoder）产出 Uint8Array，legacy 通道为 Buffer；
// 统一转文本，避免 [DONE]/finish_reason/usage/chars 统计在 SDK 路径下静默失效。
export function chunkText(chunk) {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return "";
}

// body.cancel() 可能返回非 Promise（自定义/AI SDK 流）——同步异常与 rejection 双路径都要吞掉
export function cancelBody(body) {
  try {
    const p = typeof body?.cancel === "function" ? body.cancel() : null;
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch { /* ignore */ }
}

// 注释帧（": keepalive" 等）不是模型输出：不算首块、不解除闸门、不触发超时救回，但照常透传
export function hasPayload(text) {
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith(":")) continue;
    return true;
  }
  return false;
}

/**
 * 非流式的「先判后写」：在 headers 还没 flush 之前解析上游体，决定能不能富化 / 是不是空轮。
 * 返回 { enriched, emptyTurn }：enriched=null 表示上游给的不是可解析 JSON（调用方走原文透传）；
 * emptyTurn=true 表示这一发是空轮、且留口是开的（调用方沿用留口语义，不写任何响应）。
 * 纯搬家：行为与拆出前逐字一致。
 */
export function scanNonStreamReply(detail, text, { fallback, holdEnd, isEmptyTurn, captureFallback }) {
  let enriched = null;
  try {
    const parsed = JSON.parse(text);
    scanNonStreamBodyFn(detail, parsed);
    enriched = enrichNonStreamJsonFn(parsed, fallback);
  } catch { /* 上游给的不是可解析 JSON：调用方走原文透传 */ }
  if (enriched === null) {
    // 纯文本时按长度估 chars；若文本其实是 SSE（client 未要流但上游给流）仍尝试提 usage
    try { detail.chars = text.length; } catch {}
    try { const u = extractUsageFn(text); if (u) detail.usage = u; } catch {}
    try { if (detail.talk) captureFallback(detail.talk, text); } catch {}
    return { enriched: null, emptyTurn: false };
  }
  const emptyTurn = Boolean(holdEnd() && !detail.downstreamClosed && isEmptyTurn(detail));
  return { enriched, emptyTurn };
}

// 上游回的是普通 reply（无流式 delta）时，客户端仍要看到增量：把整块按 fallback 富化成 SSE 帧。
// 只在首块前、且本轮尚未写出 payload 时调用一次；解析不出就原样返回（绝不改字节）。
export function enrichFirstReply(chunk, fallback) {
  if (!fallback?.fallback) return chunk;
  try {
    const txt = chunkText(chunk);
    if (!txt.includes("data:")) return chunk;
    const enriched = enrichSseChunkText(txt, fallback);
    return enriched !== txt ? Buffer.from(enriched, "utf8") : chunk;
  } catch {
    return chunk;
  }
}

// 自持 reader 优先：for-await 会锁定 ReadableStream，使 body.cancel() 必 reject（真流上等于空操作），
// 超时/断下游要真能掐上游必须走 reader.cancel()
export async function* bodyChunks(body, reader) {
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  }
  for await (const c of body) yield c;
}
