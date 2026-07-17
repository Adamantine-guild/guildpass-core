# Audit Chain of Custody - Quick Reference

## API Endpoints

### Query by Correlation ID
```bash
GET /admin/audit/trace/:correlationId
```

**Example:**
```bash
curl http://localhost:3000/admin/audit/trace/access_community-1_0xalice_dashboard_1234567890
```

**Response:**
```json
{
  "correlationId": "access_community-1_0xalice_dashboard_1234567890",
  "originatingOnChainEvent": {
    "chainId": 1,
    "txHash": "0xabcd...",
    "blockNumber": 12345678,
    "logIndex": 5
  },
  "databaseMutations": [...],
  "outboxEvents": [...],
  "accessDecisions": [
    {
      "decision": "ALLOW",
      "resource": "dashboard",
      "membershipState": {...},
      "roleState": [...]
    }
  ],
  "summary": {
    "totalEvents": 3,
    "hasOnChainOrigin": true,
    "eventTypes": ["MEMBERSHIP_CREATED", "ACCESS_CHECK"]
  }
}
```

### Query by Transaction Hash
```bash
GET /admin/audit/trace/tx/:txHash
```

**Example:**
```bash
curl http://localhost:3000/admin/audit/trace/tx/0xabcdef1234567890...
```

**Response:**
```json
{
  "txHash": "0xabcdef1234567890...",
  "traces": [
    { /* complete trace 1 */ },
    { /* complete trace 2 */ }
  ],
  "count": 2
}
```

### Query by Wallet
```bash
GET /admin/audit/trace/wallet/:wallet?communityId=xxx&limit=50
```

**Example:**
```bash
curl "http://localhost:3000/admin/audit/trace/wallet/0xalice123...?communityId=community-1&limit=50"
```

**Response:**
```json
{
  "wallet": "0xalice123...",
  "communityId": "community-1",
  "traces": [
    { /* recent trace 1 */ },
    { /* recent trace 2 */ },
    ...
  ],
  "count": 15
}
```

## Database Schema Quick Reference

### AuditEvent

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Unique identifier |
| `eventType` | Enum | Type of event (ACCESS_CHECK, MEMBERSHIP_CREATED, etc.) |
| `correlationId` | String | Links related events |
| `chainId` | Int? | Blockchain network ID |
| `txHash` | String? | Transaction hash |
| `blockNumber` | Int? | Block number |
| `logIndex` | Int? | Event index in block |
| `walletId` | String? | Wallet address |
| `communityId` | String? | Community identifier |
| `resource` | String? | Resource being accessed |
| `decision` | String? | ALLOW or DENY |
| `membershipStateVersion` | String? | JSON snapshot of membership |
| `roleStateVersion` | String? | JSON snapshot of roles |
| `beforeState` | Json? | State before mutation |
| `afterState` | Json? | State after mutation |
| `createdAt` | DateTime | When event was logged |

**Indexes:**
- `correlationId` - For querying related events
- `txHash` - For querying by blockchain transaction
- `walletId` - For querying by user
- `communityId` - For querying by community

### OutboxEvent

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Unique identifier |
| `eventType` | String | Type of integration event |
| `correlationId` | String? | Links to audit events |
| `chainId` | Int? | Blockchain network ID |
| `txHash` | String? | Transaction hash |
| `blockNumber` | Int? | Block number |
| `logIndex` | Int? | Event index in block |
| `entityId` | String? | ID of affected entity |
| `entityType` | String? | Type of entity |
| `communityId` | String? | Community identifier |
| `payload` | Json | Event payload |
| `status` | Enum | pending/delivered/failed |
| `createdAt` | DateTime | When event was created |
| `deliveredAt` | DateTime? | When event was delivered |

## Code Examples

### Applying Contract Event with Metadata

```typescript
import { applyContractEvent, DecodedMembershipMintedEvent } from './services/contractEventHelpers';

const mintEvent: DecodedMembershipMintedEvent = {
  type: 'MembershipMinted',
  to: '0xalice...',
  tokenId: 123,
  communityId: 'community-1',
  expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  // Blockchain metadata
  chainId: 1,
  txHash: '0xabcd...',
  blockNumber: 12345678,
  logIndex: 5,
};

await applyContractEvent(prisma, mintEvent);
// Creates: Membership, AuditEvent, OutboxEvent with full metadata
```

### Querying Audit Trace

```typescript
import { getAuditTraceByCorrelationId } from './services/auditTraceService';

const trace = await getAuditTraceByCorrelationId('correlation-id-here');

if (trace) {
  console.log('Originating Event:', trace.originatingOnChainEvent);
  console.log('Database Mutations:', trace.databaseMutations.length);
  console.log('Access Decisions:', trace.accessDecisions.length);
  console.log('Has On-Chain Origin:', trace.summary.hasOnChainOrigin);
}
```

### Logging Access Decision with State Snapshot

