# GuildPass PostgreSQL Database Migration Playbook
A guide to making safe, zero-downtime schema changes in the GuildPass access-api Postgres database.

## Overview
GuildPass has several "hot" tables that are write-heavy or large:
- `memberships` (tracking on-chain memberships)
- `outbox_events` (transactional outbox for event delivery)
- `members` (member profiles and roles)
- `audit_events` (audit logs)

This playbook covers how to apply safe, zero-downtime changes to these tables.


## 1. Safe Migration Patterns for PostgreSQL
Below are common schema changes and their zero-downtime sequences:

---

### 1.1 Adding a Nullable Column
**Safe to do without downtime.**
1. Add the column as `NULLABLE` in a Prisma migration
2. Update application code to handle the nullable column
3. (Optional) Deploy the new app version
4. (Optional) If you need to backfill: do it in batches
5. (Optional) If you want to make it non-nullable later: see section 1.2

**Example:**
```sql
-- Migration Step 1: Add nullable column
ALTER TABLE "memberships" ADD COLUMN "metadata" JSONB;
```

---

### 1.2 Adding a Non-Nullable Column
**Must be done in multiple steps to avoid downtime.**
1. Add the column as `NULLABLE` in a Prisma migration
2. Update application code to write to this column (for new rows)
3. Deploy the updated app
4. Backfill existing rows with a batch process (to avoid locking)
5. Deploy another app version that reads from the column
6. Once backfilled and all code uses it: make it `NOT NULL` (see section 1.3)

**Example (from GuildPass history: backfillOutboxCorrelationId.ts):**
```typescript
// apps/access-api/scripts/backfillOutboxCorrelationId.ts
// Batch backfill to avoid locking
async function backfillCorrelationIds() {
  let cursor: string | undefined;
  const batchSize = 1000;
  while (true) {
    const events = await prisma.outboxEvent.findMany({
      take: batchSize,
      where: { correlationId: null },
      orderBy: { id: 'asc' },
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
    });

    if (events.length === 0) break;

    await Promise.all(events.map(event => {
      prisma.outboxEvent.update({
        where: { id: event.id },
        data: { correlationId: generateCorrelationId(event) },
      });
    }));

    cursor = events[events.length - 1].id;
  }
}
```

---

### 1.3 Making a Nullable Column Non-Nullable
Once all rows have a value:
1. Verify there are no nulls remaining
2. In a Prisma migration: add the `NOT NULL` constraint

**Example:**
```sql
ALTER TABLE "outbox_events" ALTER COLUMN "correlation_id" SET NOT NULL;
```

---

### 1.4 Adding an Index
Use `CREATE INDEX CONCURRENTLY` on large/hot tables!
- Standard `CREATE INDEX` takes an exclusive lock, blocking reads/writes
- `CONCURRENTLY` takes longer but doesn't block

**Critical Note:** Prisma does not generate `CONCURRENTLY` by default! You must edit the migration SQL manually!

**Example:**
```sql
-- UN-SAFE (default Prisma output)
CREATE INDEX "outbox_events_community_id_idx" ON "outbox_events" ("community_id");

-- SAFE (use this)
CREATE INDEX CONCURRENTLY "outbox_events_community_id_idx" ON "outbox_events" ("community_id");
```

---

### 1.5 Adding a Foreign Key
**Also needs to be done carefully!**
Add the foreign key with `NOT VALID` first, then validate later:
```sql
-- Step 1: Add foreign key constraint (NOT VALID)
-- This doesn't block reads/writes, doesn't scan existing rows yet
ALTER TABLE "memberships"
ADD CONSTRAINT "memberships_member_id_fkey"
FOREIGN KEY ("member_id") REFERENCES "members" ("id")
NOT VALID;

-- Step 2: Validate the constraint (can be done later, during low traffic)
ALTER TABLE "memberships" VALIDATE CONSTRAINT "memberships_member_id_fkey";
```

---

### 1.6 Renaming a Column
**Complex; requires multiple deployments.**
1. Add a new column with the new name (nullable)
2. Update app code to write to both old and new columns
3. Deploy
4. Backfill old data to new column
5. Update app code to read from new column
6. Deploy
7. Stop writing to old column
8. Deploy
9. Drop old column (in a migration)

---

## 2. Prisma Migration Workflow
The standard GuildPass workflow is in `apps/access-api/README.md`:
- `prisma:validate`: Validate the schema against the database
- `prisma:migrate:dev`: Create a new migration
- `prisma:migrate:deploy`: Apply migrations in production
- `prisma:migrate:check`: Check if migrations are in sync
- `prisma:migrate:safety`: Check for unsafe migration patterns (new!)

**For Hot Tables:**
1. After generating a migration with `prisma migrate dev`, edit the SQL file!
   - Replace `CREATE INDEX` with `CREATE INDEX CONCURRENTLY` for large tables
   - Split `NOT NULL` additions into multiple steps
   - For foreign keys: consider `NOT VALID` + `VALIDATE`

---

## 3. Worked Example: Adding `correlationId` on `outbox_events`
We'll use the existing migration `20260717_add_outbox_correlation_id` as a safe change! The steps were:

---

**Step 1: Add column as NULLABLE**
```sql
-- apps/access-api/prisma/migrations/20260717_add_outbox_correlation_id/migration.sql
ALTER TABLE "OutboxEvent" ADD COLUMN "correlationId" VARCHAR(255);
CREATE INDEX "OutboxEvent_correlationId_idx" ON "OutboxEvent"("correlationId");
```

---

**Step 2: Update code to write to correlationId**
Modified `outboxService.ts` to generate and write `correlationId` for new events!

---

**Step 3: Backfill existing events (safe batch process**
Created `apps/access-api/scripts/backfillOutboxCorrelationId.ts`!
It uses a `cursor-based batch processing to avoid locking the table!
It processes 1000 rows at a time!


---

## 4. Migration Safety Checklist
Before merging a migration, ask:
- [ ] Is this change on a hot/large table?
- [ ] If adding an index: did you use `CONCURRENTLY`?
- [ ] If adding a `NOT NULL` column: did you split into multiple steps?
- [ ] If adding a foreign key: did you use `NOT VALID` + `VALIDATE`?
- [ ] Did you test the migration in a staging environment first?

---

## 5. Tooling & Checks
We've added a small shell script to check migrations for unsafe index usage!
Check the script at `apps/access-api/scripts/check-migrations.sh` (see below)!
