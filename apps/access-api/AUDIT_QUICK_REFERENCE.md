# Audit Chain of Custody - Quick Reference

## For Developers

### Query Complete Audit Trail

```typescript
// By correlation ID (from an audit event or access check)
GET /admin/audit/trace/:correlationId

// Example Response:
{
  "correlationId": "0xabc...def_5_1721189760000",
  "originatingOnChainEvent": {
    "chainId": 1,
    "txHash": "0xabc...def",
    "blockNumber": 12345678,
    "logIndex": 5
  },
  "databaseMutations": [
    {
      "id": "uuid",
      "eventType": "MEMBERSHIP_CREATED",
      "walletId": "0xalice...",
      "communityId": "guild-dev",
      "beforeState": null,
      "afterState": { "tokenId": 123, "state": "active" },
      "createdAt": "2026-07-17T00:00:00.000Z",
      "onChainEvent": { /* metadata */ }
    }
  ],
  "outboxEvents": [ /* ... */ ],
  "accessDecisions": [
    {
      "decision": "ALLOW",
      "resource": "dashboard",
      "membershipState": { /* snapshot */ },
      "roleState": [ /* snapshot */ ]
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

```typescript
// Find all audit trails for a specific blockchain transaction
GET /admin/audit/trace/tx/:txHash

// Example: GET /admin/audit/trace/tx/0xabc...def
{
  "txHash": "0xabc...def",
  "traces": [ /* array of complete traces */ ],
  "count": 2
}
```

### Query by Wallet

```typescript
// Get recent audit trails for a wallet in a community
GET /admin/audit/trace/wallet/:wallet?communityId=guild-dev&limit=50

// Example: GET /admin/audit/trace/wallet/0xalice...?communityId=guild-dev
{
  "wallet": "0xalice...",
  "communityId": "guild-dev",
  "traces": [ /* array of traces */ ],
  "count": 5
}
```

## For Operations

### Investigating an Access Denial

1. **Get correlation ID from logs:**
   ```
   Look for: "Access denied for wallet 0xalice..."
   Extract: correlationId from the log entry
   ```

2. **Query audit trail:**
   ```bash
   curl http://api/admin/audit/trace/{correlationId}
   ```

3. **Examine decision:**
   ```json
   {
     "accessDecisions": [{
       "decision": "DENY",
       "reasonCode": "MEMBERSHIP_EXPIRED",
       "membershipState": {
         "state": "active",
         "expiresAt": "2026-06-01T00:00:00.000Z",
         "effectiveState": "expired"
       }
     }]
   }
   ```

### Tracing a Blockchain Event

1. **Get transaction hash from blockchain explorer**

2. **Query audit trail:**
   ```bash
   curl http://api/admin/audit/trace/tx/0xabc...def
   ```

3. **Verify processing:**
   - Check `originatingOnChainEvent` has correct metadata
   - Check `databaseMutations` shows state changes
   - Check `outboxEvents` for downstream integrations

### Auditing a User's Activity

```bash
# Get last 50 audit events for a wallet
curl "http://api/admin/audit/trace/wallet/0xalice...?communityId=guild-dev&limit=50"

# Examine each trace to see:
# - What on-chain events affected this wallet
# - What state changes occurred
# - What access decisions were made
```

## Key Concepts

### Correlation ID
- **Format:** `{txHash}_{logIndex}_{timestamp}` or `access_{communityId}_{wallet}_{resource}_{timestamp}`
- **Purpose:** Links all events in a single logical operation
- **Scope:** One correlation ID per blockchain event processing or access check

### On-Chain Event Metadata
- **chainId:** Ethereum mainnet = 1, Polygon = 137, etc.
- **txHash:** Unique transaction identifier
- **blockNumber:** Block height
- **logIndex:** Event index within transaction

### State Snapshots
- **membershipStateVersion:** JSON of membership at decision time
- **roleStateVersion:** JSON array of roles at decision time
- **Purpose:** Reproduce exact decision-making context

## Common Queries

### "Why was this access denied?"

```sql
-- Find the access check audit event
SELECT * FROM "AuditEvent"
WHERE eventType = 'ACCESS_CHECK'
  AND walletId = '0xalice...'
  AND decision = 'DENY'
