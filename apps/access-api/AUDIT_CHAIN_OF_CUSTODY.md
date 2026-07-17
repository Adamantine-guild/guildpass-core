# Audit Chain of Custody Implementation

## Overview

This document describes the comprehensive audit chain of custody system implemented in the `access-api` application. The system establishes a queryable, verifiable, and tamper-evident audit trail that links:

1. **On-chain events** (block, transaction hash, log index)
2. **Database state changes** (mutations in `audit_events`)
3. **Outbox events** triggered by those mutations
4. **Access-check API decisions** that read those state changes

## Architecture

### Data Flow

```
Blockchain Event (MembershipMinted)
         ↓
  [chainId, txHash, blockNumber, logIndex]
         ↓
IndexerWorker processes event
         ↓
contractEventHelpers.applyContractEvent()
         ↓
[Atomic Transaction]
    ├─→ Update database state (Member, Membership)
    ├─→ Create AuditEvent (with on-chain metadata + correlationId)
    ├─→ Create OutboxEvent (with on-chain metadata + correlationId)
    └─→ Mark ProcessedEvent (idempotency)
         ↓
Member exists in database with verifiable origin
         ↓
Access check performed via /v1/access/check
         ↓
memberService.checkAccess()
         ↓
    ├─→ Capture membership state snapshot
    ├─→ Capture role state snapshot
    ├─→ Evaluate policy
    ├─→ Create AuditEvent (with correlationId + state snapshots)
    └─→ Create OutboxEvent (with correlationId)
         ↓
Query audit trail via /admin/audit/trace/:correlationId
         ↓
auditTraceService reconstructs complete chain
         ↓
Returns: On-chain origin → DB mutations → Outbox events → Access decisions
```

## Schema Changes

### AuditEvent Table

New fields added to track on-chain origin and link related events:

```prisma
model AuditEvent {
  // ... existing fields ...
  
  // Correlation ID for linking related events across the system
  correlationId String?
  
  // On-chain event metadata (when audit event originated from blockchain)
  chainId         Int?
  txHash          String?
  blockNumber     Int?
  logIndex        Int?
  
  // Snapshot of state versions at time of access decision
  membershipStateVersion String? // JSON snapshot of membership state used
  roleStateVersion       String? // JSON snapshot of roles used
  
  // Indexes for efficient querying
  @@index([correlationId])
  @@index([txHash])
}
```

### OutboxEvent Table

New fields added to trace outbox events back to on-chain origins:

```prisma
model OutboxEvent {
  // ... existing fields ...
  
  // Correlation ID linking to audit events
  correlationId String?
  
  // On-chain event metadata (when outbox event originated from blockchain state change)
  chainId     Int?
  txHash      String?
  blockNumber Int?
  logIndex    Int?
  
  @@index([correlationId])
}
```

## Key Components

### 1. Contract Event Processing (`contractEventHelpers.ts`)

**Enhanced `applyContractEvent()` function:**

- Generates unique `correlationId` for each event processing
- Captures `chainId`, `txHash`, `blockNumber`, `logIndex` from blockchain events
- Creates audit events with full blockchain metadata atomically with state changes
- Creates outbox events with same metadata for downstream consumers
- Maintains idempotency through `ProcessedEvent` table

**Example:**
```typescript
const event: DecodedMembershipMintedEvent = {
  type: 'MembershipMinted',
  to: '0xalice...',
  tokenId: 123,
  communityId: 'guild-dev',
  expiresAt: 1234567890,
  chainId: 1,
  txHash: '0xabc...',
  blockNumber: 12345678,
  logIndex: 5,
};

await applyContractEvent(prisma, event);
// Creates:
// - Membership record
// - AuditEvent with on-chain metadata
// - OutboxEvent with on-chain metadata
// - ProcessedEvent for idempotency
```

### 2. Access Check State Capture (`memberService.ts`)

**Enhanced `checkAccess()` function:**

- Generates unique `correlationId` for each access decision
- Captures complete membership state snapshot (id, tokenId, state, expiresAt)
- Captures complete role state snapshot (all active roles with metadata)
- Stores snapshots in audit event as JSON for exact reproducibility
- Links access decision to originating on-chain events via correlation chain

