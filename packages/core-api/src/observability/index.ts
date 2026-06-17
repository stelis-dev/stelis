/**
 * @stelis/core-api/observability — public observability API.
 *
 * Exposes structured-event logging helpers and event names.
 * Cross-package consumers (app-api) import from this
 * subpath; core-api-interior callers may continue to use relative
 * imports into `./log.js` and `./events.js`.
 */

export * from './log.js';
export * from './events.js';
