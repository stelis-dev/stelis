// @stelis/core-relay — public API
//
// Browser-safe exports are maintained in browser.ts.
// This barrel re-exports all browser-safe symbols and adds server-only extras.
//
// To add a new export:
//   - browser-safe:   add to browser.ts only; it appears here automatically.
//   - server-only:    add explicitly below (with a comment explaining why).

export * from './browser.js';

// ── Server-side only (not in browser barrel) ─────────────────────────────────

// Shared cross-package economic caps live in @stelis/contracts. Import
// GAS_MARGIN_CAP_BPS from that package directly when needed.

// Main-barrel-only defaults/errors consumed by core-api server code.
export { DEFAULT_SLIPPAGE_BPS } from './deepbook.js';
export { SlippageQueryError } from './deepbookErrors.js';

// Vault object-field extractors are needed by core-api host context, but have
// no verified browser/SDK consumer.
export { extractVaultTableId, extractMoveObjectFields } from './creditQuery.js';

// R-9 prefix coin classification: used in core-api prepare path, not in browser.
export {
  classifyUserTxCoins,
  extractPrefixWithdrawals,
  containsSponsorWithdrawal,
} from './classifyPrefixCoins.js';

// Move abort code constants for the prepare dry-run classifier and the
// generic sponsor subcode mapping.
// CONFIG_ABORT and the `*AbortName` type definitions stay internal to this
// package; tests reach them via relative import.
export { SETTLE_ABORT, VAULT_ABORT, DEEPBOOK_ABORT } from './moveAbortCode.js';

// Transport error-code unions: type-only re-export so the server-side failure
// policy (`packages/core-api/src/failures.ts`) can narrow `FailureCode` against
// the schema-locked response contracts. Runtime tuples (`KNOWN_*_ERROR_CODES`)
// remain internal to this package; tests reach them via relative import.
export type {
  KnownPrepareErrorCode,
  KnownSponsorErrorCode,
  KnownPromotionPrepareErrorCode,
  KnownPromotionSponsorErrorCode,
} from './errorCode.js';