ORDER BY createdAt DESC
LIMIT 1;

-- Then query the API with the correlationId
```

### "What blockchain event created this membership?"

```sql
-- Find membership creation audit event
SELECT * FROM "AuditEvent"
WHERE eventType = 'MEMBERSHIP_CREATED'
  AND walletId = '0xalice...'
  AND txHash IS NOT NULL;
```

### "Show me all events from transaction X"

```sql
SELECT * FROM "AuditEvent"
WHERE txHash = '0xabc...def'
ORDER BY createdAt ASC;
```

## Troubleshooting

### Missing On-Chain Metadata

**Problem:** Old audit events don't have txHash/blockNumber
**Reason:** Events created before audit chain implementation
**Solution:** Only new events will have metadata (by design)

### Correlation ID Not Found

**Problem:** GET /admin/audit/trace/:correlationId returns 404
**Reason:** 
- Correlation ID doesn't exist
- Event processing failed
- Typo in correlation ID

**Solution:**
```bash
# Search by transaction hash instead
curl http://api/admin/audit/trace/tx/{txHash}

# Or search by wallet
curl "http://api/admin/audit/trace/wallet/{wallet}?communityId={communityId}"
```

### Multiple Traces for Same Event

**Problem:** Transaction has multiple correlation IDs
**Reason:** Normal - one txHash can affect multiple members
**Solution:** Each member gets their own correlation ID

## Testing

### Local Testing

```bash
# Run integration tests
cd apps/access-api
npm test -- membership-integration.test.ts

# Look for:
# ✓ should create complete audit trail from on-chain event to access decision
# ✓ should maintain append-only audit integrity
# ✓ should link multiple access decisions to same originating event
```

### Manual Testing

```bash
# 1. Process a mint event (via test or indexer)
# 2. Check audit event was created
curl http://api/admin/audit/trace/tx/0x{txHash}

# 3. Make an access check
curl -X POST http://api/v1/access/check \
  -H "Content-Type: application/json" \
  -d '{"wallet":"0xalice...","communityId":"guild-dev","resource":"dashboard"}'

# 4. Get correlation ID from response or database
# 5. Query full trace
curl http://api/admin/audit/trace/{correlationId}
```

## Performance Notes

- Correlation ID queries: Fast (indexed)
- Transaction hash queries: Fast (indexed)
- Wallet queries: Limited to 50 by default
- State snapshots: Stored as JSON, parsed on read

## Security Notes

⚠️ **Admin endpoints are currently unprotected**

Before production:
1. Add authentication middleware
2. Restrict to internal network
3. Implement audit logging of audit queries
4. Set up rate limiting

## Schema Quick Reference

```typescript
// AuditEvent
{
  id: string;
  eventType: EventType;
  correlationId?: string;        // NEW: Links related events
  chainId?: number;              // NEW: Blockchain network
  txHash?: string;               // NEW: Transaction hash
  blockNumber?: number;          // NEW: Block height
  logIndex?: number;             // NEW: Log position
  membershipStateVersion?: string; // NEW: Membership snapshot (JSON)
  roleStateVersion?: string;      // NEW: Roles snapshot (JSON)
  // ... other fields
}

// OutboxEvent
{
  id: string;
  eventType: string;
  correlationId?: string;        // NEW: Links to audit events
  chainId?: number;              // NEW: Blockchain network
  txHash?: string;               // NEW: Transaction hash
  blockNumber?: number;          // NEW: Block height
  logIndex?: number;             // NEW: Log position
  // ... other fields
}
```

## Migration Status

✅ Schema updated (prisma/schema.prisma)
✅ Migration created (20260717_add_audit_chain_of_custody)
⏳ Migration not yet applied (run: `npx prisma migrate deploy`)

## Support Resources

1. **Full Documentation:** AUDIT_CHAIN_OF_CUSTODY.md
2. **Implementation Details:** IMPLEMENTATION_SUMMARY.md
3. **Code Examples:** src/membership-integration.test.ts
4. **Service Code:** src/services/auditTraceService.ts
