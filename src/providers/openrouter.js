import { createGenericProvider } from "./generic.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export function createOpenRouterProvider({
  apiKeys,
  apiKey,
  baseUrl = process.env.MSLXDFF_OPENROUTER_BASE_URL || DEFAULT_BASE_URL,
  fetchImpl,
  headers,
  noAgent = false,
  ...rest
} = {}) {
  return createGenericProvider({
    id: "openrouter",
    baseUrl,
    apiKeys,
    apiKey,
    modelsPath: "/models",
    chatPath: "/chat/completions",
    headers: {
      "HTTP-Referer": process.env.MSLXDFF_OPENROUTER_REFERER || "https://github.com/mslxdff",
      "X-Title": process.env.MSLXDFF_OPENROUTER_TITLE || "mslxdff",
      ...(headers || {}),
    },
    mapModel: (raw) => raw.filter((m) => Number(m.pricing?.prompt || 0) === 0 && Number(m.pricing?.completion || 0) === 0),
    fetchImpl,
    noAgent,
    ...rest,
  });
}
