export function backoffDelay(baseMs, attempt) {
  // attempt 0 => base, 1 => base*2, 2 => base*4
  return baseMs * (1 << attempt);
}

export function resolveRetry(status, attempt, config) {
  const key = status === "network" ? "network" : String(status);
  const entry = config?.[key];
  if (!entry) return { shouldRetry: false, delayMs: 0 };
  const attempts = Number(entry.attempts) || 0;
  const base = Number(entry.delayMs) || 0;
  if (attempt < attempts) {
    return { shouldRetry: true, delayMs: backoffDelay(base, attempt) };
  }
  return { shouldRetry: false, delayMs: 0 };
}

export function shouldRetry(status, attempt, config) {
  return resolveRetry(status, attempt, config).shouldRetry;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
