# Payment and Promotion Flows

This document defines the product terms used by SDK, web app, and API package docs.

## Product Family Terms

| Term | Meaning |
| --- | --- |
| Hosted relay | A deployed Stelis relay host that clients can use without operating their own host |
| Host | A deployed `@stelis/app-api` runtime |
| Host operator | The party that deploys and operates `@stelis/app-api` and related web apps |
| Studio | Promotion and policy-controlled flows layered on the same host |
| Relayer | The service that prepares, sponsor-signs, and submits sponsored transactions |

## Generic Settlement Flow

The generic flow uses:

- `POST /relay/prepare`
- `POST /relay/sponsor`

It can include `orderId` tracking. Backends that track `receiptId` can verify the resulting on-chain `SettleEvent` with `verifySettleEventAgainstExpected` from `@stelis/sdk/server` by passing application-owned expected fields: `receiptId`, `user`, and `orderId` or `orderIdHash`. Amount-sensitive integrations also pass expected relayer and protocol fee values.

A `SettleEvent` is settlement evidence. Application payment completion is decided by comparing the event with the application's expected fields.

## Promotion-Sponsored Flow

Promotion-sponsored flow uses:

- `GET /studio/promotions`
- `GET /studio/promotions/:id`
- `POST /studio/promotions/:id/claim`
- `POST /studio/promotions/:id/prepare`
- `POST /studio/promotions/:id/sponsor`

These routes require a developer JWT. The promotion budget pays gas directly. Promotion-sponsored flows do not use the generic settlement Programmable Transaction Block (PTB) and do not emit a Stelis `SettleEvent`.

## Responsibility Split

| Party | Owns |
| --- | --- |
| App or service developer | wallet UX, user signing, backend identity, and fulfillment |
| Agent runtime | tool orchestration and user approval policy |
| Host operator | deployed API host, sponsor funding, route config, and operations |
| Stelis packages | SDK, MCP server, API host, web apps, internal validation packages, and Move package |
