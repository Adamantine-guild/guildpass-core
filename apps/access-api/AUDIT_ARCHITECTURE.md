# Audit Chain of Custody - Architecture

## System Overview

The audit chain of custody system provides end-to-end traceability from blockchain events through database state changes to API access decisions.

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                     BLOCKCHAIN LAYER                          │
│                                                               │
│  MembershipNFT.sol Contract                                   │
│  ├─ MembershipMinted(to, tokenId, communityId, expiresAt)   │
│  ├─ MembershipRenewed(tokenId, newExpiresAt)                │
│  └─ MembershipSuspended(tokenId, isSuspended)               │
│                                                               │
│  Event Metadata:                                              │
│  • chainId: 1                                                │
│  • txHash: 0xabcd1234567890...                              │
│  • blockNumber: 12345678                                     │
│  • blockHash: 0x1111111111...                               │
│  • logIndex: 5                                               │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       │ RPC calls (getLogs)
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│                    INDEXER LAYER                              │
│                                                               │
│  IndexerWorker                                                │
│  ├─ Fetches blocks from chain                                │
│  ├─ Decodes contract events                                  │
│  ├─ Checks finality (12 block window)                        │
│  ├─ Detects reorgs                                           │
│  └─ Calls applyContractEvent()                               │
│                                                               │
│  Idempotency via ProcessedEvent table:                        │
│  • Key: (transactionHash, logIndex)                          │
│  • Prevents duplicate processing                             │
│  • Enables safe replay after reorgs                          │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       │ applyContractEvent(event)
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│                  DATABASE LAYER (Atomic Transaction)          │
│                                                               │
│  contractEventHelpers.applyContractEvent()                    │
│  │                                                            │
│  ├─ 1. Idempotency Check                                     │
│  │   SELECT * FROM ProcessedEvent                            │
│  │   WHERE txHash = ? AND logIndex = ?                       │
│  │   → Skip if already processed                             │
│  │                                                            │
│  ├─ 2. Generate Correlation ID                               │
│  │   correlationId = `${txHash}_${logIndex}_${timestamp}`   │
│  │                                                            │
│  ├─ 3. Update Business State                                 │
│  │   UPSERT Membership (tokenId, state, expiresAt)          │
│  │   UPSERT Member, Wallet, Community                        │
│  │                                                            │
│  ├─ 4. Create AuditEvent                                     │
│  │   INSERT INTO AuditEvent (                                │
│  │     eventType: 'MEMBERSHIP_CREATED',                      │
│  │     correlationId,                                        │
│  │     chainId, txHash, blockNumber, logIndex,              │
│  │     beforeState, afterState                              │
│  │   )                                                       │
│  │                                                            │
│  ├─ 5. Create OutboxEvent                                    │
│  │   INSERT INTO OutboxEvent (                               │
│  │     eventType: 'MEMBERSHIP_CREATED',                      │
│  │     correlationId,                                        │
│  │     chainId, txHash, blockNumber, logIndex,              │
│  │     payload, status: 'pending'                            │
│  │   )                                                       │
│  │                                                            │
│  └─ 6. Record Processed Event                                │
│      INSERT INTO ProcessedEvent (                             │
│        txHash, logIndex, blockHash, blockNumber              │
│      )                                                        │
│                                                               │
│  Result: All or nothing - atomic commit                       │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       │ State now persisted
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│                     ACCESS CHECK LAYER                        │
│                                                               │
│  POST /v1/access/check                                        │
│  { wallet, communityId, resource }                            │
│  │                                                            │
│  └─ memberService.checkAccess()                              │
│     │                                                          │
│     ├─ 1. Generate Correlation ID                            │
│     │   correlationId = `access_${communityId}_${wallet}_   │
│     │                    ${resource}_${timestamp}`           │
│     │                                                         │
│     ├─ 2. Query Current State                                │
│     │   SELECT Member, Membership, RoleAssignments           │
│     │   WHERE wallet = ? AND communityId = ?                │
│     │                                                         │
│     ├─ 3. Capture State Snapshot                             │
│     │   membershipSnapshot = {                               │
│     │     id, tokenId, state, expiresAt, effectiveState     │
│     │   }                                                    │
│     │   roleSnapshot = [{                                    │
│     │     id, role, source, active, expiresAt               │
│     │   }]                                                   │
│     │                                                         │
│     ├─ 4. Evaluate Policy                                    │
│     │   decision = PolicyEngine.evaluate(policy, context)    │
│     │                                                         │
│     └─ 5. Log AuditEvent                                     │
│         INSERT INTO AuditEvent (                              │
│           eventType: 'ACCESS_CHECK',                          │
│           correlationId,                                      │
│           decision: 'ALLOW' | 'DENY',                        │
│           policyRule, reasonCode,                            │
│           membershipStateVersion: JSON.stringify(snapshot),  │
│           roleStateVersion: JSON.stringify(roles),           │
│           chainId: null, // No direct chain origin           │
│           txHash: null                                        │
│         )                                                     │
│                                                               │
│  Return: AccessDecision { allowed, code, reasons, ... }       │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       │ Decision made and logged
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│                   AUDIT TRACE QUERY LAYER                     │
│                                                               │
│  Admin API Endpoints                                          │
│  │                                                            │
│  ├─ GET /admin/audit/trace/:correlationId                    │
│  │  └─ auditTraceService.getAuditTraceByCorrelationId()     │
│  │     • Queries AuditEvent WHERE correlationId = ?          │
│  │     • Queries OutboxEvent WHERE correlationId = ?         │
│  │     • Reconstructs complete chain of custody              │
│  │     • Returns: {                                          │
│  │         correlationId,                                    │
│  │         originatingOnChainEvent,                          │
│  │         databaseMutations,                                │
│  │         outboxEvents,                                     │
│  │         accessDecisions,                                  │
│  │         summary                                           │
│  │       }                                                   │
│  │                                                            │
│  ├─ GET /admin/audit/trace/tx/:txHash                        │
│  │  └─ auditTraceService.getAuditTracesByTxHash()           │
│  │     • Finds all correlationIds for txHash                │
│  │     • Fetches complete trace for each correlation         │
│  │     • Returns: { txHash, traces[], count }               │
│  │                                                            │
│  └─ GET /admin/audit/trace/wallet/:wallet?communityId=x     │
│     └─ auditTraceService.getAuditTracesByWallet()           │
│        • Finds recent correlationIds for wallet+community    │
│        • Fetches complete trace for each correlation         │
│        • Returns: { wallet, communityId, traces[], count }  │
│                                                               │
└──────────────────────────────────────────────────────────────┘

