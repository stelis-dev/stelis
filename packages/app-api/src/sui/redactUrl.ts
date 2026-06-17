/**
 * Redact endpoint URLs for safe logging/admin display.
 * API keys and provider tokens can appear in either path or query fields.
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const redactedPath = u.pathname === '/' ? '' : '/[REDACTED]';
    const redactedSearch = u.search ? '?[REDACTED]' : '';
    return `${u.origin}${redactedPath}${redactedSearch}`;
  } catch {
    return '[INVALID_URL]';
  }
}
