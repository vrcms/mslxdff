import { createUpstreamClient } from "../upstream.js";
import { joinModelId } from "./model-id.js";

// opencode Provider：复用现有 createUpstreamClient 的全部能力（头/重试/匿名免费通道/keep-alive 预热），
// 模型 id 保持裸 id（向后兼容）。
export function createOpenCodeProvider({ upstream, modelsService, baseUrl, authToken, hooks } = {}) {
  const client = upstream ?? createUpstreamClient({ baseUrl, authToken, hooks });
  return {
    id: "opencode",
    upstream: client,
    chat: (body) => client.chat(body),
    preheat: (args) => client.preheat(args),
    close: () => client.close(),
    async listModels() {
      const data = await modelsService?.get?.();
      const list = data?.data ?? [];
      return list.map((m) => ({ ...m, id: joinModelId("opencode", m.id) }));
    },
  };
}