## Data Flow Examples

### Example 1: Membership Minted Event

```
1. ON-CHAIN EVENT
   MembershipMinted(
     to: "0xalice",
     tokenId: 42,
     communityId: "guild-1",
     expiresAt: 1707984000
   )
   Metadata: {
     chainId: 1,
     txHash: "0xabcd1234",
     blockNumber: 12345678,
     logIndex: 5
   }

2. INDEXER PROCESSES
   correlationId = "0xabcd1234_5_1234567890"

3. DATABASE WRITES (Atomic)
   ├─ Membership { tokenId: 42, state: 'active', ... }
   ├─ AuditEvent {
   │    eventType: 'MEMBERSHIP_CREATED',
   │    correlationId: "0xabcd1234_5_1234567890",
   │    chainId: 1,
   │    txHash: "0xabcd1234",
   │    blockNumber: 12345678,
   │    logIndex: 5,
   │    beforeState: null,
   │    afterState: { tokenId: 42, state: 'active', ... }
   │  }
   ├─ OutboxEvent {
   │    eventType: 'MEMBERSHIP_CREATED',
   │    correlationId: "0xabcd1234_5_1234567890",
   │    chainId: 1,
   │    txHash: "0xabcd1234",
   │    blockNumber: 12345678,
   │    logIndex: 5,
   │    payload: { memberId, tokenId, wallet, ... }
   │  }
   └─ ProcessedEvent { txHash, logIndex, blockHash, blockNumber }

4. QUERY TRACE
   GET /admin/audit/trace/0xabcd1234_5_1234567890
   
   Returns:
   {
     correlationId: "0xabcd1234_5_1234567890",
     originatingOnChainEvent: {
       chainId: 1,
       txHash: "0xabcd1234",
       blockNumber: 12345678,
       logIndex: 5
     },
     databaseMutations: [
       {
         eventType: "MEMBERSHIP_CREATED",
         beforeState: null,
         afterState: { tokenId: 42, state: "active" }
       }
     ],
     outboxEvents: [
       {
         eventType: "MEMBERSHIP_CREATED",
         status: "pending"
       }
     ],
     accessDecisions: [],
     summary: {
       totalEvents: 2,
       hasOnChainOrigin: true,
       eventTypes: ["MEMBERSHIP_CREATED"]
     }
   }
```