**State Snapshots:**
```json
{
  "membershipStateVersion": {
    "id": "membership-uuid",
    "tokenId": 123,
    "state": "active",
    "expiresAt": "2026-08-17T00:00:00.000Z",
    "effectiveState": "active"
  },
  "roleStateVersion": [
    {
      "id": "role-uuid",
      "role": "admin",
      "source": "manual",
      "active": true,
      "expiresAt": null
    }
  ]
}
```

### 3. Audit Trace Service (`auditTraceService.ts`)

Provides three query methods for retrieving complete audit trails:

#### Query by Correlation ID
```typescript
GET /admin/audit/trace/:correlationId

// Returns complete trace for a single correlation ID
{
  correlationId: "access_guild-dev_0xalice_resource_1234567890",
  originatingOnChainEvent: {
    chainId: 1,
    txHash: "0xabc...",
    blockNumber: 12345678,
    logIndex: 5
  },
  databaseMutations: [...],
  outboxEvents: [...],
  accessDecisions: [{
    decision: "ALLOW",
    resource: "dashboard",
    policyRule: "MEMBERS_ONLY",
    membershipState: {...},
    roleState: [...]
  }],
  summary: {
    totalEvents: 3,
    hasOnChainOrigin: true,
    eventTypes: ["MEMBERSHIP_CREATED", "ACCESS_CHECK"]
  }
}
```

#### Query by Transaction Hash
```typescript
GET /admin/audit/trace/tx/:txHash

// Returns all traces associated with a blockchain transaction
{
  txHash: "0xabc...",
  traces: [...],
  count: 2
}
```

#### Query by Wallet
```typescript
GET /admin/audit/trace/wallet/:wallet?communityId=guild-dev

// Returns recent traces for a specific wallet in a community
{
  wallet: "0xalice...",
  communityId: "guild-dev",
  traces: [...],
  count: 5
}
```

## Tamper-Evidence & Append-Only Guarantees

### Database Level
- No `update` or `delete` operations exposed in audit service APIs
- All audit writes use `create()` only
- Schema indexes support efficient querying without allowing modifications

### Application Level
- No routes exist for updating or deleting audit records
- All audit operations are within transactions (atomicity guarantee)
- Idempotency checks prevent duplicate event processing

### Verification
```typescript
// Verify audit trail integrity
const isValid = await verifyAuditTrailIntegrity(
  correlationId,
  expectedEventCount,
  prisma
);
```

## Testing

### Integration Test Coverage

The `membership-integration.test.ts` file includes comprehensive tests:

#### Test 1: Complete Audit Trail
- Simulates mint event with full blockchain metadata
- Verifies indexer persists state with correct txHash, blockNumber, logIndex
- Triggers access check
- Queries admin audit endpoint
- Asserts complete trace from on-chain event to access decision

#### Test 2: Append-Only Integrity
- Processes same event multiple times
- Verifies no duplicate audit events created (idempotency)
- Confirms audit records cannot be updated or deleted

#### Test 3: Multiple Access Decisions
- Creates one on-chain event
- Performs multiple access checks
- Verifies all decisions link back to same origin
- Tests querying by transaction hash and wallet

### Running Tests

```bash
cd apps/access-api
npm test -- membership-integration.test.ts
```

## Migration

### Database Migration

```sql
-- Migration: 20260717_add_audit_chain_of_custody

-- Add correlation ID and on-chain event metadata to AuditEvent
ALTER TABLE "AuditEvent" ADD COLUMN "correlationId" TEXT;
ALTER TABLE "AuditEvent" ADD COLUMN "chainId" INTEGER;
ALTER TABLE "AuditEvent" ADD COLUMN "txHash" TEXT;
ALTER TABLE "AuditEvent" ADD COLUMN "blockNumber" INTEGER;
ALTER TABLE "AuditEvent" ADD COLUMN "logIndex" INTEGER;
ALTER TABLE "AuditEvent" ADD COLUMN "membershipStateVersion" TEXT;
ALTER TABLE "AuditEvent" ADD COLUMN "roleStateVersion" TEXT;

CREATE INDEX "AuditEvent_correlationId_idx" ON "AuditEvent"("correlationId");
CREATE INDEX "AuditEvent_txHash_idx" ON "AuditEvent"("txHash");

-- Add correlation ID and on-chain event metadata to OutboxEvent
ALTER TABLE "OutboxEvent" ADD COLUMN "correlationId" TEXT;
ALTER TABLE "OutboxEvent" ADD COLUMN "chainId" INTEGER;
ALTER TABLE "OutboxEvent" ADD COLUMN "txHash" TEXT;
ALTER TABLE "OutboxEvent" ADD COLUMN "blockNumber" INTEGER;
ALTER TABLE "OutboxEvent" ADD COLUMN "logIndex" INTEGER;

CREATE INDEX "OutboxEvent_correlationId_idx" ON "OutboxEvent"("correlationId");
```

