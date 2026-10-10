/**
 * 入站协议门短码（api kind）——「这一发是从哪扇门进来的」的唯一判定。
 *
 * 为什么单独成模块：三道门（`/v1/chat/completions`、`/v1/responses`、`/v1/messages`）汇入同一条
 * ChatPipeline、同一批模型，四类日志形状完全相同 → 门信息一旦在各写点各判一次，就会出现第二份
 * 前缀匹配并迟早互相漂移。故判定**只做一次**（ChatPipeline inlet），结果随 `handlerCtx` 透传。
 *
 * 缺值口径：认不出的路 = `other`（恒有值、绝不空串/undefined）；**写点拿不到值时省略该字段**，
 * 使「缺字段」只可能是旧行或漏传，而不会被误读成一次未知门的判定。
 */

export const API_KINDS = ["chat", "responses", "messages", "other"];
export const API_KIND_OTHER = "other";

/**
 * 路径 → 短码。只认段边界：`/v1/messagesXYZ` 不是 `/v1/messages` 的子段（那是别的路由，不许冒充门）。
 * query（`?beta=true`）与 `count_tokens` 子路径都归同一扇门。
 */
export function apiKindOfUrl(url) {
  if (typeof url !== "string" || !url) return API_KIND_OTHER;
  const path = url.split("?")[0].split("#")[0];
  if (path === "/v1/chat/completions" || path.startsWith("/v1/chat/completions/")) return "chat";
  if (path === "/v1/responses" || path.startsWith("/v1/responses/")) return "responses";
  if (path === "/v1/messages" || path.startsWith("/v1/messages/")) return "messages";
  return API_KIND_OTHER;
}

/** req → 短码（读 `req.url`；缺失/非字符串 = `other`）。 */
export function apiKindOf(req) {
  return apiKindOfUrl(req && typeof req === "object" ? req.url : undefined);
}