### Example 2: Access Check Decision

```
1. API REQUEST
   POST /v1/access/check
   {
     wallet: "0xalice",
     communityId: "guild-1",
     resource: "dashboard"
   }

2. ACCESS CHECK PROCESSES
   correlationId = "access_guild-1_0xalice_dashboard_1234567890"
   
   Queries database:
   ├─ Membership { tokenId: 42, state: 'active', expiresAt: ... }
   └─ RoleAssignments [{ role: 'admin', active: true }]
   
   Captures snapshots:
   ├─ membershipSnapshot = {
   │    id: "mem-123",
   │    tokenId: 42,
   │    state: "active",
   │    effectiveState: "active"
   │  }
   └─ roleSnapshot = [{
        id: "role-456",
        role: "admin",
        active: true
      }]
   
   Evaluates policy:
   └─ PolicyEngine.evaluate() → { allowed: true, code: 'ALLOW' }

3. DATABASE WRITE
   AuditEvent {
     eventType: 'ACCESS_CHECK',
     correlationId: "access_guild-1_0xalice_dashboard_1234567890",
     decision: 'ALLOW',
     policyRule: 'MEMBERS_ONLY',
     reasonCode: 'HAS_ACTIVE_MEMBERSHIP',
     membershipStateVersion: JSON.stringify(membershipSnapshot),
     roleStateVersion: JSON.stringify(roleSnapshot),
     chainId: null, // No direct blockchain origin
     txHash: null
   }

4. QUERY TRACE
   GET /admin/audit/trace/access_guild-1_0xalice_dashboard_1234567890
   
   Returns:
   {
     correlationId: "access_guild-1_0xalice_dashboard_1234567890",
     originatingOnChainEvent: null, // Access check has no chain origin
     databaseMutations: [],
     outboxEvents: [],
     accessDecisions: [
       {
         decision: "ALLOW",
         resource: "dashboard",
         policyRule: "MEMBERS_ONLY",
         reasonCode: "HAS_ACTIVE_MEMBERSHIP",
         membershipState: {
           id: "mem-123",
           tokenId: 42,
           state: "active",
           effectiveState: "active"
         },
         roleState: [
           {
             id: "role-456",
             role: "admin",
             active: true
           }
         ]
       }
     ],
     summary: {
       totalEvents: 1,
       hasOnChainOrigin: false,
       eventTypes: ["ACCESS_CHECK"]
     }
   }
```

## Component Relationships

```
┌──────────────────┐
│   Blockchain     │
│   (Ethereum L1)  │
└────────┬─────────┘
         │
         │ Events emitted
         │
         ▼
┌──────────────────┐
│  IndexerWorker   │◄──────┐
│  (Polling loop)  │       │
└────────┬─────────┘       │
         │                 │ Reorg detected
         │ Processes       │ → Rewind & replay
         │                 │
         ▼                 │
┌─────────────────────────┴──────────┐
│  contractEventHelpers              │
│  • applyContractEvent()            │
│  • Generates correlationId         │
│  • Atomic transaction writes       │
└────────┬───────────────────────────┘
         │
         │ Creates
         │
         ▼
┌─────────────────────────────────────┐
│  Database Tables                    │
│  ├─ Membership (business state)    │
│  ├─ AuditEvent (audit trail)       │
│  ├─ OutboxEvent (integration)      │
│  └─ ProcessedEvent (idempotency)   │
└────────┬────────────────────────────┘
         │
         │ Queried by
         │
         ▼
┌─────────────────────────────────────┐
│  memberService                      │
│  • checkAccess()                    │
│  • Captures state snapshots         │
│  • Logs access decisions            │
└────────┬────────────────────────────┘
         │
         │ Queries
         │
         ▼
┌─────────────────────────────────────┐
│  auditTraceService                  │
│  • getAuditTraceByCorrelationId()  │
│  • getAuditTracesByTxHash()        │
│  • getAuditTracesByWallet()        │
│  • Reconstructs full chain         │
└────────┬────────────────────────────┘
         │
         │ Exposes via
         │
         ▼
┌─────────────────────────────────────┐
│  Admin API Endpoints                │
│  • /admin/audit/trace/:id          │
│  • /admin/audit/trace/tx/:hash     │
│  • /admin/audit/trace/wallet/:addr │
└─────────────────────────────────────┘
```

