# Contributing to GuildPass Core

Thank you for your interest in contributing to GuildPass Core! This is the backend and smart-contract foundation for the GuildPass protocol.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Ways to Contribute](#ways-to-contribute)
- [Finding Issues](#finding-issues)
- [Development Setup](#development-setup)
- [Branching & Commits](#branching--commits)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Smart Contract Contributions](#smart-contract-contributions)
- [Review Process](#review-process)
- [Communication](#communication)

---

## Code of Conduct

By participating you agree to our [Code of Conduct](./CODE_OF_CONDUCT.md).

---

## Ways to Contribute

- Fix bugs in the Fastify API or Prisma data layer
- Add or improve unit/integration tests
- Extend or improve the policy engine
- Write or improve Solidity contracts and their Foundry tests
- Improve OpenAPI documentation
- Add new API endpoints with tests
- Improve TypeScript types in shared packages

---

## Finding Issues

1. Browse issues directly on GitHub:
   - [`good first issue`](https://github.com/Adamantine-Guild/guildpass-core/issues?q=label%3A%22good+first+issue%22)
   - [`help wanted`](https://github.com/Adamantine-Guild/guildpass-core/issues?q=label%3A%22help+wanted%22)
2. Comment `I'd like to work on this` on the GitHub issue you'd like to work on.
3. Wait for a maintainer to assign it before starting — this avoids duplicate effort.

---

## Development Setup

### Prerequisites

- Node.js 18+
- npm 9+
- Docker (for PostgreSQL and Redis)
- [Foundry](https://book.getfoundry.sh/getting-started/installation) (for Solidity work)

### Steps

```bash
# 1. Fork and clone
git clone https://github.com/<your-username>/guildpass-core.git
cd guildpass-core

# 2. Start required services
docker compose up -d

# 3. Install all workspace dependencies
npm install

# 4. Set up environment variables
cp .env.example .env
# Edit .env with your database and Redis URLs

# 5. Run Prisma migrations
npm run -w access-api prisma:migrate

# 6. Seed with sample data
npm run seed

# 7. Start the API
npm run dev
# API: http://localhost:3000
# OpenAPI docs: http://localhost:3000/docs
```

### Workspace structure

| Path | Purpose |
| ---- | ------- |
| `apps/access-api` | Fastify REST API (main server) |
| `packages/contracts` | On-chain contract ABIs and addresses |
| `packages/shared-types` | Shared TypeScript types |
| `packages/policy-engine` | Access policy logic |
| `packages/sdk-lite` | Minimal HTTP client |
| `contracts/` | Solidity (Foundry) |

---

## Branching & Commits

- Branch off `main`: `git checkout -b feat/short-description` or `fix/short-description`
- Use conventional commits:
  - `feat: add /v1/communities/:id/roles endpoint`
  - `fix: correct policy engine CONTRIBUTORS_OR_ADMINS resolution`
  - `test: add policy-engine unit tests for edge cases`
  - `chore: update Prisma to 5.x`
  - `contracts: add MembershipNFT renewal event`
- Keep commits focused and atomic.

---

## Submitting a Pull Request

1. Push your branch to your fork.
2. Open a PR against `Adamantine-Guild/guildpass-core` on the `main` branch.
3. Fill in the [PR template](.github/PULL_REQUEST_TEMPLATE.md) completely.
4. Ensure these pass before submitting:

```bash
npm run typecheck    # Must pass
npm run lint         # Fix reported issues
npm run test         # All tests must pass
```

### PR Quality Expectations

- All new API endpoints must have at least one integration test.
- Business logic must live in services, not route handlers.
- Prisma schema changes must include a migration file.
- TypeScript `any` is not acceptable without a clear comment explaining why.

---

## Database Migrations: Direct vs. Expand/Contract

`apps/access-api` serves a live, populated PostgreSQL database. Some schema
changes are safe to ship as a single `prisma migrate deploy`; others will
lock a large table, break rows currently being read by running application
instances, or lose data if applied naively. Before writing a migration,
decide which category it falls into.

### Decision framework

Ask these questions, in order, about the change:

1. **Does it only add something new (a nullable column, a new table, a new
   index built `CONCURRENTLY`)?**
   If yes → **direct migration**. Nothing existing reads or depends on the
   new column/table yet, so there is no window where old and new code
   disagree about the schema.

2. **Does it remove or rename something an already-deployed version of the
   API still reads or writes (a column, a table, an enum value)?**
   If yes → **expand/contract**. During a rolling deploy, old and new
   application instances run side-by-side against the same database for
   several minutes. If the old instance's queries reference a column the
   new migration already dropped or renamed, every request it serves
   during that window fails.

3. **Does it make an existing nullable column `NOT NULL`, tighten a
   `CHECK`/foreign-key constraint, or otherwise reject data that current
   rows might contain?**
   If yes → **expand/contract**. The constraint must not go live until
   every existing row already satisfies it, which requires a backfill step
   before the constraint is added.

4. **Is the table large enough that rewriting it (adding a column with a
   non-null `DEFAULT`, changing a column's type, building a non-concurrent
   index) would hold a lock for longer than you're willing to block
   traffic on that table?**
   If yes → **expand/contract**, even if the change is conceptually
   "additive" — split the DDL from the data rewrite so the rewrite can run
   in batches instead of one transaction.

If none of the above apply, a direct migration is the right, simpler
choice — don't reach for the five-step pattern by default.

### The expand/contract pattern

For changes that fail the checks above, split the change into independently
deployable steps, each safe on its own:

1. **Expand** — add the new nullable column (or new table) in a direct
   migration. Old code ignores it; nothing breaks.
2. **Dual-write** — deploy an application change that writes the new column
   alongside the old one on every mutation, so new rows are correct from
   this point forward. Old rows are still unpopulated.
3. **Backfill** — populate the new column for existing rows using the
   batched-backfill utility (`apps/access-api/src/services/backfillService.ts`),
   not a single `UPDATE` statement. See below.
4. **Contract (constrain)** — once the backfill has finished and dual-write
   has been running long enough that you're confident no row is missed,
   ship a migration that adds the `NOT NULL` constraint (or whatever the
   end state requires).
5. **Contract (remove)** — once nothing reads the old column/table anymore,
   ship a final migration dropping it.

Each step is its own PR and its own deploy. Do not combine steps 1 and 4 in
the same migration — that reintroduces the exact lock/downtime risk the
pattern exists to avoid.

### Worked example 1 — simple case: additive nullable column

`OutboxEvent.correlationId` (migration
`prisma/migrations/20260717_add_outbox_correlation_id`) groups outbox events
emitted by the same originating request. It is a plain nullable `TEXT`
column: existing rows are valid with `correlationId = NULL`, and no
application code depended on it being present. This needed only **step 1**
— a single direct migration, no dual-write, no constraint tightening.

An optional backfill (`apps/access-api/scripts/backfillOutboxCorrelationId.ts`)
assigns historical rows a value after the fact, purely so older events
aren't permanently `NULL`. It's a good showcase of the batched-backfill
utility even though the migration itself didn't require it — run it with:

```bash
pnpm --filter access-api run backfill:outbox-correlation-id
```

### Worked example 2 — hypothetical full pattern: a non-nullable column

Suppose a future issue requires every `AccessOverride` to record which
admin wallet created it (`createdByWallet`), and the field must be
`NOT NULL` because the audit trail is meaningless without it. `AccessOverride`
is small today, but imagine it has grown to millions of rows by the time
this ships. A direct `ADD COLUMN "createdByWallet" TEXT NOT NULL` would
either fail outright (no default, and existing rows have no value to give
it) or, with a default, rewrite the entire table under a lock. The
expand/contract sequence:

1. **Expand**: `ALTER TABLE "AccessOverride" ADD COLUMN "createdByWallet" TEXT;`
   (nullable, direct migration, ships immediately).
2. **Dual-write**: deploy `memberService.createAccessOverride` writing
   `createdByWallet: requesterWallet` on every new override. Existing rows
   are still `NULL`.
3. **Backfill**: run a script built on `runBatchedBackfill` that pages
   through existing `AccessOverride` rows where `createdByWallet IS NULL`
   and sets a value (e.g. a sentinel `"unknown-legacy-admin"` if the true
   creator isn't recoverable), batching updates with a delay between
   batches so the table stays available to live traffic throughout.
4. **Contract (constrain)**: once the backfill reports `completed: true`
   and dual-write has been live for a full deploy cycle, ship
   `ALTER TABLE "AccessOverride" ALTER COLUMN "createdByWallet" SET NOT NULL;`.
5. There is no step 5 here since nothing is being removed — the pattern
   ends at step 4 for a "make nullable column required" change. Step 5
   applies to renames/removals (e.g. dropping the old column once a rename
   is fully rolled out).

This example is illustrative only — no `createdByWallet` migration exists
in this repo today.

### Using the batched-backfill utility

`runBatchedBackfill` (`apps/access-api/src/services/backfillService.ts`)
walks a table in cursor-paginated batches instead of one large `UPDATE`, so
each write is short-lived and the database stays responsive to live traffic
between batches:

```typescript
import { runBatchedBackfill } from '../src/services/backfillService';

await runBatchedBackfill<{ id: string }>({
  batchSize: 500,   // rows per batch
  delayMs: 200,     // pause between batches
  fetchBatch: (cursor, limit) =>
    prisma.someTable.findMany({
      where: { targetColumn: null, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: limit,
    }),
  getCursor: (row) => row.id,
  applyBatch: async (rows) => {
    const results = await prisma.$transaction(
      rows.map((row) =>
        prisma.someTable.updateMany({
          where: { id: row.id, targetColumn: null },
          data: { targetColumn: computeValue(row) },
        }),
      ),
    );
    return results.reduce((sum, r) => sum + r.count, 0);
  },
});
```

See `apps/access-api/scripts/backfillOutboxCorrelationId.ts` for a complete,
runnable example, and `apps/access-api/src/services/backfillService.test.ts`
for its test coverage (pagination, resumability via `maxBatches`, and
progress reporting).

Validate any migration that changes the schema — direct or
expand/contract — with the shadow-DB workflow described in the
[Prisma migration checks](./README.md#prisma-migration-checks) section of
the README before opening a PR.

---

## Smart Contract Contributions

When modifying Solidity contracts:

```bash
# Build
npm run contracts:build

# Test — all forge tests must pass
npm run contracts:test

# Format Solidity
forge fmt
```

- All new contract functions must have NatSpec documentation.
- All state-changing functions must emit events.
- New contracts must have corresponding Foundry unit tests.
- Do not deploy to any real network without explicit maintainer approval.

---

## Review Process

- A maintainer will review your PR within **5 business days**.
- Address requested changes promptly.
- Once approved and CI passes, a maintainer merges.
- Smart contract changes require additional review and will take longer.

---

## Communication

- GitHub Issues: preferred for all task discussion
- Contact: cerealboxx123@gmail.com