```typescript
import { logEvent } from './services/auditService';

await logEvent({
  eventType: 'ACCESS_CHECK',
  walletId: '0xalice...',
  communityId: 'community-1',
  resource: 'dashboard',
  decision: 'ALLOW',
  reasonCode: 'HAS_ACTIVE_MEMBERSHIP',
  correlationId: 'access_community-1_0xalice_dashboard_1234567890',
  membershipStateVersion: JSON.stringify({
    id: 'mem-123',
    tokenId: 42,
    state: 'active',
    expiresAt: '2024-02-15T00:00:00Z',
    effectiveState: 'active',
  }),
  roleStateVersion: JSON.stringify([
    {
      id: 'role-456',
      role: 'admin',
      source: 'manual',
      active: true,
    },
  ]),
});
```

## Correlation ID Patterns

### On-Chain Event Correlation IDs

Format: `{txHash}_{logIndex}_{timestamp}`

Example: `0xabcd1234_5_1234567890`

**Used for:**
- Membership minted events
- Membership renewed events
- Membership suspended events

### Access Check Correlation IDs

Format: `access_{communityId}_{wallet}_{resource}_{timestamp}`

Example: `access_community-1_0xalice_dashboard_1234567890`

**Used for:**
- Access check decisions
- Policy evaluations

## Common Queries

### Find all events from a blockchain transaction

```typescript
const traces = await getAuditTracesByTxHash('0xabcd...');
traces.forEach(trace => {
  console.log('Correlation ID:', trace.correlationId);
  console.log('Events:', trace.summary.eventTypes);
});
```

### Find recent activity for a wallet

```typescript
const traces = await getAuditTracesByWallet(
  '0xalice...',
  'community-1',
  50 // limit
);
```

### Verify access decision state

```typescript
const trace = await getAuditTraceByCorrelationId(correlationId);
const decision = trace.accessDecisions[0];

console.log('Decision:', decision.decision);
console.log('Membership State:', decision.membershipState);
console.log('Role State:', decision.roleState);
```

## Testing

### Run Integration Tests

```bash
cd apps/access-api
npm test -- membership-integration.test.ts
```

### Key Test Scenarios

1. **Complete Audit Trail**: Mint event → Access decision → Query trace
2. **Append-Only Integrity**: Verify idempotency
3. **Multiple Decisions**: Multiple access checks from same origin
4. **Transaction Query**: Find all traces by txHash
5. **Wallet Query**: Find all traces for wallet

## Troubleshooting

### Missing Blockchain Metadata

**Problem:** AuditEvent has null chainId/txHash/blockNumber

**Solution:** Ensure contract events include full metadata:
```typescript
const event: DecodedMembershipMintedEvent = {
  type: 'MembershipMinted',
  // ... other fields
  chainId: 1,          // Required
  txHash: '0x...',     // Required
  blockNumber: 123456, // Required
  logIndex: 5,         // Required
};
```

### Missing State Snapshots

**Problem:** Access decision has null membershipStateVersion

**Solution:** Ensure checkAccess() captures state before logging:
```typescript
const membershipStateSnapshot = member.membership ? {
  id: member.membership.id,
  tokenId: member.membership.tokenId,
  state: member.membership.state,
  expiresAt: member.membership.expiresAt?.toISOString(),
  effectiveState,
} : null;

await auditAccess({
  // ... other fields
  membershipState: membershipStateSnapshot,
  roleState: roleStateSnapshot,
});
```

### Trace Not Found

**Problem:** GET /admin/audit/trace/:correlationId returns 404

**Possible causes:**
1. Correlation ID is incorrect
2. Event hasn't been logged yet
3. Database not synced

**Solution:**
```bash
# Check if audit event exists
SELECT * FROM "AuditEvent" WHERE "correlationId" = 'your-correlation-id';

# Check if correlation ID format is correct
# On-chain: txHash_logIndex_timestamp
# Access: access_communityId_wallet_resource_timestamp
```

## Performance Considerations

### Indexing Strategy

The schema includes indexes on:
- `correlationId` - Fast correlation queries
- `txHash` - Fast transaction queries
- `walletId` - Fast wallet queries
- `communityId` - Fast community queries

### Query Optimization

For large datasets:
1. Always specify `communityId` when querying by wallet
2. Use `limit` parameter to restrict result size
3. Consider pagination for API consumers
4. Index `createdAt` for time-range queries

### Retention Policy

Consider implementing retention policies:
```sql
-- Example: Delete audit events older than 1 year
DELETE FROM "AuditEvent"
WHERE "createdAt" < NOW() - INTERVAL '1 year'
  AND "eventType" != 'ACCESS_CHECK'; -- Keep access checks longer
```

## Security Checklist

- [ ] Add admin authentication to audit endpoints
- [ ] Implement rate limiting on trace queries
- [ ] Log all admin audit queries
- [ ] Encrypt sensitive fields at rest
- [ ] Implement retention policies
- [ ] Add alerting for suspicious query patterns
- [ ] Review audit logs regularly
- [ ] Document data access policies

## Resources

- Full documentation: `AUDIT_CHAIN_OF_CUSTODY.md`
- Implementation details: `IMPLEMENTATION_SUMMARY.md`
- Architecture diagrams: `AUDIT_ARCHITECTURE.md`
- Integration tests: `membership-integration.test.ts`
