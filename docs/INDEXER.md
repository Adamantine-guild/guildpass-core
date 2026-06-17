# MembershipNFT Event Indexer

## Overview

The indexer is a worker service that synchronizes on-chain membership state from the `MembershipNFT` smart contract into the GuildPass access API database. It processes blockchain events and maintains an up-to-date view of membership data for access control decisions.

## Architecture

```
┌─────────────────────┐
│   EVM Blockchain    │
│  (MembershipNFT)    │
└──────────┬──────────┘
           │ Events:
           │ - MembershipMinted
           │ - MembershipRenewed
           │ - MembershipSuspended
           ↓
┌─────────────────────┐
│   Event Indexer     │
│  (Worker Process)   │
└──────────┬──────────┘
           │ Decoded
           │ Events
           ↓
┌─────────────────────┐
│  PostgreSQL DB      │
│  (Access API)       │
└─────────────────────┘
```

## Features

### Event Processing
- **MembershipMinted**: Creates wallet, community, member, and membership records
- **MembershipRenewed**: Updates membership expiry and renewal timestamps
- **MembershipSuspended**: Updates membership suspension state

### Checkpoint Management
- Persists the last processed block number to `IndexerCheckpoint` table
- Enables resuming from the last checkpoint on subsequent runs
- Prevents duplicate event processing

### Idempotency
- All database operations use `upsert` patterns
- Safe to re-run without creating duplicate records
- Handles out-of-order events gracefully

### Batch Processing
- Processes events in configurable batch sizes (default: 1000 blocks)
- Avoids RPC rate limits
- Updates checkpoint after each successful batch

### Graceful Shutdown
- Responds to `SIGTERM` and `SIGINT` signals
- Completes current batch before exiting
- Closes database connections cleanly

## Configuration

### Environment Variables

Add the following to your `.env` file:

```bash
# RPC endpoint for the blockchain network
RPC_URL="http://localhost:8545"

# Chain ID of the network
CHAIN_ID=31337

# Deployed MembershipNFT contract address
MEMBERSHIP_NFT_ADDRESS="0x1234567890123456789012345678901234567890"

# Starting block for indexing (default: 0)
INDEXER_START_BLOCK=0

# Number of blocks to process per batch (default: 1000)
INDEXER_BATCH_SIZE=1000
```

### Database Schema

The indexer requires the following tables (already in the Prisma schema):

```prisma
model IndexerCheckpoint {
  id              String   @id @default(cuid())
  chainId         Int
  contractAddress String
  lastBlock       BigInt
  lastBlockHash   String?
  updatedAt       DateTime @default(now()) @updatedAt
  @@unique([chainId, contractAddress])
}

model Wallet {
  id        String   @id @default(cuid())
  address   String   @unique
  members   Member[]
  createdAt DateTime @default(now())
}

model Member {
  id          String   @id @default(cuid())
  communityId String
  walletId    String
  profileId   String?
  community   Community @relation(fields: [communityId], references: [id])
  wallet      Wallet    @relation(fields: [walletId], references: [id])
  profile     Profile?  @relation(fields: [profileId], references: [id])
  membership  Membership?
  roles       RoleAssignment[]
  badges      Badge[]
  @@unique([communityId, walletId])
}

model Membership {
  id         String          @id @default(cuid())
  memberId   String          @unique
  tokenId    Int?            @unique
  state      MembershipState
  expiresAt  DateTime?
  renewedAt  DateTime?
  createdAt  DateTime        @default(now())
  member     Member          @relation(fields: [memberId], references: [id])
}
```

## Usage

### Running Manually

Process events from the last checkpoint to the current block:

```bash
# Using npm
npm run indexer

# Using pnpm
pnpm --filter access-api indexer

# Direct execution
ts-node apps/access-api/src/workers/indexer.ts
```

### Scheduling with Cron

For periodic synchronization, schedule the indexer with cron:

```bash
# Run every 5 minutes
*/5 * * * * cd /path/to/guildpass-core && npm run indexer >> /var/log/indexer.log 2>&1

# Run every hour
0 * * * * cd /path/to/guildpass-core && npm run indexer >> /var/log/indexer.log 2>&1
```

### Docker / Kubernetes

