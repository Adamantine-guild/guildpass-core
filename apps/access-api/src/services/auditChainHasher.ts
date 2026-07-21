import { keccak256 } from 'js-sha3';
import { PrismaClient, Prisma } from '@prisma/client';
import { getPrisma } from './prisma';
import { metrics } from '../observability/metrics';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * PostgreSQL advisory lock ID for serializing audit chain writes.
 * Derived from the string "GUILDPASS_AUDIT_CHAIN" truncated to fit a bigint.
 */
const AUDIT_CHAIN_LOCK_ID = 0x4155444954;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditChainRecord {
  id: string;
  eventType: string;
  walletId: string | null;
  communityId: string | null;
  resource: string | null;
  policyRule: string | null;
  decision: string | null;
  reasonCode: string | null;
  beforeState: any;
  afterState: any;
  correlationId: string | null;
  chainId: number | null;
  txHash: string | null;
  blockNumber: number | null;
  logIndex: number | null;
  membershipStateVersion: string | null;
  roleStateVersion: string | null;
  recordHash: string | null;
  previousRecordHash: string | null;
  createdAt: Date;
}

export interface ChainIntegrityResult {
  valid: boolean;
  totalRecords: number;
  verifiedRecords: number;
  skippedRecords: number;
  breaks: ChainBreak[];
  chainTipHash: string | null;
}

export interface ChainBreak {
  index: number;
  recordId: string;
  reason: string;
  expectedHash: string | null;
  actualHash: string | null;
}

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization with sorted keys.
 * Produces the same output for the same semantic content regardless of
 * key ordering in the input object.
 */
function canonicalize(value: any): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item));
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const pairs = keys.map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, any>)[key])}`);
    return `{${pairs.join(',')}}`;
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Hash computation
// ---------------------------------------------------------------------------

/**
 * Compute the record hash for an audit event.
 *
 * formula: recordHash = keccak256(canonicalize(contentFields) + previousRecordHash)
 *
 * The `+` is string concatenation: the hex-encoded previous hash (without 0x prefix)
 * is appended to the canonical JSON of the content fields, then keccak256 is applied
 * to the resulting UTF-8 string.
 *
 * @param fields - All content fields of the audit record (excluding id, createdAt, recordHash, previousRecordHash)
 * @param previousRecordHash - The hash of the previous record in the chain (null for first record)
 * @returns Hex-encoded keccak256 hash (without 0x prefix)
 */
export function computeRecordHash(
  fields: Record<string, any>,
  previousRecordHash: string | null,
): string {
  const content = canonicalize(fields);
  const previous = previousRecordHash ?? '';
  const input = content + previous;
  const hashBytes = keccak256(input);
  return hashBytes;
}

// ---------------------------------------------------------------------------
// Extract content fields from an audit record
// ---------------------------------------------------------------------------

/**
 * Extract content fields for hash computation from an audit record.
 * Excludes id (auto-generated), createdAt (DB-set), recordHash, and previousRecordHash.
 */
export function extractContentFields(record: {
  eventType: string;
  walletId?: string | null;
  communityId?: string | null;
  resource?: string | null;
  policyRule?: string | null;
  decision?: string | null;
  reasonCode?: string | null;
  beforeState?: any;
  afterState?: any;
  correlationId?: string | null;
  chainId?: number | null;
  txHash?: string | null;
  blockNumber?: number | null;
  logIndex?: number | null;
  membershipStateVersion?: string | null;
  roleStateVersion?: string | null;
}): Record<string, any> {
  const fields: Record<string, any> = {};
  fields.eventType = record.eventType;
  if (record.walletId != null) fields.walletId = record.walletId;
  if (record.communityId != null) fields.communityId = record.communityId;
  if (record.resource != null) fields.resource = record.resource;
  if (record.policyRule != null) fields.policyRule = record.policyRule;
  if (record.decision != null) fields.decision = record.decision;
  if (record.reasonCode != null) fields.reasonCode = record.reasonCode;
  if (record.beforeState != null) fields.beforeState = record.beforeState;
  if (record.afterState != null) fields.afterState = record.afterState;
  if (record.correlationId != null) fields.correlationId = record.correlationId;
  if (record.chainId != null) fields.chainId = record.chainId;
  if (record.txHash != null) fields.txHash = record.txHash;
  if (record.blockNumber != null) fields.blockNumber = record.blockNumber;
  if (record.logIndex != null) fields.logIndex = record.logIndex;
  if (record.membershipStateVersion != null) fields.membershipStateVersion = record.membershipStateVersion;
  if (record.roleStateVersion != null) fields.roleStateVersion = record.roleStateVersion;
  return fields;
}

// ---------------------------------------------------------------------------
// Chain-aware write (with advisory lock)
// ---------------------------------------------------------------------------

/**
 * Read the chain tip hash using a lock-free query.
 * Returns null if no audit records exist yet.
 *
 * WARNING: This is not safe for concurrent write scenarios on its own.
 * Use acquireAuditChainLock() + getChainTipHashLocked() for writes.
 */
export async function getChainTipHash(
  prisma: PrismaClient = getPrisma(),
): Promise<string | null> {
  const latest = await prisma.auditEvent.findFirst({
    where: { recordHash: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { recordHash: true },
  });
  return latest?.recordHash ?? null;
}

/**
 * Acquire a PostgreSQL advisory lock to serialize audit chain writes.
 * Must be called inside a Prisma $transaction callback.
 */
export async function acquireAuditChainLock(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_ID})`,
  );
}

