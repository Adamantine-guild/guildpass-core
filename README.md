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

## OpenAPI Specification

A stable, machine-readable OpenAPI specification is generated for all public API routes to support SDKs and integrations.

- **Specification File:** [docs/openapi.json](./docs/openapi.json)

**For Contributors:**
When adding or modifying routes in the Access API, you must update the checked-in specification. Run the following command from the root of the repository:

```bash
npm run -w access-api openapi:generate
```

CI will automatically verify that the OpenAPI specification is up-to-date with your code changes.

---

## Data Model

Prisma schema includes: `communities`, `wallets`, `members`, `memberships`, `roles`, `access policies`, `profiles`, `badges` (placeholder), `audit_events`, and `outbox_events`.

For an entity-relationship diagram and a per-table explanation of how these models connect (e.g. how `memberships` ties to `wallets` and `communities`, or how `access policies` reference roles), see [`docs/data-model.md`](docs/data-model.md).

---

## Integration Event Outbox

The API uses the **transactional outbox pattern** to emit reliable integration events when domain state changes. Every mutation that affects memberships, roles, policies, resources, or access decisions writes a durable event to the `OutboxEvent` table within the same database transaction as the state change. This guarantees that no event is lost on request failure or process restart.

### Outbox Processing Contract

| Concept | Description |
| ------- | ----------- |
| **Event creation** | Events are written atomically with the domain mutation inside a Prisma `$transaction`. If the mutation fails, no event is created. If the event write fails, the entire transaction rolls back. |
| **Event types** | `MEMBERSHIP_CREATED`, `MEMBERSHIP_UPDATED`, `MEMBERSHIP_DELETED`, `ROLE_ASSIGNED`, `ROLE_REMOVED`, `RESOURCE_CREATED`, `RESOURCE_UPDATED`, `RESOURCE_ARCHIVED`, `POLICY_CREATED`\*, `POLICY_UPDATED`\*, `POLICY_DELETED`\*, `ACCESS_DECISION`, `ACCESS_OVERRIDE_CREATED`, `ACCESS_OVERRIDE_UPDATED`, `ACCESS_OVERRIDE_REVOKED`, `MEMBER_ATTENDED`, `BADGE_ASSIGNED`, `BADGE_REVOKED` |
| **Statuses** | `pending` (awaiting delivery), `delivered` (successfully processed), `failed` (permanently failed after max retries) |
| **Retry strategy** | Exponential backoff: `nextRetryAt = now + 10 × 2^retryCount` seconds. Default max 5 retries. |
| **Delivery worker** | `outboxWorker` polls for pending events every `OUTBOX_WORKER_INTERVAL_MS` (default 10s) and delegates to a pluggable handler. The default handler is a no-op logger. |
| **Pruning** | Delivered events older than 7 days are automatically pruned to prevent unbounded table growth. |

\* `POLICY_CREATED`/`POLICY_UPDATED`/`POLICY_DELETED` are reserved for future CRUD on the base `AccessPolicy` (per-resource `ruleType`) record, which today is only read, not managed via an API. Wallet-specific **access overrides** (see Policy Engine, above) are a separate concept with their own `ACCESS_OVERRIDE_*` event types.

### Configuration

| Environment Variable | Default | Description |
| -------------------- | ------- | ----------- |
| `OUTBOX_WORKER_INTERVAL_MS` | `10000` | Polling interval per shard (ms) |
| `OUTBOX_WORKER_BATCH_SIZE` | `50` | Max events per shard per poll |
| `OUTBOX_WORKER_COUNT` | `1` | Number of concurrent shards for horizontal scaling |
| `OUTBOX_WORKER_MIN_BATCH_SIZE` | `5` | Min batch size under backpressure |

### Pluggable Handler

The outbox worker accepts a custom `OutboxEventHandler` function. Replace the default no-op with your own delivery logic (HTTP webhook, NATS, Kafka, analytics pipeline, etc.):

```typescript
import { createOutboxWorker, OutboxEventHandler } from './workers/outboxWorker';

const myHandler: OutboxEventHandler = async (event) => {
  await fetch('https://hooks.example.com/integration', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
};

const worker = createOutboxWorker({ intervalMs: 10_000, handler: myHandler });
worker.start();
```

### Production Webhook Handler

`createWebhookHandler` (`apps/access-api/src/handlers/webhookHandler.ts`) is a
ready-to-use `OutboxEventHandler` that delivers events as signed HTTP
webhooks to every active `WebhookSubscription` registered for a community,
filtered by event type:

