# @stelis/sdk — Current Package State

- `@stelis/sdk` is the published app and service SDK. `@stelis/mcp-server` is a separate published product for agent clients. Internal workspace packages remain `"private": true`.
- The published SDK bundles internal `@stelis/contracts` and `@stelis/core-relay` code through `tsup` (`noExternal` + `dts.resolve`). Consumers install `@mysten/sui` as the peer dependency and do not install internal Stelis workspaces directly.
- Shared TypeScript contract IDs and data live in the private `@stelis/contracts` workspace (`packages/contracts/`).
- The public SDK entry points are the root `@stelis/sdk` entry plus the `@stelis/sdk/server` subpath. Browser-unsafe server-only helpers remain in their original internal packages instead of being widened onto the public SDK.
