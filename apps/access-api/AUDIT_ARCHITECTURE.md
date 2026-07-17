# Audit Chain of Custody - Architecture Diagram

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          BLOCKCHAIN LAYER                               │
│                                                                         │
│  ┌────────────┐      ┌────────────┐      ┌────────────┐               │
│  │  Block N   │─────▶│ Block N+1  │─────▶│ Block N+2  │               │
│  └────────────┘      └────────────┘      └────────────┘               │
│       │                    │                    │                      │
│       │            ┌───────┴────────┐          │                      │
│       │            │  Transaction   │          │                      │
│       │            │  0xabc...def   │          │                      │
│       │            └───────┬────────┘          │                      │
│       │                    │                    │                      │
│       │            ┌───────┴────────┐          │                      │
│       │            │ MembershipMinted│          │                      │
│       │            │   Log Index: 5  │          │                      │
│       │            └───────┬────────┘          │                      │
└───────┼────────────────────┼────────────────────┼──────────────────────┘
        │                    │                    │
        │                    ▼                    │
        │      ┌─────────────────────────┐       │
        │      │   IndexerWorker         │       │
        │      │  - Polls blockchain     │       │
        │      │  - Decodes events       │       │
        │      │  - Handles reorgs       │       │
        │      └──────────┬──────────────┘       │
        │                 │                       │
        │                 ▼                       │
