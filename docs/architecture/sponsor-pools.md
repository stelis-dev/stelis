# Sponsor Pools

The API host uses sponsor keys to pay gas for sponsored transactions.

## Current Model

`SPONSOR_SECRET_KEY` can contain one or more sponsor keys. The host uses a Redis-backed sponsor pool to lease a sponsor slot during prepare and sign during sponsor.

`SPONSOR_REFILL_ACCOUNT_SECRET_KEY` is separate from sponsor keys. It is used for operational refill flows when refill is enabled.

## Health Gate

Before prepare and sponsor routes continue, `@stelis/app-api` checks sponsor operation state. If no usable sponsor slot is available, the route can return a sponsor-operations `503` response.

Prepare routes require at least one healthy sponsor slot that is not currently leased. Sponsor routes use the health gate only, because they complete an existing leased prepare receipt. Admin `/api/pool` reports lease occupancy as `sponsorOperations.slotLeases`, including current leased and free sponsor slot counts.

## Refill Settings

The host supports these refill-related settings:

- `SPONSOR_BALANCE_WARN_MIST`
- `SPONSOR_OPERATIONS_REFILL_ENABLED`
- `SPONSOR_BALANCE_REFILL_TARGET_MIST`

The four `SPONSOR_OPERATIONS_*_MS` timeout values are required at boot.

## Code References

- Sponsor operations: [`packages/app-api/src/sponsor-operations`](../../packages/app-api/src/sponsor-operations)
- Redis sponsor pool: [`packages/core-api/src/store/redisSponsorPool.ts`](../../packages/core-api/src/store/redisSponsorPool.ts)