## Key Design Decisions

### 1. Correlation ID Strategy

**Problem:** How to link related events across system boundaries?

**Solution:** Generate unique correlation IDs at event origin:
- Blockchain events: `${txHash}_${logIndex}_${timestamp}`
- Access checks: `access_${communityId}_${wallet}_${resource}_${timestamp}`

**Benefits:**
- Unique across the system
- Contains context for debugging
- Enables efficient queries
- Supports distributed tracing

### 2. State Snapshot Capture

**Problem:** Access decisions read current state, but state may change later. How to audit what state was actually evaluated?

**Solution:** Capture JSON snapshots before evaluation:
```typescript
const membershipSnapshot = {
  id: member.membership.id,
  tokenId: member.membership.tokenId,
  state: member.membership.state,
  expiresAt: member.membership.expiresAt?.toISOString(),
  effectiveState, // Computed at evaluation time
};
```

**Benefits:**
- Reproducible decisions (can replay evaluation)
- Debugging (know exactly what was evaluated)
- Compliance (prove correct evaluation)
- Historical analysis (state at decision time)

### 3. Append-Only Audit Trail

**Problem:** How to ensure audit trail cannot be tampered with?

**Solution:** No update/delete operations:
- Schema level: No update/delete in application code
- API level: No endpoints for modifying audit records
- Service level: All operations are creates

**Benefits:**
- Tamper-evident
- Compliance-friendly
- Simple reasoning about history
- No race conditions

### 4. Atomic Transaction Boundaries

**Problem:** What if audit logging fails? Or state update fails?

**Solution:** All writes in same Prisma transaction:
```typescript
await prisma.$transaction(async (tx) => {
  await tx.membership.upsert({...});
  await tx.auditEvent.create({...});
  await tx.outboxEvent.create({...});
});
```

**Benefits:**
- Consistency: State and audit are always in sync
- No partial writes
- Simplified error handling
- Database guarantees ACID properties

### 5. Idempotency via ProcessedEvent

**Problem:** Blockchain reorgs can cause events to be replayed. How to prevent duplicate audit records?

**Solution:** Track processed events by (txHash, logIndex):
```typescript
const alreadyProcessed = await tx.processedEvent.findUnique({
  where: {
    transactionHash_logIndex: { txHash, logIndex }
  }
});
if (alreadyProcessed) return; // Skip
```

**Benefits:**
- Safe to replay events
- Reorg protection
- No duplicate audit records
- Consistent state

### 6. Separation of Chain Origin vs Access Check

**Problem:** Should access checks link to originating blockchain transactions?

**Solution:** No - access checks get their own correlation IDs:
- Blockchain events: Have chainId, txHash, blockNumber, logIndex
- Access checks: Have null for blockchain metadata

**Benefits:**
- Clear separation of concerns
- Access checks independent of chain events
- Can query "all access checks" vs "all chain events"
- Flexibility for non-blockchain state changes

### 7. Query Flexibility

**Problem:** How should admins query audit trails?

**Solution:** Three query methods:
1. By correlation ID - Get specific trace
2. By transaction hash - Find all traces from one blockchain transaction
3. By wallet + community - Find user activity

**Benefits:**
- Supports different investigation workflows
- Efficient indexes for each query type
- Flexible without being overwhelming
- Maps to natural questions

## Security Architecture

### Threat Model

**Threats:**
1. **Unauthorized Access**: Non-admins querying audit trails
2. **Data Tampering**: Modifying audit records
3. **Data Deletion**: Removing audit records
4. **Denial of Service**: Overwhelming system with queries
5. **Privacy Violation**: Exposing sensitive user data

**Mitigations:**
1. Admin-only endpoints (TODO: Add authentication)
2. No update operations in code
3. No delete operations in code
4. Rate limiting (TODO: Implement)
5. Access logging for admin queries