┌───────┼─────────────────────────────────────────┼──────────────────────┐
│       │         DATABASE LAYER (PostgreSQL)     │                      │
│       │                                          │                      │
│       │   ┌──────────────────────────────────────┴─────────────┐      │
│       │   │    contractEventHelpers.applyContractEvent()        │      │
│       │   │                                                      │      │
│       │   │  1. Generate correlationId                          │      │
│       │   │     = txHash_logIndex_timestamp                     │      │
│       │   │                                                      │      │
│       │   │  2. BEGIN TRANSACTION ┐                             │      │
│       │   │                       │                             │      │
│       │   │  3. Update State      │ (Atomic)                    │      │
│       │   │     - Create/Update   │                             │      │
│       │   │       Membership      │                             │      │
│       │   │                       │                             │      │
│       │   │  4. Create AuditEvent │                             │      │
│       │   │     + correlationId   │                             │      │
│       │   │     + chainId         │                             │      │
│       │   │     + txHash          │                             │      │
│       │   │     + blockNumber     │                             │      │
│       │   │     + logIndex        │                             │      │
│       │   │     + beforeState     │                             │      │
│       │   │     + afterState      │                             │      │
│       │   │                       │                             │      │
│       │   │  5. Create OutboxEvent│                             │      │
│       │   │     + correlationId   │                             │      │
│       │   │     + on-chain meta   │                             │      │
│       │   │                       │                             │      │
│       │   │  6. Mark Processed    │                             │      │
│       │   │                       │                             │      │
│       │   │  7. COMMIT            │                             │      │
│       │   └──────────────────────┴──────────────────────────────┘      │
│       │                                                                 │
│       │   ┌─────────────┐  ┌──────────────┐  ┌──────────────┐        │
│       │   │ AuditEvent  │  │ OutboxEvent  │  │ Membership   │        │
│       │   ├─────────────┤  ├──────────────┤  ├──────────────┤        │
│       │   │ id          │  │ id           │  │ id           │        │
│       │   │ correlationId│ │ correlationId│ │ memberId     │        │
│       │   │ chainId: 1  │  │ chainId: 1   │  │ tokenId: 123 │        │
│       │   │ txHash: 0x..│  │ txHash: 0x...│  │ state: active│        │
│       │   │ blockNum:...│  │ blockNum:... │  │ expiresAt    │        │
│       │   │ logIndex: 5 │  │ logIndex: 5  │  └──────────────┘        │
│       │   │ eventType   │  │ eventType    │                          │
│       │   │ beforeState │  │ payload      │                          │
│       │   │ afterState  │  │ status       │                          │
│       │   └─────────────┘  └──────────────┘                          │
└───────┼─────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       APPLICATION LAYER                              │
│                                                                      │
│   POST /v1/access/check                                              │
│   ┌──────────────────────────────────────────────────────┐          │
│   │  memberService.checkAccess()                         │          │
│   │                                                       │          │
│   │  1. Generate new correlationId                       │          │
│   │     = access_communityId_wallet_resource_timestamp   │          │
│   │                                                       │          │
│   │  2. Fetch Member + Membership + Roles                │          │
│   │                                                       │          │
│   │  3. Capture State Snapshots                          │          │
│   │     membershipStateSnapshot = {                      │          │
│   │       id, tokenId, state, expiresAt, effectiveState  │          │
│   │     }                                                 │          │
│   │     roleStateSnapshot = [                            │          │
│   │       { id, role, source, active, expiresAt }, ...   │          │
│   │     ]                                                 │          │
│   │                                                       │          │
│   │  4. Evaluate Policy                                  │          │
│   │     decision = policyEngine.evaluate(...)            │          │
│   │                                                       │          │
│   │  5. Create AuditEvent                                │          │
│   │     + correlationId                                  │          │
│   │     + decision (ALLOW/DENY)                          │          │
│   │     + membershipStateVersion (JSON)                  │          │
│   │     + roleStateVersion (JSON)                        │          │
│   │                                                       │          │
│   │  6. Create OutboxEvent                               │          │
│   │     + correlationId                                  │          │
│   │     + decision payload                               │          │
│   │                                                       │          │
│   │  7. Return Decision                                  │          │
│   └──────────────────────────────────────────────────────┘          │
│                                                                      │
│   Response: { allowed: true, code: "ALLOW", ... }                   │
└──────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        ADMIN QUERY LAYER                             │
│                                                                      │
│   GET /admin/audit/trace/:correlationId                              │
│   ┌──────────────────────────────────────────────────────┐          │
│   │  auditTraceService.getAuditTraceByCorrelationId()    │          │
│   │                                                       │          │
│   │  1. Query AuditEvents WHERE correlationId = X        │          │
│   │                                                       │          │
│   │  2. Query OutboxEvents WHERE correlationId = X       │          │
│   │                                                       │          │
│   │  3. Extract Originating On-Chain Event               │          │
│   │     - Find first event with txHash/blockNumber       │          │
│   │                                                       │          │
│   │  4. Reconstruct Complete Trace                       │          │
│   │     {                                                 │          │
│   │       correlationId,                                 │          │
│   │       originatingOnChainEvent: {                     │          │
│   │         chainId, txHash, blockNumber, logIndex       │          │
│   │       },                                              │          │
│   │       databaseMutations: [...],                      │          │
│   │       outboxEvents: [...],                           │          │
│   │       accessDecisions: [{                            │          │
│   │         decision,                                     │          │
│   │         membershipState: JSON.parse(...),            │          │
│   │         roleState: JSON.parse(...)                   │          │
│   │       }],                                             │          │
│   │       summary: { ... }                               │          │
│   │     }                                                 │          │
│   │                                                       │          │
│   │  5. Return Complete Chain of Custody                 │          │
│   └──────────────────────────────────────────────────────┘          │
└──────────────────────────────────────────────────────────────────────┘
```

## Correlation ID Flow

```
┌────────────────────────────────────────────────────────────────────┐
│ Blockchain Event Processing                                         │
└────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │ Generate CorrelationID│
                    │ txHash_logIdx_time   │
                    └──────────┬───────────┘
                               │
            ┌──────────────────┼──────────────────┐
            │                  │                  │
            ▼                  ▼                  ▼
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │ AuditEvent   │  │ OutboxEvent  │  │ Membership   │
    │ correlationId│  │ correlationId│  │ (no ID)      │
    │ = ABC-1      │  │ = ABC-1      │  │              │
    └──────────────┘  └──────────────┘  └──────────────┘

