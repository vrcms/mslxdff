import { clientIp, json, readBody, parseHops } from "../helpers.js";
import { runHook } from "../../plugins.js";
import { createChatPipeline } from "../../chat-pipeline/index.js";

/**
 * ChatGateway 薄适配层：仅负责 HTTP I/O（readBody + request:received hook）→ 委托 ChatPipeline.execute
 * Policy/Order/AutoRace/hedge/peer/broadband 全部在 chat-pipeline 深模块内。
 */
export function createChatGateway(deps = {}) {
  const pipeline = createChatPipeline(deps);

  async function handle({ req, res }) {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, { error: "Invalid JSON body" });
    }
    if (deps.plugins?.length) {
      const rc = await runHook(deps.plugins, "request:received", {
        ip: clientIp(req),
        hops: parseHops(req.headers["x-mslxdff-hops"]),
        headers: { "content-type": req.headers["content-type"] },
        body,
      });
      for (const e of rc.errors) deps.logs?.appendEvent?.({ ts: Date.now(), type: "plugin-hook-error", hook: "request:received", plugin: e.plugin, error: e.error });
      const respond = rc.value?.respond;
      if (respond && typeof respond === "object") return json(res, respond.status || 200, respond.body ?? {});
    }
    req.body = body;
    try {
      await pipeline.execute({ req, res });
    } catch (err) {
      const msg = err?.message || String(err);
      if (!res.headersSent) return json(res, 502, { error: msg });
      try { res.end(); } catch {}
    }
  }

  return { handle };
}

// 薄适配：保持原 chatHandler 签名兼容
export async function chatHandler(ctx) {
  const gw = createChatGateway(ctx);
  return gw.handle(ctx);
}