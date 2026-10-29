export type RetryReason = 'network' | 'timeout' | 'connect';

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'EIDLETIMEOUT', 'EREQUESTTIMEOUT', 'ESOCKETTIMEDOUT']);
const CONNECT_CODES = new Set(['ECONNECTTIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function classifyError(error: unknown): RetryReason {
  const code = errorCode(error);
  if (code === 'ECONNECTTIMEOUT') return 'connect';
  if (code && TIMEOUT_CODES.has(code)) return 'timeout';
  if (code && CONNECT_CODES.has(code)) return 'connect';
  return 'network';
}
