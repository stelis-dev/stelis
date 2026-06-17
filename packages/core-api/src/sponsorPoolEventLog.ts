import { logStructuredEvent } from './structuredEventLog.js';

export type SponsorPoolEventLevel = 'info' | 'warn' | 'error';

export function logSponsorPoolEvent(
  event: string,
  payload: Record<string, unknown>,
  level: SponsorPoolEventLevel = 'info',
): void {
  logStructuredEvent(event, payload, level);
}
