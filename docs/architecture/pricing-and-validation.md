# Pricing and Validation

This document summarizes current relay pricing and validation behavior.

## Non-Loss Pricing Model

The relay computes:

```text
simGas = max(0, computationCost + storageCost - storageRebate)
relayerClaim = simGas + gasVarianceFixedMist + slippageBufferMist
```

Current `gasVarianceFixedMist` is `100000`.
`relayerClaim` is the gas-recovery claim in the settlement arguments. The full relayer payout is `relayerClaim + quotedRelayerFeeMist`, paid to the configured relayer recipient address during Move settlement.

## Sponsor Approval Flow

<a id="sponsor-approval-flow"></a>

Before signing, the sponsor checks:

1. the prepared transaction can still be found and consumed once;
2. the submitted transaction bytes match the prepared record;
3. settlement arguments still match current config and host policy;
4. preflight simulation succeeds;
5. non-loss math passes;
6. the sponsor slot can sign and submit.

## Sponsor Failure Classification

<a id="sponsor-failure-classification"></a>

Sponsor failures are mapped by `packages/app-api/src/errorMap.ts` and failure classification code in `@stelis/core-api`.

Client guidance:

- `LEASE_EXPIRED`: prepare again.
- `REPREPARE_REQUIRED`: prepare again because server-side binding or config changed.
- `ABUSE_BLOCKED`: back off until the server-provided retry time.
- validation errors: fix the transaction or settlement swap path choice before retrying.

## Validation Layers

| Layer | Checks |
| --- | --- |
| User-command validation | command count, forbidden command kinds, `GasCoin` references, direct Stelis calls |
| Settlement validation | config object, vault registry object, relayer recipient address, settlement swap path authorization, fee caps |
| Non-loss validation | relayer claim, gas budget, simulated gas cap |
| Move validation | vault ownership, settlement minimums, pause state, admin-only config |