Example Kubernetes CronJob:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: membership-indexer
spec:
  schedule: "*/5 * * * *"  # Every 5 minutes
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: indexer
            image: guildpass/access-api:latest
            command: ["npm", "run", "indexer"]
            env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: url
            - name: RPC_URL
              value: "https://mainnet.infura.io/v3/YOUR_KEY"
            - name: CHAIN_ID
              value: "1"
            - name: MEMBERSHIP_NFT_ADDRESS
              value: "0xYourContractAddress"
          restartPolicy: OnFailure
```

## Event Processing Details

### MembershipMinted

**Contract Event:**
```solidity
event MembershipMinted(
    address indexed to,
    uint256 indexed tokenId,
    string communityId,
    uint256 expiresAt
);
```

**Indexer Actions:**
1. Normalize wallet address to lowercase
2. Upsert `Wallet` record
3. Upsert `Community` record
4. Upsert `Member` record linking wallet and community
5. Determine membership state based on `expiresAt`:
   - `active` if `expiresAt > now`
   - `expired` if `expiresAt <= now`
6. Upsert `Membership` record with `tokenId`

**Example:**
```typescript
// Event: Alice minted token #1 for community-dev, expires in 30 days
{
  to: "0xalice...",
  tokenId: 1,
  communityId: "community-dev",
  expiresAt: 1735689600  // Unix timestamp
}

// Database State After Processing:
// Wallet: { address: "0xalice..." }
// Community: { id: "community-dev", name: "community-dev" }
// Member: { walletId: wallet.id, communityId: "community-dev" }
// Membership: { tokenId: 1, state: "active", expiresAt: "2025-01-01T00:00:00Z" }
```

### MembershipRenewed

**Contract Event:**
```solidity
event MembershipRenewed(
    uint256 indexed tokenId,
    uint256 newExpiresAt
);
```

**Indexer Actions:**
1. Find existing `Membership` by `tokenId`
2. Update `expiresAt` to `newExpiresAt`
3. Update `renewedAt` to current timestamp
4. Update state:
   - `active` if `newExpiresAt > now`
   - `expired` if `newExpiresAt <= now`

**Example:**
```typescript
// Event: Token #1 renewed with new expiry
{
  tokenId: 1,
  newExpiresAt: 1740873600  // 60 days from now
}

// Database Update:
// Membership: {
//   tokenId: 1,
//   expiresAt: "2025-03-01T00:00:00Z",
//   renewedAt: "2025-01-01T00:00:00Z",
//   state: "active"
// }
```

### MembershipSuspended

**Contract Event:**
```solidity
event MembershipSuspended(
    uint256 indexed tokenId,
    bool isSuspended
);
```

**Indexer Actions:**
1. Find existing `Membership` by `tokenId`
2. If `isSuspended == true`:
   - Set state to `suspended`
3. If `isSuspended == false`:
   - Check if `expiresAt > now`
   - Set state to `active` if not expired, else `expired`

**Example:**
```typescript
// Event: Token #1 suspended
{
  tokenId: 1,
  isSuspended: true
}

// Database Update:
// Membership: { tokenId: 1, state: "suspended" }

// Later Event: Token #1 unsuspended
{
  tokenId: 1,
  isSuspended: false
}

// Database Update:
// Membership: { tokenId: 1, state: "active" } // or "expired" if past expiresAt
```

## Error Handling

### RPC Errors
- Logs error with context (block range, RPC endpoint)
- Does not update checkpoint
- Allows retry on next run

### Database Errors
- Logs error with context (event type, block number, transaction hash)
- Throws error to stop processing
- Does not update checkpoint for failed batch
- Transaction rollback ensures data consistency

### Missing Token Errors
- `MembershipRenewed` or `MembershipSuspended` for non-existent `tokenId`
- Logs warning with context
- Continues processing (assumes out-of-order events or incomplete history)

### Shutdown Handling
- Sets `shouldStop` flag on SIGTERM/SIGINT
- Completes current batch
- Updates checkpoint
- Closes database connection
- Exits with code 0

## Monitoring

### Logs

The indexer emits structured JSON logs using Pino:

```json
{
  "level": "info",
  "time": 1735689600000,
  "msg": "Starting MembershipNFT indexer",
  "config": {
    "rpcUrl": "http://localhost:8545",
    "chainId": 31337,
    "contractAddress": "0x1234...",
    "startBlock": 0,
    "batchSize": 1000
  }
}

{
  "level": "info",
  "time": 1735689601000,
  "msg": "Processing block range",
  "fromBlock": 0,
  "toBlock": 999
}

{
  "level": "info",
  "time": 1735689602000,
  "msg": "Fetched events",
  "minted": 45,
  "renewed": 12,
  "suspended": 3
}

