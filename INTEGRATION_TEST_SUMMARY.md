# End-to-End Membership Integration Test Implementation

## Summary

✅ **Completed** - A comprehensive integration test suite that validates the flow from MembershipNFT contract events to API access control decisions.

## What Was Delivered

### 1. Integration Test Suite (`membership-integration.test.ts`)
- **330+ lines** of comprehensive test coverage
- **4 main scenarios** + policy engine + profile endpoint tests
- Tests the complete flow: Contract Event → Database → Policy Engine → API Response
- Uses Fastify `app.inject()` for realistic HTTP testing
- Covers all acceptance criteria

**Test Scenarios:**
- ✅ Active membership grants access
- ✅ Expired membership denies access
- ✅ Suspended membership denies access  
- ✅ Membership renewal extends expiry
- ✅ Policy engine (PUBLIC, MEMBERS_ONLY, ADMINS_ONLY)
- ✅ Role-based access control

### 2. Event Processing Helpers (`contractEventHelpers.ts`)
- **210+ lines** of reusable utilities
- Designed for integration tests AND future event indexer
- Handles three event types: MembershipMinted, MembershipRenewed, MembershipSuspended
- Idempotent operations - safe to replay events
- Full validation and error handling

**Functions:**
- `applyContractEvent()` - Apply a single event to database
- `applyContractEvents()` - Apply multiple events in order
- `ensureCommunity()` - Get or create community
- `getCurrentMembershipState()` - Query membership state
- `tokenIdExists()` - Check for duplicate tokens

### 3. Helper Unit Tests (`contractEventHelpers.test.ts`)
- **360+ lines** of thorough unit test coverage
- Tests all event types and edge cases
- Validates batch processing, idempotency, error handling
- Ensures helpers work correctly before integration testing

### 4. Complete Documentation (`INTEGRATION_TEST_GUIDE.md`)
- **350+ lines** of detailed documentation
- Architecture overview and flow diagrams
- Step-by-step scenario descriptions
- Event type specifications with database effects
- API reference for all helpers
- Acceptance criteria coverage matrix
- Troubleshooting guide
- Extensibility notes for future indexer

### 5. README Update
- Added integration testing section
- Links to comprehensive guide
- Quick start instructions for running tests

## Acceptance Criteria - All Met ✅

| Criterion | Status | Test |
|-----------|--------|------|
| **Test fixtures derived from MembershipNFT events** | ✅ | Event types match contract exactly |
| **Event ingestion creates expected wallet and membership records** | ✅ | Scenario 1 + Helper tests |
| **API access checks reflect ingested membership state** | ✅ | All policy engine tests |
| **Suspended memberships produce deny decisions** | ✅ | Scenario 3 |
| **Expired memberships produce deny decisions** | ✅ | Scenario 2 |
| **Tests run locally without live chain** | ✅ | No RPC calls, pure database tests |
| **Fixtures can be extended for roles** | ✅ | Role assignment tests included |

## Quick Start

### Run All Tests
```bash
cd apps/access-api
pnpm test
```

### Run Only Integration Tests
```bash
cd apps/access-api
pnpm test -- membership-integration.test.ts
pnpm test -- contractEventHelpers.test.ts
```

### View Documentation
```bash
cat apps/access-api/INTEGRATION_TEST_GUIDE.md
```

## Architecture

```
MembershipNFT Contract Events (Solidity)
    ↓
Event Fixtures (JSON - derived from contract)
    ↓
applyContractEvent() Helpers (TypeScript)
    ↓
Database State (Prisma/PostgreSQL)
    ↓
memberService.getMembershipsByWallet() (business logic)
    ↓
Policy Engine (evaluate() rules)
    ↓
API Routes (Fastify)
    ↓
app.inject() (test HTTP requests)
    ↓
Assertions (Jest)
```

## Event Types

All events are derived directly from `MembershipNFT.sol`:

### MembershipMinted
- **From Contract**: `event MembershipMinted(address indexed to, uint256 indexed tokenId, string communityId, uint256 expiresAt)`
- **Test Fixture**: Creates wallet, community, member, and membership in database
- **Effects**: Sets state='active', tokenId, expiresAt

### MembershipRenewed
- **From Contract**: `event MembershipRenewed(uint256 indexed tokenId, uint256 newExpiresAt)`
- **Test Fixture**: Updates membership expiresAt and renewedAt timestamp
- **Effects**: Preserves state and other fields

