const DEFAULT_MAX_BACKOFF_MS = 30000;

/** Always return a finite, non-negative delay, even for malformed retry inputs. */
export function computeBackoff(baseMs: number, attempt: number, jitterMs = 0, maxMs = DEFAULT_MAX_BACKOFF_MS): number {
  const base = Number.isFinite(baseMs) ? Math.max(0, baseMs) : 0;
  const tries = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const limit = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : DEFAULT_MAX_BACKOFF_MS;
  const exponent = Math.min(1024, tries - 1);
  const exponential = base * 2 ** exponent;
  const capped = Math.min(exponential, limit);
  const jitter = Number.isFinite(jitterMs) ? Math.max(0, Math.floor(jitterMs)) : 0;
  if (jitter === 0) return capped;
  const offset = (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.min(limit, capped + offset));
}
