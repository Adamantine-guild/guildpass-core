# Membership Integration Testing

This document describes the end-to-end integration tests that validate the membership flow from contract events to API access decisions.

## Overview

The integration test suite validates the complete flow:

```
MembershipNFT Contract Events
    ↓
Event Fixtures (decoded)
    ↓
Database State (via Event Helpers)
    ↓
Policy Engine (evaluates access)
    ↓
API Response (access allowed/denied)
```

## Architecture

### Test Components

1. **Event Fixtures** (`membership-integration.test.ts`)
   - Decoded contract events representing real-world scenarios
   - Derived directly from `MembershipNFT.sol` event definitions
   - Cover: active, expired, suspended, and renewed memberships

2. **Event Helpers** (`services/contractEventHelpers.ts`)
   - Reusable functions for processing contract events
   - Designed for both test fixtures and future event indexer
   - Provides idempotent database updates

3. **Integration Tests** (`membership-integration.test.ts`)
   - Fastify app injection for realistic API testing
   - Database transactions for test isolation
   - Multiple test scenarios covering acceptance criteria

## Running the Tests

### Prerequisites

```bash
# Install dependencies
pnpm install

# Ensure PostgreSQL is running and DATABASE_URL is configured
export DATABASE_URL="postgresql://user:password@localhost:5432/guildpass"
```

### Run All Tests

```bash
cd apps/access-api
pnpm test
```

### Run Only Integration Tests

```bash
cd apps/access-api
pnpm test -- membership-integration.test.ts
pnpm test -- multichain-membership-integration.test.ts
pnpm test -- contractEventHelpers.test.ts
```

### Multi-Chain Testing Architecture

The **Multi-Chain Membership Integration Test** (`apps/access-api/src/multichain-membership-integration.test.ts`) validates multi-chain event ingestion and policy resolution across simulated EVM chains (e.g. Chain 1 Ethereum & Chain 137 Polygon):

- **Event Scoping & Collision Prevention**: Confirms events with matching `tokenId` on different chains are ingested independently without ID collisions.
- **Cross-Chain Resolution Policy**:
  - **Conflict Scenario (Active on Chain A, Suspended on Chain B)**: Proves that `suspended` status on any chain overrides active status (Suspension-First / Fail-Secure).
  - **Multi-Chain Active Resolution (Expired on Chain A, Active on Chain B)**: Proves that holding an active token on at least one configured chain grants `active` membership status.

### Run with Coverage

```bash
cd apps/access-api
pnpm test -- --coverage
```

## Test Scenarios

### Scenario 1: Active Membership Grants Access

**Setup:**
- Apply `MembershipMinted` event with valid future expiry

**Validation:**
- ✅ Membership created in database with `state: 'active'`
- ✅ API `GET /v1/memberships/:wallet` returns `state: 'active'`
- ✅ API `POST /v1/access/check` with `MEMBERS_ONLY` policy returns `allowed: true`

**Acceptance Criterion:**
> Event ingestion creates expected wallet and membership records

### Scenario 2: Expired Membership Denies Access

**Setup:**
- Apply `MembershipMinted` event with past expiry timestamp

**Validation:**
- ✅ Database stores `state: 'active'` but `expiresAt` in past
- ✅ `getNormalizedMembershipState()` returns `'expired'` (computed at read-time)
- ✅ API access check returns `allowed: false` and `membershipState: 'expired'`
- ✅ Policy engine reason includes expiry logic

**Acceptance Criterion:**
> Expired memberships produce deny decisions

### Scenario 3: Suspended Membership Denies Access

**Setup:**
- Apply `MembershipMinted` event (valid expiry)
- Apply `MembershipSuspended` event with `isSuspended: true`

**Validation:**
- ✅ Membership state changes to `'suspended'`
- ✅ API returns `state: 'suspended'` even with valid expiry
- ✅ API access check returns `allowed: false`

**Acceptance Criterion:**
> Suspended memberships produce deny decisions

### Scenario 4: Membership Renewal Extends Expiry

**Setup:**
- Apply `MembershipMinted` event
- Record initial `expiresAt`
- Apply `MembershipRenewed` event with future timestamp
- Record updated `expiresAt`

**Validation:**
- ✅ Renewal updates `expiresAt` to new value
- ✅ Membership remains `'active'`
- ✅ API access continues to return `allowed: true`
- ✅ `renewedAt` timestamp is updated

**Acceptance Criterion:**
> Event ingestion creates expected wallet and membership records

### Policy Engine Integration Tests

**PUBLIC Policy:**
- ✅ Allows access regardless of membership state

**MEMBERS_ONLY Policy:**
- ✅ Denies expired members
- ✅ Denies suspended members
- ✅ Allows active members

**ADMINS_ONLY Policy:**
- ✅ Allows users with `admin` role assignment
- ✅ Denies members without role

**No Policy:**
- ✅ Denies access when policy doesn't exist

## Event Types & Fixtures

### MembershipMinted Event

```typescript
{
  type: 'MembershipMinted',
  to: '0xwalletaddress',        // wallet receiving membership
  tokenId: 1,                     // unique token identifier
  communityId: 'community-dev',  // which community
  expiresAt: 1700000000,          // unix timestamp (seconds)
}
```

**Database Effect:**
- Creates wallet if not exists
- Creates community if not exists
- Creates member if not exists in community
- Creates membership with `state: 'active'` and token/expiry

### MembershipRenewed Event

```typescript
{
  type: 'MembershipRenewed',
  tokenId: 1,
  newExpiresAt: 1700000000,
}
```

**Database Effect:**
- Updates membership `expiresAt` for the tokenId
- Sets `renewedAt` to now
- Preserves other fields (state, communityId, etc.)

