# Stelis

Stelis helps wallets, apps, and agents use value they already hold to execute programmable transactions on Sui.

Gas abstraction has been a persistent UX challenge for blockchain applications. A wallet can hold useful assets, but still be blocked from using an app until it also holds the chain's native gas token.

Sui has made meaningful progress with gasless stablecoin transfers, where qualified transfers can move value without requiring the sender to hold SUI for gas. Stelis focuses on what comes after transfers: programmable transactions for apps, services, and agents.

Stelis uses Sui's transaction and ownership primitives to separate execution from settlement. A relay pays SUI gas upfront for a user-approved transaction, validates the transaction, submits it to Sui, and verifies settlement from supported payment tokens or user vault credit.

Studio promotion flows can also sponsor eligible actions from a promotion budget.

The product surfaces are a TypeScript SDK, an MCP server for agent clients, a deployable relay API host, public and admin web apps, and the on-chain Move package.

The repository is a monorepo for development, but the public products are defined by the packages that users install, deploy, or run.

## Product Entry Points

| Need | Start here | What it is |
| --- | --- | --- |
| Build a dApp or service integration | [`@stelis/sdk`](./packages/sdk/README.md) | Published TypeScript SDK for app and service developers |
| Connect an agent runtime | [`@stelis/mcp-server`](./packages/mcp-server/README.md) | Published Model Context Protocol (MCP) server for agent clients |
| Run the relay and admin API | [`@stelis/app-api`](./packages/app-api/README.md) | Deployable API host for relay, auth, admin, and promotion routes |
| Run the demo web app | [`@stelis/app-web`](./packages/app-web/README.md) | Deployable static demo app for docs, status, playground, and sandbox flows |
| Run the admin web app | [`@stelis/app-admin`](./packages/app-admin/README.md) | Deployable static admin app for host operators |
| Review or build the Move package | [`packages/contracts/move`](./packages/contracts/move/README.md) | On-chain Move package |

## Documentation

Start with the [documentation map](./docs/index.md).

For the package layout, product package policy, and dependency rules, see [repository structure](./docs/repository-structure.md).

## Package Policy

Workspace packages are allowed when they make development safer and clearer. They are not automatically public products.

Published or deployed product packages are limited to one package per product entry point:

- `@stelis/sdk`
- `@stelis/mcp-server`
- `@stelis/app-api`
- `@stelis/app-web`
- `@stelis/app-admin`
- `packages/contracts/move`

Internal packages stay private and hold shared implementation rules:

- `@stelis/contracts`
- `@stelis/core-relay`
- `@stelis/core-api`

The SDK and MCP server are separate products. They must not import or wrap each other.