{
  "level": "info",
  "time": 1735689603000,
  "msg": "MembershipMinted processed",
  "tokenId": 1,
  "communityId": "community-dev",
  "blockNumber": 123
}

{
  "level": "info",
  "time": 1735689604000,
  "msg": "Checkpoint saved",
  "blockNumber": 999,
  "blockHash": "0xabc..."
}
```

### Metrics (Future Enhancement)

Potential metrics to expose:

- `indexer_blocks_processed_total`: Total blocks processed
- `indexer_events_processed_total{event_type}`: Events by type
- `indexer_last_processed_block`: Current checkpoint block
- `indexer_processing_duration_seconds`: Time per batch
- `indexer_errors_total{error_type}`: Errors by type

## Testing

### Unit Tests

```bash
# Run indexer tests
npm test -- indexer.test.ts
```

Tests cover:
- Configuration loading
- Event processing logic
- Checkpoint management
- Idempotency guarantees
- Error handling
- Graceful shutdown

### Integration Tests

To test against a local blockchain:

1. Start a local Hardhat or Anvil node
2. Deploy the MembershipNFT contract
3. Mint test memberships
4. Run the indexer
5. Verify database state

```bash
# Start local node
anvil

# Deploy contract (in another terminal)
forge script contracts/script/Deploy.s.sol --rpc-url http://localhost:8545 --broadcast

# Set environment variables
export MEMBERSHIP_NFT_ADDRESS="<deployed_address>"
export RPC_URL="http://localhost:8545"
export CHAIN_ID=31337

# Run indexer
npm run indexer

# Verify database
psql $DATABASE_URL -c "SELECT * FROM \"Membership\";"
```

## Troubleshooting

### Issue: Indexer doesn't process any events

**Possible Causes:**
- No events emitted by contract
- Wrong `MEMBERSHIP_NFT_ADDRESS`
- Wrong `CHAIN_ID`
- RPC node not synced

**Solutions:**
1. Verify contract address: `cast code $MEMBERSHIP_NFT_ADDRESS --rpc-url $RPC_URL`
2. Check events: `cast logs --from-block 0 --address $MEMBERSHIP_NFT_ADDRESS --rpc-url $RPC_URL`
3. Verify chain ID: `cast chain-id --rpc-url $RPC_URL`

### Issue: Indexer is slow

**Possible Causes:**
- Large block range
- Small batch size
- Slow RPC endpoint
- Network latency

**Solutions:**
1. Increase `INDEXER_BATCH_SIZE` (e.g., 5000)
2. Use a local or faster RPC endpoint
3. Run indexer on a server close to the RPC provider

### Issue: Database constraint violation

**Possible Causes:**
- Schema out of sync
- Manual database changes
- Corrupted checkpoint

**Solutions:**
1. Regenerate Prisma client: `npm run -w access-api prisma:generate`
2. Run migrations: `npm run -w access-api prisma:migrate`
3. Inspect conflicting records: `psql $DATABASE_URL`
4. Reset checkpoint if corrupted: `DELETE FROM "IndexerCheckpoint" WHERE ...`

### Issue: Indexer stops unexpectedly

**Possible Causes:**
- RPC rate limit
- Database connection lost
- Out of memory

**Solutions:**
1. Check logs for errors
2. Reduce batch size
3. Use a paid RPC plan with higher rate limits
4. Increase worker memory allocation
5. Add retry logic with exponential backoff

## Future Enhancements

### Continuous Mode
Add a watch mode that polls for new blocks continuously:

```typescript
// In indexer.ts
async watch() {
  while (!this.shouldStop) {
    await this.run();
    await new Promise(resolve => setTimeout(resolve, 10000)); // Poll every 10s
  }
}
```

### Parallel Processing
Process multiple block ranges in parallel:

```typescript
const ranges = chunkBlockRange(fromBlock, toBlock, PARALLEL_WORKERS);
await Promise.all(ranges.map(range => this.processBatch(range.from, range.to)));
```

### Event Webhooks
Emit webhooks when important events are processed:

```typescript
if (membership.state === 'active') {
  await sendWebhook('membership.activated', { tokenId, wallet, communityId });
}
```

### Reorganization Handling
Handle chain reorganizations by:
1. Storing block hashes in checkpoint
2. Detecting reorgs on next run
3. Rolling back affected events
4. Reprocessing from before the reorg

## License

MIT
