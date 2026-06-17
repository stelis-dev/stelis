/**
 * SDK credit query — re-exports from @stelis/core-relay (shared trust root).
 *
 * Shared implementation: @stelis/core-relay/src/creditQuery.ts.
 * This file exposes queryUserCredit through the SDK public API.
 */
export { queryUserCredit, CreditQueryInconsistentStateError } from '@stelis/core-relay/browser';
export type { CreditResult } from '@stelis/core-relay/browser';
