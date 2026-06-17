// Core-relay-interior constants.
// Shared cross-package runtime data tables, identifiers, and discriminator
// literals live in @stelis/contracts. This module keeps only core-relay-local
// constants used by validation and gas math.

// ─────────────────────────────────────────────
// Off-chain only constants (core-relay-interior)
// ─────────────────────────────────────────────

/** Layer 1: PTB command count upper bound */
export const MAX_COMMANDS = 16;

/** Sui Clock shared object ID (protocol-level constant) */
export const SUI_CLOCK_OBJECT_ID = '0x6';

// requireContractId lives in @stelis/contracts as the shared
// contract-id lookup validator.