/**
 * Get the chain tip hash while holding the advisory lock.
 * Must be called after acquireAuditChainLock() inside the same transaction.
 */
export async function getChainTipHashLocked(
  tx: Prisma.TransactionClient,
): Promise<string | null> {
  const latest = await tx.auditEvent.findFirst({
    where: { recordHash: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { recordHash: true },
  });
  return latest?.recordHash ?? null;
}

/**
 * Write an audit event with hash-chain integrity.
 *
 * This function:
 * 1. Acquires a PostgreSQL advisory lock to serialize writes
 * 2. Reads the current chain tip hash
 * 3. Computes the new record's hash
 * 4. Creates the record with both hashes
 *
 * Must be called inside a Prisma $transaction callback.
 */
export async function writeChainedAuditEvent(
  tx: Prisma.TransactionClient,
  data: {
    id?: string;
    eventType: string;
    walletId?: string | null;
    communityId?: string | null;
    resource?: string | null;
    policyRule?: string | null;
    decision?: string | null;
    reasonCode?: string | null;
    beforeState?: any;
    afterState?: any;
    correlationId?: string | null;
    chainId?: number | null;
    txHash?: string | null;
    blockNumber?: number | null;
    logIndex?: number | null;
    membershipStateVersion?: string | null;
    roleStateVersion?: string | null;
  },
): Promise<any> {
  const startTime = Date.now();

  await acquireAuditChainLock(tx);

  const previousRecordHash = await getChainTipHashLocked(tx);

  const contentFields = extractContentFields(data);
  const recordHash = computeRecordHash(contentFields, previousRecordHash);

  const result = await tx.auditEvent.create({
    data: {
      id: data.id,
      eventType: data.eventType,
      walletId: data.walletId ?? null,
      communityId: data.communityId ?? null,
      resource: data.resource ?? null,
      policyRule: data.policyRule ?? null,
      decision: data.decision ?? null,
      reasonCode: data.reasonCode ?? null,
      beforeState: data.beforeState ?? null,
      afterState: data.afterState ?? null,
      correlationId: data.correlationId ?? null,
      chainId: data.chainId ?? null,
      txHash: data.txHash ?? null,
      blockNumber: data.blockNumber ?? null,
      logIndex: data.logIndex ?? null,
      membershipStateVersion: data.membershipStateVersion ?? null,
      roleStateVersion: data.roleStateVersion ?? null,
      recordHash,
      previousRecordHash,
    },
  });

  metrics.auditChainWriteDuration.observe(
    {},
    (Date.now() - startTime) / 1000,
  );

  return result;
}

// ---------------------------------------------------------------------------
// Chain integrity verification
// ---------------------------------------------------------------------------

/**
 * Verify the integrity of the audit hash chain.
 *
 * Walks all audit records in chronological order and confirms that every
 * record with a recordHash satisfies:
 *   recordHash = keccak256(canonicalize(contentFields) + previousRecordHash)
 *
 * Also confirms the previousRecordHash matches the preceding record's hash.
 *
 * Records without recordHash (pre-migration) are counted as skipped and
 * do not trigger verification failures.
 *
 * @param prisma - PrismaClient instance
 * @param options - Optional range limits
 * @returns ChainIntegrityResult with any chain breaks found
 */
export async function verifyAuditChainIntegrity(
  prisma: PrismaClient = getPrisma(),
  options?: {
    fromDate?: Date;
    toDate?: Date;
    limit?: number;
  },
): Promise<ChainIntegrityResult> {
  const where: any = {};
  if (options?.fromDate || options?.toDate) {
    where.createdAt = {};
    if (options.fromDate) where.createdAt.gte = options.fromDate;
    if (options.toDate) where.createdAt.lte = options.toDate;
  }

  const records = await prisma.auditEvent.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    take: options?.limit,
  });

  const breaks: ChainBreak[] = [];
  let lastValidHash: string | null = null;
  let verifiedCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < records.length; i++) {
    const record = records[i] as AuditChainRecord;

    if (!record.recordHash) {
      skippedCount++;
      lastValidHash = null;
      continue;
    }

    // Check previousRecordHash links correctly
    if (lastValidHash === null) {
      if (record.previousRecordHash !== null) {
        breaks.push({
          index: i,
          recordId: record.id,
          reason: `First hashed record in chain should have null previousRecordHash, got ${record.previousRecordHash}`,
          expectedHash: null,
          actualHash: record.recordHash,
        });
        lastValidHash = null;
        continue;
      }
    } else {
      if (record.previousRecordHash !== lastValidHash) {
        breaks.push({
          index: i,
          recordId: record.id,
          reason: `previousRecordHash mismatch: expected ${lastValidHash}, got ${record.previousRecordHash}`,
          expectedHash: lastValidHash,
          actualHash: record.previousRecordHash,
        });
        lastValidHash = null;
        continue;
      }
    }

    // Verify the hash computation
    const contentFields = extractContentFields(record);
    const expectedHash = computeRecordHash(contentFields, record.previousRecordHash);

    if (record.recordHash !== expectedHash) {
      breaks.push({
        index: i,
        recordId: record.id,
        reason: `recordHash mismatch: expected ${expectedHash}, got ${record.recordHash}`,
        expectedHash,
        actualHash: record.recordHash,
      });
      lastValidHash = null;
    } else {
      lastValidHash = record.recordHash;
      verifiedCount++;
    }
  }

  return {
    valid: breaks.length === 0,
    totalRecords: records.length,
    verifiedRecords: verifiedCount,
    skippedRecords: skippedCount,
    breaks,
    chainTipHash: lastValidHash,
  };
}

// ---------------------------------------------------------------------------
// Backfill hashes for existing records (pre-migration)
// ---------------------------------------------------------------------------

/**
 * Backfill hashes for all audit records that don't have a recordHash yet.
 * Processes records in chronological order, building the chain.
 *
 * @param prisma - PrismaClient instance
 * @param batchSize - Number of records to process per batch (default: 100)
 * @returns Number of records backfilled
 */
export async function backfillAuditChain(
  prisma: PrismaClient = getPrisma(),
  batchSize: number = 100,
): Promise<number> {
  let backfilled = 0;
  let lastHash: string | null = null;

  const records = await prisma.auditEvent.findMany({
    where: { recordHash: null },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
  });

  for (const record of records) {
    const contentFields = extractContentFields(record);
    const recordHash = computeRecordHash(contentFields, lastHash);

    await prisma.auditEvent.update({
      where: { id: record.id },
      data: { recordHash, previousRecordHash: lastHash },
    });

    lastHash = recordHash;
    backfilled++;
  }

  return backfilled;
}