┌────────────────────────────────────────────────────────────────────┐
│ Access Check Processing                                            │
└────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │ Generate CorrelationID│
                    │ access_comm_wallet_  │
                    │ resource_time        │
                    └──────────┬───────────┘
                               │
                    ┌──────────┼──────────┐
                    │          │          │
                    ▼          ▼          ▼
            ┌──────────────┐  ┌──────────────┐
            │ AuditEvent   │  │ OutboxEvent  │
            │ correlationId│  │ correlationId│
            │ = XYZ-2      │  │ = XYZ-2      │
            │ + membership │  │              │
            │   snapshot   │  │              │
            │ + role       │  │              │
            │   snapshot   │  │              │
            └──────────────┘  └──────────────┘

┌────────────────────────────────────────────────────────────────────┐
│ Query Reconstruction                                               │
└────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
               ┌───────────────────────────────┐
               │ Query by CorrelationId        │
               │ /admin/audit/trace/ABC-1      │
               └───────────────┬───────────────┘
                               │
                ┌──────────────┼──────────────┐
                │              │              │
                ▼              ▼              ▼
    ┌──────────────────┐ ┌─────────────┐ ┌──────────────┐
    │ Find all         │ │ Find all    │ │ Link to      │
    │ AuditEvents      │ │ OutboxEvents│ │ originating  │
    │ WHERE            │ │ WHERE       │ │ blockchain   │
    │ correlationId    │ │ correlationId│ │ transaction  │
    │ = ABC-1          │ │ = ABC-1     │ │ via txHash   │
    └──────────────────┘ └─────────────┘ └──────────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │ Reconstruct Timeline │
                    │                      │
                    │ 1. On-chain event    │
                    │ 2. DB mutations      │
                    │ 3. Outbox events     │
                    │ 4. Access decisions  │
                    └──────────────────────┘
```

## State Snapshot Capture

```
┌─────────────────────────────────────────────────────────────────┐
│ Access Check Time                                               │
│                                                                 │
│  Current Database State:                                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Membership                                                │  │
│  │ ├─ id: "mem-123"                                          │  │
│  │ ├─ tokenId: 456                                           │  │
│  │ ├─ state: "active"                                        │  │
│  │ ├─ expiresAt: "2026-08-01"                                │  │
│  │ └─ effectiveState: "active" (computed)                    │  │
│  │                                                            │  │
│  │ Roles: [                                                  │  │
│  │   { id: "role-1", role: "member", active: true },         │  │
│  │   { id: "role-2", role: "contributor", active: true }     │  │
│  │ ]                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                          │                                      │
│                          │ JSON.stringify()                     │
│                          ▼                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ AuditEvent.membershipStateVersion                         │  │
│  │ {                                                          │  │
│  │   "id": "mem-123",                                         │  │
│  │   "tokenId": 456,                                          │  │
│  │   "state": "active",                                       │  │
│  │   "expiresAt": "2026-08-01T00:00:00.000Z",                 │  │
│  │   "effectiveState": "active"                               │  │
│  │ }                                                           │  │
│  │                                                             │  │
│  │ AuditEvent.roleStateVersion                                │  │
│  │ [                                                           │  │
│  │   {                                                         │  │
│  │     "id": "role-1",                                         │  │
│  │     "role": "member",                                       │  │
│  │     "source": "auto",                                       │  │
│  │     "active": true,                                         │  │
│  │     "expiresAt": null                                       │  │
│  │   },                                                        │  │
│  │   {                                                         │  │
│  │     "id": "role-2",                                         │  │
│  │     "role": "contributor",                                  │  │
│  │     "source": "manual",                                     │  │
│  │     "active": true,                                         │  │
│  │     "expiresAt": null                                       │  │
│  │   }                                                         │  │
│  │ ]                                                           │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Future Query:                                                  │
│  GET /admin/audit/trace/:correlationId                          │
│  → JSON.parse(membershipStateVersion)                           │
│  → Exact state at decision time!                                │
└─────────────────────────────────────────────────────────────────┘
```

## Append-Only Enforcement

```
┌────────────────────────────────────────────────────────────────┐
│ Application Layer (TypeScript)                                 │
│                                                                 │
│  ✅ Only .create() operations exposed                           │
│  ❌ No .update() operations in auditService                     │
│  ❌ No .delete() operations in auditService                     │
│                                                                 │
│  export async function logEvent(event: AuditEventInput) {      │
│    return prisma.auditEvent.create({ data: event });           │
│    // No update() or delete() methods exist                    │
│  }                                                              │
└────────────────────────────────────────────────────────────────┘
                               ▼
