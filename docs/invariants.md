# Invariants

This document lists the rules that Stelis code and contracts are expected to preserve.

The IDs are used in code comments, tests, and package README files. They are short labels for review and audit work; the code remains the current reference.

## Ownership

| ID | Rule | Enforced by |
| --- | --- | --- |
| O-1 | A `UserVault` is an owned Sui object. | Move |
| O-2 | Only the owner can withdraw from a `UserVault`. | Move |
| O-3 | Settlement surplus is credited to the user's vault balance, not transferred to another owner. | Move |
| O-4 | Settlement entry points do not change vault ownership. | Move |
| O-5 | Users can withdraw directly even when relay infrastructure is unavailable. | Move |

## Settlement

| ID | Rule | Enforced by |
| --- | --- | --- |
| S-2 | `relayer_claim` must not exceed `max_claim_mist`. | Move and relay validation |
| S-3 | `total_in` must be at least `min_settle_mist`. | Move |
| S-4 | Settlement input must cover relayer claim, quoted relayer fee, and protocol fee. | Move |
| S-9 | Surplus is joined into vault balance; no extra surplus coin is created. | Move |
| S-10 | `receipt_id` is empty or 32 bytes. | Move |
| S-11 | `policy_hash` is empty or 32 bytes. | Move |
| S-14 | Prepare records are one-time use, and on-chain settlement uses a monotonic vault nonce. | Move and relay store |
| S-15 | Sponsored transactions must not reference `GasCoin` in user commands. | Relay validation |
| S-16 | The transaction policy hash must match the server-computed hash. | Relay validation |

## Vault Registry

| ID | Rule | Enforced by |
| --- | --- | --- |
| V-1 | Each user has one registered vault in `VaultRegistry`. | Move |
| V-2 | New-user settlement registers the user vault. | Move |
| V-3 | With-vault settlement validates the user's registered vault. | Move |

## Economics

| ID | Rule | Enforced by |
| --- | --- | --- |
| E-1 | `relayerClaim >= simGas + gasVarianceFixedMist + slippageBufferMist`. | Relay validation |
| E-2 | Simulated gas must not exceed `max_claim_mist`. | Relay validation |
| E-4 | Relayer claim must not exceed `max_claim_mist`. | Move and relay validation |
| E-7 | `max_claim_mist` must be greater than zero. | Move |
| E-8 | `min_settle_mist` must be within the allowed range and no greater than `max_claim_mist`. | Move |
| E-9 | The sponsor approval gate must preserve the non-loss condition for successful transactions. | Relay validation |

## Pause

| ID | Rule | Enforced by |
| --- | --- | --- |
| P-1 | When paused, settlement entry points are blocked. | Move |
| P-2 | Withdrawals remain available while paused. | Move |
| P-3 | Internal credit use is available only through settlement paths. | Move |

## Admin Safety

| ID | Rule | Enforced by |
| --- | --- | --- |
| A-1 | Admin mutations emit events. | Move |
| A-2 | Only admin can change protocol treasury. | Move |
| A-3 | Only admin can change protocol flat fee. | Move |
| A-4 | Only admin can change relayer fee cap and spread cap. | Move |

## Relay Policy

| ID | Rule | Enforced by |
| --- | --- | --- |
| R-1 | A sponsored settlement transaction must contain exactly one allowed settlement call. | Relay validation |
| R-2 | Sponsored transactions must not contain publish or upgrade commands. | Relay validation |
| R-3 | The relayer recipient address in settlement arguments must match host configuration. | Relay validation |
| R-7 | Settlement swap path identity must be present in the host's allowed settlement swap path list. | Relay validation |
| R-8 | Settlement swap path hop order must match the allowed settlement swap path exactly. | Relay validation |
| R-9 | Payment-token coins must not be consumed twice or overlap unsafely inside one transaction. | Relay validation |
| R-10 | Promotion-sponsored Move calls must match `STUDIO_ALLOWED_TARGETS`. | Promotion validation |

## Code References

- Move modules: [`packages/contracts/move/sources`](../packages/contracts/move/sources)
- Relay validation: [`packages/core-relay/src/validate`](../packages/core-relay/src/validate)
- Prepare and sponsor flow: [`packages/core-api/src/session`](../packages/core-api/src/session)