### MembershipSuspended
- **From Contract**: `event MembershipSuspended(uint256 indexed tokenId, bool isSuspended)`
- **Test Fixture**: Toggles state between 'suspended' and 'active'
- **Effects**: Independent of expiry - suspension is a separate concern

## Test Data Flow Example

```typescript
// 1. Event Fixture (from contract)
const event = {
  type: 'MembershipMinted',
  to: '0xalice...',
  tokenId: 1,
  communityId: 'dev',
  expiresAt: 1700000000, // unix timestamp
};

// 2. Apply to Database
await applyContractEvent(prisma, event);

// 3. Creates Database Records
// Wallet: { address: '0xalice...' }
// Community: { id: 'dev', name: 'dev Community' }
// Member: { communityId: 'dev', walletId: ... }
// Membership: { tokenId: 1, state: 'active', expiresAt: ... }

// 4. API Access Check
const response = await app.inject({
  method: 'POST',
  url: '/v1/access/check',
  payload: { wallet: '0xalice...', communityId: 'dev', resource: 'dashboard' }
});

// 5. Result
// { allowed: true, membershipState: 'active', ... }
```

## Key Design Features

### Idempotency
- Events can be safely applied multiple times
- Useful for indexer restart scenarios
- Database upserts instead of inserts

### State Normalization
- `expiresAt` is checked at **read-time**, not stored state
- If expiry date is in past, state is computed as 'expired'
- Suspension state is stored and independent of expiry
- This means database doesn't need periodic cleanup

### Case Insensitivity
- Wallet addresses normalized to lowercase
- Prevents duplicate wallet issues across case variations

### Error Handling
- Validations on all required fields
- Helpful error messages for debugging
- Throws on data inconsistencies (e.g., renew non-existent tokenId)

## Files Included

```
apps/access-api/
├── src/
│   ├── membership-integration.test.ts          # E2E integration tests
│   └── services/
│       ├── contractEventHelpers.ts             # Reusable event utilities
│       └── contractEventHelpers.test.ts        # Unit tests for helpers
├── INTEGRATION_TEST_GUIDE.md                   # Complete documentation
└── [existing files]
```

## Future Extensibility

### For Event Indexer Implementation
The `contractEventHelpers` module provides a clear interface that can be used by a real on-chain event listener:

```typescript
contract.on('MembershipMinted', async (rawEvent) => {
  const decoded = {
    type: 'MembershipMinted',
    to: rawEvent.args.to,
    tokenId: rawEvent.args.tokenId.toNumber(),
    communityId: rawEvent.args.communityId,
    expiresAt: rawEvent.args.expiresAt.toNumber(),
  };
  await applyContractEvent(prisma, decoded);
});
```

### For Additional Scenarios
- Add role-based membership (member vs contributor)
- Add membership tier levels
- Add event history tracking
- Add webhook notifications on state changes
- Add bulk import from CSV
- Add membership recovery/appeals workflow

## Verification

✅ **Code Quality**: No TypeScript errors
✅ **Type Safety**: Full typing for all event types
✅ **Test Coverage**: 4 scenarios + 20+ assertions
✅ **Documentation**: Comprehensive guide with examples
✅ **Reusability**: Helpers designed for future indexer
✅ **Isolation**: Each test cleans up database state
✅ **Deterministic**: No external dependencies or randomness

## Running the Tests

**First time setup:**
```bash
cd apps/access-api
pnpm install
export DATABASE_URL="postgresql://user:password@localhost:5432/guildpass"
pnpm exec prisma migrate deploy
```

**Run tests:**
```bash
pnpm test
```

**Run specific test file:**
```bash
pnpm test -- membership-integration.test.ts
pnpm test -- contractEventHelpers.test.ts
```

**Run with coverage:**
```bash
pnpm test -- --coverage
```

## Questions & Troubleshooting

See **INTEGRATION_TEST_GUIDE.md** for:
- Detailed test descriptions
- Event fixture format
- API reference
- Common issues and solutions
- Implementation examples

## Next Steps (Optional Future Work)

1. **Event Indexer Worker**: Implement actual on-chain event listener using helpers
2. **Batch Fixtures**: Generate from contract ABI automatically
3. **Performance Testing**: Validate with 10k+ memberships
4. **Event Replay**: Tool to replay real historical events
5. **Webhook Events**: Notify external systems of state changes
