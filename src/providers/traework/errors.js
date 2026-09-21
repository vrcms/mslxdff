// SOLO 上游错误分类（照抄 traework2api internal/upstream/client.go Classify）。
export const ErrKind = {
  NONE: "none",
  PLAN_LIMIT: "plan_limit",
  SOFT_RATE: "soft_rate",
  SESSION_DEAD: "session_dead",
  NOT_FOUND: "not_found",
  SERVER: "server",
  CLIENT: "client",
};

// 长冷却时长：plan_limit → 12h。
export const PLAN_COOLDOWN_MS = 12 * 60 * 60 * 1000;
export const SOFT_COOLDOWN_MS = 60 * 1000;

const SESSION_DEAD_MARKERS = ["login", "token 失效", "token invalid", "session", "unauthorized", "401"];

export class UpstreamError extends Error {
  constructor(kind, status, msg) {
    super(`upstream ${kind} (http ${status}): ${msg}`);
    this.kind = kind;
    this.status = status;
  }
}

// 流内业务错误（event:error）。
export class SOLOStreamError extends Error {
  constructor(code, msg) {
    super(`solo error code=${code} msg=${msg}`);
    this.code = code;
    this.msg = msg;
  }
  kind() { return this.code === 1005 ? ErrKind.PLAN_LIMIT : ErrKind.CLIENT; }
}

export function classify(status, body) {
  const txt = String(body || "");
  const lower = txt.toLowerCase();
  if (txt.includes('"code":1005') || (txt.includes("1005") && lower.includes("plan"))) return ErrKind.PLAN_LIMIT;
  if (status === 401) return ErrKind.SESSION_DEAD;
  if (status === 429) return ErrKind.SOFT_RATE;
  if (status === 404) return ErrKind.NOT_FOUND;
  if (status >= 500) return ErrKind.SERVER;
  if (status >= 400) return ErrKind.CLIENT;
  return ErrKind.NONE;
}

export function isSessionDead(status, body) {
  if (status === 401) return true;
  const lower = String(body || "").toLowerCase();
  return SESSION_DEAD_MARKERS.some((m) => lower.includes(m.toLowerCase()));
}