```typescript
import { createOutboxWorker } from './workers/outboxWorker';
import { createWebhookHandler } from './handlers/webhookHandler';

const worker = createOutboxWorker({ intervalMs: 10_000, handler: createWebhookHandler() });
worker.start();
```

A `WebhookSubscription` row (`communityId`, `url`, `secret`, `eventTypes[]`)
registers where a community's events should be delivered. An empty
`eventTypes` array means "all event types".

#### Webhook Signature Verification

Every delivered request is HMAC-SHA256 signed with the subscription's
per-community secret, and includes anti-replay fields:

| Header | Description |
| ------ | ----------- |
| `X-GuildPass-Signature` | `hex(HMAC_SHA256(secret, "${timestamp}.${nonce}.${body}"))` |
| `X-GuildPass-Timestamp` | Unix epoch milliseconds when the request was signed |
| `X-GuildPass-Nonce` | Random UUID, unique per delivery attempt |

To verify a webhook on the receiving side:

1. Recompute the HMAC from your stored secret, the received timestamp,
   nonce, and raw request body, and compare it to `X-GuildPass-Signature`
   using a constant-time comparison (never `===` on secrets/signatures).
2. Reject the request if `X-GuildPass-Timestamp` is older than your
   tolerance window (5 minutes recommended) — this bounds how long a
   captured request could be replayed.
3. Reject the request if you've already processed `X-GuildPass-Nonce`
   (e.g. check-and-set it in Redis with a TTL matching your tolerance
   window) — the timestamp check alone does not prevent replay *within*
   the tolerance window.

`verifyWebhookSignature` in `webhookHandler.ts` is a reference
implementation of steps 1–2 (nonce tracking is necessarily your
application's responsibility, since it requires storage this library
doesn't own).

If **any** subscription delivery for an event fails (non-2xx response,
timeout, network error), the whole event is re-queued through the outbox's
existing exponential-backoff retry — the handler does not partially retry
just the failed subscriptions. Webhook consumers should therefore be
idempotent per `(event.id, X-GuildPass-Nonce)`.

#### Dead-Letter Store

An event that exhausts the outbox's `maxRetries` (default 5) is no longer
just marked `failed` and pruned after 7 days — it's captured in
`DeadLetterEvent` with its failure reason and retry count, inspectable and
manually retriable via:

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/v1/communities/:communityId/dead-letter-events` | List dead-lettered events for a community, optionally filtered by `?status=` |
| POST | `/v1/communities/:communityId/dead-letter-events/:id/retry` | Re-enqueue a dead-lettered event as a fresh pending `OutboxEvent` |

### Observability

| Metric | Type | Labels |
| ------ | ---- | ------ |
| `outbox_events_created_total` | Counter | `event_type` |
| `outbox_events_delivered_total` | Counter | `event_type` |
| `outbox_events_failed_total` | Counter | `event_type` |

---

## Policy Engine

Simple rules: `PUBLIC`, `MEMBERS_ONLY`, `ADMINS_ONLY`, `CONTRIBUTORS_OR_ADMINS`.

Role resolution combines:
- Membership state (adds `member` role when active)
- Backend role assignments (including custom role hierarchies and delegated grants)
- **Manual access overrides** — an explicit `ALLOW`/`DENY` for a single `(wallet, communityId, resource)` triple, e.g. a temporary ban or a one-off grant for a partner wallet. An active override is checked **before** any rule evaluation and, if present, short-circuits the decision — it takes precedence over every role- or membership-derived outcome. Overrides are managed via the `/v1/communities/:communityId/overrides` admin routes below and expire automatically via their optional `expiresAt`.

**Full spec** (policy semantics, exact role-resolution algorithm, override precedence, worked examples): [`packages/policy-engine/README.md`](./packages/policy-engine/README.md).

### Managing access overrides

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST | `/v1/communities/:communityId/overrides` | Create or update an override for a wallet/resource pair (admin only) |
| GET | `/v1/communities/:communityId/overrides` | List overrides for a community, including expired ones (admin only) |
| DELETE | `/v1/communities/:communityId/overrides/:wallet/:resource` | Revoke an override (admin only) |

Every mutation is written transactionally with an `ACCESS_OVERRIDE_CREATED`, `ACCESS_OVERRIDE_UPDATED`, or `ACCESS_OVERRIDE_REVOKED` outbox event (see below).

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

Not every schema change is safe to ship as a single direct migration —
see [CONTRIBUTING.md > Database Migrations: Direct vs. Expand/Contract](./CONTRIBUTING.md#database-migrations-direct-vs-expandcontract)
for the decision framework, a worked example, and the reusable
batched-backfill utility (`apps/access-api/src/services/backfillService.ts`)
for populating large tables without holding long-running locks.

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
