const RETRY_AFTER_FALLBACK_MS = 0;
const RETRY_AFTER_MILLISECONDS_PER_SECOND = 1000;

export function formatRetryAfterSeconds(retryAfterMs: number | undefined): string {
  return String(
    Math.ceil((retryAfterMs ?? RETRY_AFTER_FALLBACK_MS) / RETRY_AFTER_MILLISECONDS_PER_SECOND),
  );
}
