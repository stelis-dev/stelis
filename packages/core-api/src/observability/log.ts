/**
 * Package-level observability API.
 *
 * Wraps the server-interior sink helpers (`structuredEventLog.ts`,
 * `sponsorPoolEventLog.ts`) under a single dedicated subpath so
 * cross-package consumers (app-api) never reach into the
 * interior directly. The interior helpers intentionally retain their
 * "package-level observability APIs should wrap this helper rather
 * than exposing it directly" policy at the source level; this file
 * is that wrapper.
 *
 * Level union is `'info' | 'warn' | 'error'` so the single sink path
 * can route all three without a parallel helper.
 */

export { logStructuredEvent, type StructuredEventLogLevel } from '../structuredEventLog.js';
export { logSponsorPoolEvent, type SponsorPoolEventLevel } from '../sponsorPoolEventLog.js';
