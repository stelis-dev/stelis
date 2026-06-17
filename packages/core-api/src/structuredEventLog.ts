export type StructuredEventLogLevel = 'info' | 'warn' | 'error';

/**
 * Internal structured event logger shared by non-public runtime modules.
 *
 * Public/package-level observability APIs should wrap this helper rather than
 * exposing it directly. The package-level wrapper lives at
 * `packages/core-api/src/observability/` and is re-exported through the
 * `@stelis/core-api/observability` subpath.
 */
export function logStructuredEvent(
  event: string,
  payload: Record<string, unknown>,
  level: StructuredEventLogLevel = 'info',
): void {
  const line = JSON.stringify({ event, ...payload });
  if (level === 'error') {
    // eslint-disable-next-line no-console -- intentional structured operations log
    console.error(line);
    return;
  }
  if (level === 'warn') {
    // eslint-disable-next-line no-console -- intentional structured operations log
    console.warn(line);
    return;
  }
  // eslint-disable-next-line no-console -- intentional structured operations log
  console.info(line);
}