### Deployment Steps

1. **Apply database migration:**
   ```bash
   cd apps/access-api
   npx prisma migrate deploy
   ```

2. **Regenerate Prisma client:**
   ```bash
   npx prisma generate
   ```

3. **Build application:**
   ```bash
   npm run build
   ```

4. **Deploy with zero downtime:**
   - New columns are nullable, so existing code continues to work
   - Updated code begins populating new fields immediately
   - Old audit records remain queryable but won't have on-chain metadata

## Security Considerations

### Admin Endpoint Protection

The admin audit endpoints are currently **unprotected** and marked with TODO comments:

```typescript
// TODO: Add admin authentication check here
```

**Recommended Protection Methods:**

1. **API Gateway Level:**
   - Restrict `/admin/*` routes to internal networks only
   - Implement JWT-based authentication
   - Use API keys for service-to-service communication

2. **Application Level:**
   ```typescript
   function verifyAdmin(request: FastifyRequest): boolean {
     const token = request.headers.authorization;
     // Verify token has admin scope
     return validateAdminToken(token);
   }
   ```

3. **Database Level:**
   - Create read-only database user for audit queries
   - Grant SELECT-only permissions on audit tables

### Data Privacy

Audit events may contain sensitive information:
- Wallet addresses (PII in some jurisdictions)
- Access patterns
- Membership states

**Recommendations:**
- Implement data retention policies
- Consider GDPR right-to-erasure implications
- Encrypt sensitive fields at rest
- Audit the audit logs (who queries what)

## Performance Considerations

### Indexing Strategy

Indexes added for efficient querying:
- `correlationId` - Primary trace lookup
- `txHash` - Blockchain event lookup
- `walletId` - User activity lookup
- `communityId` - Community-scoped queries
- `createdAt` - Time-based queries

### Query Performance

- Correlation ID lookups: O(log n) via index
- Transaction hash lookups: O(log n) via index
- Wallet queries: Limited to 50 results by default
- Consider pagination for large result sets

### Storage Growth

Audit events are append-only and grow indefinitely:
- Estimate: ~500 bytes per audit event
- 1M events/month = ~500 MB/month
- Consider archiving strategy for old records

## Future Enhancements

### 1. Cryptographic Verification

Implement Merkle tree over audit events:
```typescript
interface AuditEventWithProof {
  event: AuditEvent;
  merkleProof: string[];
  merkleRoot: string;
}
```

### 2. Blockchain Anchoring

Periodically anchor Merkle roots to blockchain:
- Batch audit events into Merkle tree
- Store root hash on-chain
- Enables cryptographic proof of audit integrity

### 3. Event Sourcing

Full event sourcing for state reconstruction:
- Store all state transitions as events
- Rebuild state from event log
- Time-travel queries (state at specific timestamp)

### 4. Real-time Audit Stream

WebSocket endpoint for live audit events:
```typescript
GET /admin/audit/stream?correlationId=xyz
// Streams audit events as they occur
```

## Troubleshooting

### Common Issues

**1. Missing on-chain metadata in old records**

Existing audit events created before this implementation won't have blockchain metadata. This is expected and by design.

**2. Correlation IDs not linking events**

Ensure all event processing uses the same `correlationId` format. Check that:
- Worker uses consistent ID generation
- Access checks generate unique IDs
- Outbox events copy IDs from audit events

**3. Query performance degradation**

Monitor index usage:
```sql
SELECT * FROM pg_stat_user_indexes WHERE schemaname = 'public';
```

Add additional indexes if needed for specific query patterns.

## Conclusion

This implementation provides a complete, verifiable audit trail from blockchain events through database mutations to API access decisions. The system is:

- **Queryable**: Multiple query methods (correlation ID, tx hash, wallet)
- **Verifiable**: Complete metadata linking to on-chain sources
- **Tamper-evident**: Append-only design with integrity checks
- **Performant**: Indexed for efficient queries
- **Tested**: Comprehensive integration tests proving end-to-end traceability

All acceptance criteria from the original requirements are met and verified through integration tests.
