# Getting Started

This document gives the current local starting path for running the repository.

It describes only commands and files currently present in this repository.

## Choose Your Starting Path

| Reader | Start here |
| --- | --- |
| App or service developer | [`packages/sdk/README.md`](../packages/sdk/README.md) |
| Agent runtime integrator | [`packages/mcp-server/README.md`](../packages/mcp-server/README.md), then [`api.md → User TransactionKind rules`](./api.md#user-transactionkind-rules) |
| Host operator | [`packages/app-api/README.md`](../packages/app-api/README.md), [`operations.md`](./operations.md), and [`parameters.md`](./parameters.md) |
| Web app operator | [`packages/app-web/README.md`](../packages/app-web/README.md) or [`packages/app-admin/README.md`](../packages/app-admin/README.md) |
| Contract reviewer | [`packages/contracts/move/README.md`](../packages/contracts/move/README.md), then [`invariants.md`](./invariants.md) |

For the full documentation map, use [`index.md`](./index.md).

## Install

```bash
npm install
```

## Build

```bash
VITE_STELIS_RELAYER_URL=http://localhost:3200/relay \
VITE_STELIS_API_URL=http://localhost:3200 \
VITE_SUI_RPC_URL=https://fullnode.testnet.sui.io:443 \
npm run build
```

## Run Tests

```bash
npm test
```

## Run Repository Checks

```bash
npm run lint
npm run typecheck
npm run check:prepare-stage-schema
```

## Run the API Host

Create local config files:

```bash
cp packages/app-api/.env.local.example packages/app-api/.env.local
cp packages/app-api/settlement-swap-paths.json.example packages/app-api/settlement-swap-paths.json
cp packages/app-api/rpc.json.example packages/app-api/rpc.json
```

Fill in real values in `.env.local`, `settlement-swap-paths.json`, and `rpc.json`.

Then run:

```bash
npm run dev --workspace=@stelis/app-api
```

## Run Web Apps

Create local config files:

```bash
cp packages/app-web/.env.local.example packages/app-web/.env.local
cp packages/app-admin/.env.local.example packages/app-admin/.env.local
```

Use values that point at the local API host.

```bash
npm run dev --workspace=@stelis/app-web
npm run dev --workspace=@stelis/app-admin
```

## Next Documents

- [`api.md`](./api.md)
- [`operations.md`](./operations.md)
- [`repository-structure.md`](./repository-structure.md)
