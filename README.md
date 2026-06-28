# GuildPass Core Monorepo (MVP)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green?style=flat-square)](https://nodejs.org)

GuildPass provides **wallet-based membership and token-gated community infrastructure** for the Web3 / EVM ecosystem.

This monorepo contains a runnable MVP backend and protocol foundation. It is intentionally not feature-complete, but is real, demoable, and extendable.

> **Part of the [Adamantine-Guild](https://github.com/Adamantine-Guild) project.**

---

## Structure

| Path | Purpose |
| ---- | ------- |
| `apps/access-api` | Fastify REST API (TypeScript, Prisma, PostgreSQL, OpenAPI) |
| `packages/contracts` | TypeScript helpers for on-chain contract addresses and ABIs |
| `packages/shared-types` | Shared types and enums for roles, membership, and decisions |
| `packages/policy-engine` | Simple, explainable access policy engine |
| `packages/sdk-lite` | Minimal HTTP client for the access API |
| `contracts/` | Foundry Solidity project (MembershipNFT + tests + deploy scripts) |

---

## Quick Start

### Prerequisites

- Node.js 18+
- npm 9+
- Docker (for PostgreSQL and Redis)
- [Foundry](https://book.getfoundry.sh/getting-started/installation) (for Solidity contracts)

### Steps

```bash
# 1. Clone and enter the repo
git clone https://github.com/Adamantine-Guild/guildpass-core.git
cd guildpass-core

# 2. Start PostgreSQL and Redis
docker compose up -d

# 3. Install dependencies
npm install

# 4. Set up environment variables
cp .env.example .env
# Edit .env — set DATABASE_URL, REDIS_URL, etc.

# 5. Generate Prisma client and run migrations
npm run -w access-api prisma:migrate

# 6. Seed the database with sample data
npm run seed

# 7. Start the API in development mode
npm run dev
```

OpenAPI docs available at: **http://localhost:3000/docs**

---

## Contracts (Solidity / Foundry)

The `MembershipNFT` is a simple ERC-721 with expiry and suspension semantics, and admin-controlled mint/renew. It supports **multi-community memberships**, meaning a single deployed contract can represent memberships across multiple communities via the `communityId` mapping. Events emitted are suitable for off-chain indexing and include the associated `communityId` to easily map to the backend state.

```bash
# Build contracts
npm run contracts:build   # runs: forge build

# Test contracts
npm run contracts:test    # runs: forge test

# Deploy (example script)
npm run contracts:deploy  # runs: forge script contracts/script/Deploy.s.sol --broadcast
```

After deploying, set `MEMBERSHIP_NFT_ADDRESS` and `CHAIN_ID` in `.env`.

---

## API Versioning & Compatibility

The GuildPass Access API follows a strict versioning and compatibility contract for all `/v1` routes:

- **Version Header**: All API responses include an `x-guildpass-api-version` header (e.g., `1.0.0`) indicating the version being served.
- **Server Version**: The `GET /health/live` endpoint exposes the current server API version.
- **Backwards Compatibility**: We commit to maintaining backwards compatibility for all `/v1` routes. We will not remove fields from responses or require new mandatory request parameters without bumping the major API version (e.g., to `/v2`).
- **Deprecation**: If a `/v1` route or field needs to be deprecated, we will serve a `deprecation: true` header on those responses and provide guidance in our documentation. Deprecated endpoints will continue to function for a minimum sunset period before removal. Clients are encouraged to monitor the `deprecation` header.

---

## API Endpoints (MVP)

| Method | Path | Description |
| ---- | ---- | ----------- |
| GET | `/v1/memberships/:wallet` | Membership status summary by wallet |
| GET | `/v1/members/:wallet` | Member profile (with membership and roles) |
| POST | `/v1/access/check` | Access decision for `{ wallet, communityId, resource }` |
| GET | `/v1/communities/:communityId/members` | Admin member listing |

Responses include `allowed`/`denied` plus human-readable and machine-readable reasons.

---

## Data Model

Prisma schema includes: `communities`, `wallets`, `members`, `memberships`, `roles`, `access policies`, `profiles`, `badges` (placeholder).

---

## Policy Engine

Simple rules: `PUBLIC`, `MEMBERS_ONLY`, `ADMINS_ONLY`, `CONTRIBUTORS_OR_ADMINS`.

Role resolution combines:
- Membership state (adds `member` role when active)
- Backend role assignments
- Room for future manual override rules (TODO)

---

## Testing

```bash
# All tests across workspaces
npm run test

# Policy engine unit tests
npm run -w @guildpass/policy-engine test

# Access API unit and integration tests
npm run -w access-api test

# Contract tests (Foundry)
npm run contracts:test

# TypeScript type checking
npm run typecheck
```

### Prisma migration checks

When you change the Prisma schema or migration history, validate the database workflow locally before opening a pull request:

```bash
pnpm install --frozen-lockfile
createdb guildpass_test
createdb guildpass_shadow
DATABASE_URL=postgresql://localhost:5432/guildpass_test \
SHADOW_DATABASE_URL=postgresql://localhost:5432/guildpass_shadow \
pnpm --filter access-api prisma:validate
pnpm --filter access-api prisma:generate
pnpm --filter access-api prisma:migrate:deploy
pnpm --filter access-api prisma:migrate:check
```

The CI workflow runs the same validation steps against a disposable PostgreSQL service and a shadow database so drift is caught before merge.

### Integration Testing

The **Membership Integration Test** (`apps/access-api/src/membership-integration.test.ts`) validates the complete flow from MembershipNFT contract events to API access decisions:

- **Contract Events** → Database State → Policy Engine → API Response
- Tests event ingestion (MembershipMinted, MembershipRenewed, MembershipSuspended)
- Validates active, expired, and suspended membership scenarios
- Proves access control decisions reflect actual membership state
- Can run locally without a live blockchain

See [apps/access-api/INTEGRATION_TEST_GUIDE.md](./apps/access-api/INTEGRATION_TEST_GUIDE.md) for detailed documentation.

---

## Linting

This project uses ESLint to maintain code quality.

- **Run linting for all packages:** `npm run lint`
- **Run linting for a specific package:** `npm run lint -w <package-name>`

---

## Environment

See [`.env.example`](./.env.example) for all required variables.

---

## Deferred Areas (Intentionally Not Implemented)

- Advanced governance permissions
- Constitutional rule engine
- Complex moderation workflows / appeals / reinstatement
- Rich reward distribution and advanced streak logic
- Contribution scoring engine
- Full event attendance ingestion
- Multi-chain support (current: EVM only)
- Advanced indexing pipeline

Clear interfaces and TODOs are left where appropriate.

---

## Development Notes

- Business logic lives in services and the policy engine, not route handlers.
- Contracts and API are aligned via shared types and simple event ABI.
- The code aims to be small and understandable; extending should not require rewrites.

---

## Contributing

We welcome contributions! See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide.

### How to contribute

1. Browse open issues tagged [`good first issue`](https://github.com/Adamantine-Guild/guildpass-core/issues?q=label%3A%22good+first+issue%22) or [`help wanted`](https://github.com/Adamantine-Guild/guildpass-core/issues?q=label%3A%22help+wanted%22).
2. Comment directly on the GitHub issue you'd like to work on.
3. Fork the repo, create a feature branch, implement your change, open a PR.

### Maintainer contact

- Contact: cerealboxx123@gmail.com

## License

MIT — see [LICENSE](./LICENSE).
