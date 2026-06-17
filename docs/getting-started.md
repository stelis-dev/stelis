# Getting Started

This document gives the current local starting path for running the repository.

It describes only commands and files currently present in this repository.

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