### MembershipSuspended Event

```typescript
{
  type: 'MembershipSuspended',
  tokenId: 1,
  isSuspended: true,  // or false to unsuspend
}
```

**Database Effect:**
- Updates membership `state` to `'suspended'` (if true) or `'active'` (if false)
- Preserves expiry - suspension is independent of expiration

## Event Helpers API

### applyContractEvent(prisma, event)

Apply a single decoded contract event to the database.

```typescript
import { applyContractEvent } from './services/contractEventHelpers';

const event: DecodedMembershipMintedEvent = {
  type: 'MembershipMinted',
  to: '0xalice123...',
  tokenId: 1,
  communityId: 'dev',
  expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
};

await applyContractEvent(prisma, event);
```

**Guarantees:**
- Idempotent: calling twice with same event is safe
- Atomic: all related records (wallet, community, member, membership) are created/updated
- Validates: throws error if required fields missing

### applyContractEvents(prisma, events)

Apply multiple events in order (for batch processing or replay).

```typescript
const count = await applyContractEvents(prisma, [event1, event2, event3]);
// Returns number of events successfully applied
```

### getCurrentMembershipState(prisma, wallet, communityId)

Query current membership state for a wallet in a community.

```typescript
const state = await getCurrentMembershipState(prisma, '0xalice...', 'dev');
// Returns { tokenId, state, expiresAt } or null
```

### ensureCommunity(prisma, communityId, name)

Get or create a community (useful for test setup).

```typescript
const community = await ensureCommunity(prisma, 'dev', 'Developer Guild');
```

### tokenIdExists(prisma, tokenId)

Check if a tokenId has already been minted (detect duplicates).

```typescript
const exists = await tokenIdExists(prisma, 1);
```

## Acceptance Criteria Coverage

| Criterion | Test | Status |
|-----------|------|--------|
| **Test fixtures derived from MembershipNFT events** | Event types match MembershipNFT.sol exactly | ✅ |
| **Event ingestion creates expected wallet and membership records** | `Scenario 1: Active Membership` | ✅ |
| **API access checks reflect ingested membership state** | All policy engine tests | ✅ |
| **Suspended memberships produce deny decisions** | `Scenario 3: Suspended Membership` | ✅ |
| **Expired memberships produce deny decisions** | `Scenario 2: Expired Membership` | ✅ |
| **Tests run locally without live chain** | No external RPC calls | ✅ |
| **Fixtures can be extended for role-based access** | Role assignment tests included | ✅ |
| **Indexer checkpoint persistence & resume** | `Resilient Indexing Pipeline` tests | ✅ |
| **Reorg detection & state reconciliation** | `Resilient Indexing Pipeline` tests | ✅ |
| **Indexer health & lag metrics exposed** | `metrics.ts` (`indexer_lag_blocks`, `indexer_reorgs_detected_total`, `indexer_reconciliation_duration_seconds`) | ✅ |

## Implementation Details for Future Indexer

The `contractEventHelpers` module is designed to be reused by a future on-chain event indexer. Expected usage:

```typescript
// Pseudocode for event indexer
import { applyContractEvent } from './services/contractEventHelpers';

// Listen to contract events
contract.on('MembershipMinted', async (event) => {
  const decodedEvent: DecodedMembershipMintedEvent = {
    type: 'MembershipMinted',
    to: event.args.to,
    tokenId: event.args.tokenId.toNumber(),
    communityId: event.args.communityId,
    expiresAt: event.args.expiresAt.toNumber(),
    blockNumber: event.blockNumber,
    transactionHash: event.transactionHash,
  };

  await applyContractEvent(prisma, decodedEvent);
});
```

## Key Assumptions

1. **Event Order**: Tests assume events are applied in order. Indexer should maintain FIFO ordering.

2. **Timestamp Format**: Contract emits unix seconds; database stores as milliseconds. Helpers handle conversion.

3. **Wallet Case-Insensitivity**: All wallet addresses are lowercased for consistency.

4. **State Machine**: Membership state transitions are:
   - `active` → `suspended` (via suspend event)
   - `suspended` → `active` (via unsuspend event)
   - `active` (with past expiry) → computed as `expired` (not stored state)

5. **Membership Uniqueness**: One membership per (community, wallet) pair. Multiple mint events for same wallet/community overwrite.

6. **Renewal Semantics**: Renewal always succeeds and extends from max of (current expiry, now), never resets to now.

## Troubleshooting

### Test Fails: "Cannot renew membership: tokenId 999 not found"

**Cause**: Test applied `MembershipRenewed` before `MembershipMinted`

**Fix**: Ensure events are applied in order; mints must precede renewals

### Test Fails: "Invalid MembershipMinted event"

**Cause**: Event fixture missing required fields (to, tokenId, etc.)

**Fix**: Check event fixtures in test file; all fields required

### Test Hangs on Database Cleanup

**Cause**: Database connection not closing

**Fix**: Ensure `prisma.$disconnect()` is called in afterAll hook

### Tests Pass Locally but Fail in CI

**Cause**: Timezone differences or database state not cleaned

**Fix**: Use `beforeEach` cleanup for each test; tests are isolated by transaction scope

## Future Enhancements

1. **Batch Event Fixtures**: Generate fixtures from contract ABI using automated tools
2. **Event Replay Testing**: Add ability to replay real contract events from Etherscan
3. **Performance Tests**: Add scenarios with 10k+ memberships for scaling
4. **Event Indexing Worker**: Implement actual event listener using these helpers
5. **Webhook Events**: Add tests for notifying external systems of membership changes
