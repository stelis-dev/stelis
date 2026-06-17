# Security Model

This document summarizes the current security boundaries that are visible in the code.

## Main Boundaries

| Boundary | Current rule |
| --- | --- |
| User assets | User vault assets are owned on-chain by the user. |
| Sponsor gas | User commands must not reference `GasCoin`. |
| Prepare authorization | Generic prepare requires a sender personal-message signature over the transaction-kind hash and request fields. |
| Settlement swap path | Relay validation accepts only configured settlement swap paths. |
| Prepare records | Prepare records are single-use and time-limited. |
| Promotion calls | Promotion-sponsored Move calls must match `STUDIO_ALLOWED_TARGETS`. |
| Admin routes | `/api/*` routes require an admin session. |

## Web3 Security Policy

Move contracts enforce vault ownership, settlement input checks, relayer claim caps, pause behavior, and admin-only config changes.

Relay validation adds off-chain checks before the sponsor signs:

- transaction shape checks
- settlement argument checks
- settlement swap path authorization
- non-loss math
- policy-hash binding
- gas-owner and sponsor checks

## Web2 Security Policy (API and Infrastructure)

The API host adds request and operations controls:

- Redis-backed prepare store
- rate limiting
- abuse blocking
- sponsor slot leasing
- sponsor operation health gate
- admin session validation

Generic `/relay/prepare` requires signed prepare authorization before the prepare state machine performs sponsor slot checkout, nonce reservation, on-chain reads, or transaction building. The host recomputes `txKindBytesHash`, verifies the sender personal-message signature, enforces the prepare authorization timestamp window, and rejects reused prepare authorization nonces.

Production deployments still place the API behind upstream traffic controls such as a WAF, CDN, or gateway rate limiter. The signed prepare boundary proves sender control, but it is not a perimeter replacement for traffic shaping.

## Studio Promotion Security

Studio promotion routes use developer JWTs. The host verifies JWTs against `STUDIO_DEVELOPER_JWT_TRUST_JSON`.

Promotion prepare and sponsor routes also check:

- promotion status and user entitlement
- sender address from the verified identity
- allowed Move call targets
- promotion budget and gas allowance
- prepared transaction binding

## Code References

- Relay routes: [`packages/app-api/src/routes/relay.ts`](../packages/app-api/src/routes/relay.ts)
- Promotion routes: [`packages/app-api/src/routes/studio.ts`](../packages/app-api/src/routes/studio.ts)
- Studio auth middleware: [`packages/app-api/src/middleware/studioAuth.ts`](../packages/app-api/src/middleware/studioAuth.ts)
- Relay validation: [`packages/core-relay/src/validate`](../packages/core-relay/src/validate)
