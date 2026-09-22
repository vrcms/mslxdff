// qoder 上游请求装配（纯函数，无网络）：OpenAI body → COSY 签名请求（url/headers/bodyStr）。
// 从 chat.js 拆出，使真流式/聚合两条管线共享同一装配口（单一来源，防两处签名漂移）。
import { getEndpoints, normalizeRegion } from "./constants.js";
import { buildCosyHeaders, pathSigFrom } from "./session.js";
import { cosyEncode } from "./encode.js";
import { buildQoderBody, mapModel } from "./payload.js";

export function buildUpstreamRequest({ sess, region, model, messages, tools, maxTokens }) {
  const upstreamModel = mapModel(model);
  const { body, mcSource } = buildQoderBody({
    template: undefined,
    userType: sess?.identity?.userType,
    model: upstreamModel,
    messages,
    tools,
    maxTokens,
  });
  const ep = getEndpoints(normalizeRegion(region));
  const url = ep.chatStreamURL;
  const bodyStr = cosyEncode(Buffer.from(JSON.stringify(body)));
  const headers = buildCosyHeaders(sess, pathSigFrom(url), bodyStr, "text/event-stream");
  headers["x-model-key"] = upstreamModel;
  headers["x-model-source"] = mcSource;
  headers["accept"] = "text/event-stream";
  return { url, headers, bodyStr, upstreamModel, mcSource };
}