┌────────────────────────────────────────────────────────────────┐
│ API Layer (Fastify Routes)                                     │
│                                                                 │
│  ✅ Only GET endpoints for audit queries                        │
│  ❌ No PUT/PATCH/DELETE endpoints for audit tables             │
│                                                                 │
│  GET /admin/audit/trace/:id      ← Read only                   │
│  GET /admin/audit/trace/tx/:hash ← Read only                   │
│  GET /admin/audit/trace/wallet/:w← Read only                   │
└────────────────────────────────────────────────────────────────┘
                               ▼
┌────────────────────────────────────────────────────────────────┐
│ Database Layer (PostgreSQL)                                    │
│                                                                 │
│  ⚠️ Physical enforcement possible via:                          │
│    - REVOKE UPDATE, DELETE on AuditEvent table                 │
│    - GRANT SELECT, INSERT only                                 │
│    - Database triggers to block modifications                  │
│    - Read replica for audit queries                            │
│                                                                 │
│  (Not implemented yet - TODO for production hardening)         │
└────────────────────────────────────────────────────────────────┘
```

## Query Index Usage

```
┌─────────────────────────────────────────────────────────────┐
│ Query: GET /admin/audit/trace/:correlationId                │
└─────────────────────────────────────────────────────────────┘
                        │
                        ▼
    SELECT * FROM "AuditEvent"
    WHERE correlationId = 'ABC-1'
                        │
                        ▼ (Uses Index)
    ┌──────────────────────────────────┐
    │ Index: AuditEvent_correlationId  │
    │ Type: B-tree                     │
    │ Performance: O(log n)            │
    └──────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Query: GET /admin/audit/trace/tx/:txHash                    │
└─────────────────────────────────────────────────────────────┘
                        │
                        ▼
    SELECT DISTINCT correlationId FROM "AuditEvent"
    WHERE txHash = '0xabc...'
                        │
                        ▼ (Uses Index)
    ┌──────────────────────────────────┐
    │ Index: AuditEvent_txHash         │
    │ Type: B-tree                     │
    │ Performance: O(log n)            │
    └──────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Query: GET /admin/audit/trace/wallet/:wallet               │
└─────────────────────────────────────────────────────────────┘
                        │
                        ▼
    SELECT DISTINCT correlationId FROM "AuditEvent"
    WHERE walletId = '0xalice...'
      AND communityId = 'guild-dev'
    ORDER BY createdAt DESC
    LIMIT 50
                        │
                        ▼ (Uses Indexes)
    ┌──────────────────────────────────┐
    │ Index: AuditEvent_walletId       │
    │ Index: AuditEvent_communityId    │
    │ Index: AuditEvent_createdAt      │
    │ Type: Composite index scan       │
    │ Performance: O(log n) + sort     │
    └──────────────────────────────────┘
```

## Summary

This architecture provides:

1. **Complete Traceability**: Every access decision traces back to blockchain origin
2. **State Reproducibility**: Exact membership/role state captured at decision time
3. **Tamper Evidence**: Append-only design enforced at application layer
4. **Efficient Queries**: B-tree indexes for fast lookups
5. **Correlation Tracking**: Unique IDs link related events across tables
6. **Atomic Operations**: Transactions ensure consistency
7. **Verifiable Chain**: On-chain metadata provides cryptographic anchor