### Data Classification

**Sensitive Data in Audit Trail:**
- Wallet addresses (PII in some jurisdictions)
- Membership states (user status)
- Access decisions (behavior tracking)
- Policy rules (business logic)

**Recommendations:**
- Encrypt at rest
- Implement retention policies
- Add data access logging
- Consider PII redaction for queries

### Compliance Considerations

**GDPR:**
- Right to be forgotten: May conflict with immutable audit trail
- Solution: Implement pseudonymization or selective deletion with audit

**SOC 2:**
- Audit trail required for compliance
- Must demonstrate tamper-evidence
- Regular compliance reviews needed

**HIPAA (if applicable):**
- Access logging required
- Encryption at rest required
- Retention policies required

## Performance Characteristics

### Write Performance

**Contract Event Processing:**
- Single transaction write
- 4 INSERT operations (Membership, AuditEvent, OutboxEvent, ProcessedEvent)
- Expected: <50ms per event
- Bottleneck: Database transaction commit

**Access Check Logging:**
- Single INSERT operation (AuditEvent)
- Expected: <10ms
- Typically async (non-blocking)

### Read Performance

**Query by Correlation ID:**
- Index: `correlationId`
- Expected: <50ms
- Returns: Single trace

**Query by Transaction Hash:**
- Index: `txHash`
- Expected: <100ms
- Returns: Multiple traces (typically 1-10)

**Query by Wallet:**
- Index: `walletId`, `communityId`
- Expected: <200ms with limit=50
- Returns: Recent traces

### Scaling Considerations

**Current Limits:**
- ~1000 events/second on single database instance
- Query performance degrades after ~10M audit events

**Scaling Strategies:**
1. **Partitioning**: Partition audit tables by date
2. **Archival**: Move old audit records to cold storage
3. **Read Replicas**: Separate read/write traffic
4. **Caching**: Cache frequent queries
5. **Event Sourcing**: Consider event store for high volume

## Monitoring & Observability

### Key Metrics

**Indexer Health:**
- Blocks processed per minute
- Event processing latency
- Reorg detection count
- Failed event processing count

**Audit Trail Health:**
- Audit events created per minute
- Query response time (p50, p95, p99)
- Failed audit writes count
- Audit trail completeness (gaps detected)

**Access Decision Metrics:**
- Access checks per minute
- Allow vs Deny ratio
- Average decision latency
- State snapshot capture failures

### Alerts

**Critical:**
- Audit write failures (immediate alert)
- Reorg detected (investigate)
- Query endpoint down (immediate alert)

**Warning:**
- High query latency (p95 > 1s)
- Unusual query patterns
- High event processing backlog

### Logging

**Structured Logging:**
```typescript
logger.info({
  type: 'AUDIT_EVENT_CREATED',
  correlationId,
  eventType,
  hasBlockchainOrigin: !!chainId,
  timestamp: new Date(),
});

logger.info({
  type: 'AUDIT_QUERY',
  queryType: 'by_correlation_id',
  correlationId,
  user: adminUser,
  duration: queryDuration,
});
```

## Future Enhancements

### 1. Cryptographic Verification
- Merkle tree over audit events
- Periodic blockchain anchoring
- Signature verification

### 2. Real-time Streaming
- WebSocket subscriptions
- Audit event streaming to monitoring systems
- Real-time dashboards

### 3. Advanced Analytics
- Pattern detection
- Anomaly detection
- Compliance reporting
- User behavior analytics

### 4. Enhanced Queryability
- Full-text search
- Time-range queries
- Complex filters
- Aggregations

## Conclusion

The audit chain of custody architecture provides:

✅ **Complete Traceability**: Blockchain → Database → Access Decision  
✅ **Tamper Evidence**: Append-only with no update/delete operations  
✅ **Atomicity**: Consistent state and audit trail  
✅ **Idempotency**: Safe to replay blockchain events  
✅ **State Snapshots**: Exact state captured at decision time  
✅ **Query Flexibility**: Three query methods for different workflows  
✅ **Performance**: Sub-second queries with proper indexing  
✅ **Security**: Admin-only with audit logging  

This architecture establishes a solid foundation for compliance, debugging, and accountability.
