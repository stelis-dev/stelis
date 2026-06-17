/**
 * Redact query string from URL for safe logging/admin display.
 * API keys may be in query params — redact them to prevent log leakage.
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.search ? `${u.origin}${u.pathname}?[REDACTED]` : raw;
  } catch {
    return raw;
  }
}
