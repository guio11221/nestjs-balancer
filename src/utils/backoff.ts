const DEFAULT_MAX_BACKOFF_MS = 30000;

export function computeBackoff(baseMs: number, attempt: number, jitterMs = 0, maxMs = DEFAULT_MAX_BACKOFF_MS): number {
  const safeBase = Math.max(0, baseMs);
  const safeAttempt = Math.max(1, attempt);
  const exponential = safeBase * 2 ** (safeAttempt - 1);
  const limit = maxMs > 0 ? maxMs : exponential;
  const capped = Math.min(exponential, limit);
  if (jitterMs <= 0) return capped;
  const jitter = Math.floor(Math.random() * (jitterMs * 2 + 1)) - jitterMs;
  return Math.max(0, Math.min(limit, capped + jitter));
}
