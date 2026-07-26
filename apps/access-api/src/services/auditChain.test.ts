import { keccak256 } from 'js-sha3';

// Mock dependencies before importing auditChainHasher to avoid
// the "Cannot find module '.prisma/client/default'" error when
// Prisma client has not been generated (pre-existing CI/Dev requirement).
jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(),
  Prisma: { sql: jest.fn(() => '') },
}));

jest.mock('../observability/metrics', () => ({
  metrics: {
    auditChainWriteDuration: { observe: jest.fn() },
  },
}));

jest.mock('./prisma', () => ({
  getPrisma: jest.fn(),
}));

import {
  computeRecordHash,
  extractContentFields,
  verifyAuditChainIntegrity,
  backfillAuditChain,
} from './auditChainHasher';

// ---------------------------------------------------------------------------
// Unit tests: hash computation
// ---------------------------------------------------------------------------

describe('computeRecordHash', () => {
  it('produces a deterministic 64-char hex hash', () => {
    const hash = computeRecordHash({ eventType: 'ACCESS_CHECK' }, null);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same hash for identical inputs', () => {
    const fields = { eventType: 'ACCESS_CHECK', walletId: '0xabc' };
    const hash1 = computeRecordHash(fields, 'prevhash123');
    const hash2 = computeRecordHash(fields, 'prevhash123');
    expect(hash1).toBe(hash2);
  });

  it('changes when content fields change', () => {
    const hash1 = computeRecordHash({ eventType: 'ACCESS_CHECK', decision: 'ALLOW' }, null);
    const hash2 = computeRecordHash({ eventType: 'ACCESS_CHECK', decision: 'DENY' }, null);
    expect(hash1).not.toBe(hash2);
  });

  it('changes when previousRecordHash changes', () => {
    const fields = { eventType: 'MEMBERSHIP_CREATED' };
    const hash1 = computeRecordHash(fields, 'aaa');
    const hash2 = computeRecordHash(fields, 'bbb');
    expect(hash1).not.toBe(hash2);
  });

  it('handles null previousRecordHash for first record', () => {
    const hash = computeRecordHash({ eventType: 'ACCESS_CHECK' }, null);
    expect(typeof hash).toBe('string');
    expect(hash.length).toBe(64);
  });

  it('canonicalizes objects with sorted keys', () => {
    const fieldsA = { eventType: 'TEST', walletId: '0x1', communityId: 'c1' };
    const fieldsB = { communityId: 'c1', eventType: 'TEST', walletId: '0x1' };
    expect(computeRecordHash(fieldsA, null)).toBe(computeRecordHash(fieldsB, null));
  });

  it('includes all content fields in the hash', () => {
    const fields = {
      eventType: 'MEMBERSHIP_CREATED',
      walletId: '0xwallet',
      communityId: 'comm-1',
      resource: 'some-resource',
      policyRule: 'MEMBERS_ONLY',
      decision: 'ALLOW',
      reasonCode: 'ACTIVE_MEMBER',
      correlationId: 'corr-123',
      chainId: 1,
      txHash: '0xtx',
      blockNumber: 12345,
      logIndex: 2,
      membershipStateVersion: '{"state":"active"}',
      roleStateVersion: '[]',
    };
    const hash = computeRecordHash(fields, null);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('extractContentFields', () => {
  it('excludes id, createdAt, recordHash, previousRecordHash', () => {
    const fields = extractContentFields({
      eventType: 'ACCESS_CHECK',
      walletId: '0xabc',
    });
    expect(fields.id).toBeUndefined();
    expect(fields.createdAt).toBeUndefined();
    expect(fields.recordHash).toBeUndefined();
    expect(fields.previousRecordHash).toBeUndefined();
    expect(fields.eventType).toBe('ACCESS_CHECK');
    expect(fields.walletId).toBe('0xabc');
  });

  it('omits null fields to keep canonical form stable', () => {
    const fields = extractContentFields({
      eventType: 'ACCESS_CHECK',
      walletId: null,
      communityId: undefined,
    });
    expect(fields.walletId).toBeUndefined();
    expect(fields.communityId).toBeUndefined();
    expect(fields.eventType).toBe('ACCESS_CHECK');
  });
});

// ---------------------------------------------------------------------------
// Chain integrity verification (using synthetic in-memory records)
// ---------------------------------------------------------------------------

describe('verifyAuditChainIntegrity with synthetic records', () => {
  function buildRecord(overrides: {
    id?: string;
    eventType?: string;
    walletId?: string | null;
    recordHash?: string | null;
    previousRecordHash?: string | null;
    chainIndex?: number;
  }) {
    const eventType = overrides.eventType ?? 'ACCESS_CHECK';
    const walletId = overrides.walletId ?? null;
    const fields = extractContentFields({ eventType, walletId: walletId ?? undefined });
    const prev = overrides.previousRecordHash ?? null;
    const hash = overrides.recordHash ?? computeRecordHash(fields, prev);
    return {
      id: overrides.id ?? `evt-${overrides.chainIndex ?? Math.random()}`,
      eventType,
      walletId,
      communityId: null,
      resource: null,
      policyRule: null,
      decision: null,
      reasonCode: null,
      beforeState: null,
      afterState: null,
      correlationId: null,
      chainId: null,
      txHash: null,
      blockNumber: null,
      logIndex: null,
      membershipStateVersion: null,
      roleStateVersion: null,
      recordHash: hash,
      previousRecordHash: prev,
      createdAt: new Date(),
    };
  }

  function makeRecord(i: number, prevHash: string | null) {
    const eventType = i % 2 === 0 ? 'ACCESS_CHECK' : 'MEMBERSHIP_CREATED';
    const walletId = `0xwallet-${i}`;
    const decision = i % 2 === 0 ? 'ALLOW' : null;
    const communityId = 'comm-1';
    // Use extractContentFields to compute hash from the exact same
    // fields that verifyAuditChainIntegrity will extract.
    const contentFields = extractContentFields({
      eventType,
      walletId,
      communityId,
      decision: decision ?? undefined,
    });
    const hash = computeRecordHash(contentFields, prevHash);
    return {
      id: `rec-${i}`,
      eventType,
      walletId,
      communityId,
      resource: null,
      policyRule: null,
      decision,
      reasonCode: null,
      beforeState: null,
      afterState: null,
      correlationId: null,
      chainId: null,
      txHash: null,
      blockNumber: null,
      logIndex: null,
      membershipStateVersion: null,
      roleStateVersion: null,
      recordHash: hash,
      previousRecordHash: prevHash,
      createdAt: new Date(Date.now() + i * 1000),
    };
  }

  function makeChain(length: number) {
    const records: any[] = [];
    let prevHash: string | null = null;
    for (let i = 0; i < length; i++) {
      const record = makeRecord(i, prevHash);
      records.push(record);
      prevHash = record.recordHash;
    }
    return records;
  }

  async function runVerification(records: any[]) {
    const mockFindMany = jest.fn().mockResolvedValue(records);
    const mockPrisma = {
      auditEvent: { findMany: mockFindMany },
    } as any;
    return verifyAuditChainIntegrity(mockPrisma);
  }

  it('passes for a clean chain of 5 records', async () => {
    const result = await runVerification(makeChain(5));
    expect(result.valid).toBe(true);
    expect(result.totalRecords).toBe(5);
    expect(result.verifiedRecords).toBe(5);
    expect(result.skippedRecords).toBe(0);
    expect(result.breaks).toHaveLength(0);
  });

  it('passes for a single record', async () => {
    const result = await runVerification(makeChain(1));
    expect(result.valid).toBe(true);
    expect(result.verifiedRecords).toBe(1);
  });

  it('handles empty chain', async () => {
    const result = await runVerification([]);
    expect(result.valid).toBe(true);
    expect(result.totalRecords).toBe(0);
  });

  it('detects tampered content (modified walletId)', async () => {
    const records = makeChain(5);
    // Tamper with record 2's walletId
    records[2].walletId = '0xcompromised';

    const result = await runVerification(records);
    expect(result.valid).toBe(false);
    expect(result.breaks.length).toBeGreaterThanOrEqual(1);
    expect(result.breaks[0].recordId).toBe('rec-2');
    expect(result.breaks[0].reason).toContain('recordHash mismatch');
  });

  it('detects broken link (modified previousRecordHash)', async () => {
    const records = makeChain(3);
    // Break the link between rec-1 and rec-2
    records[2].previousRecordHash = '0xforgedhash';

    const result = await runVerification(records);
    expect(result.valid).toBe(false);
    expect(result.breaks.length).toBeGreaterThanOrEqual(1);
    expect(result.breaks[0].recordId).toBe('rec-2');
    expect(result.breaks[0].reason).toContain('previousRecordHash mismatch');
  });

  it('detects deletion of a middle record (chain gap)', async () => {
    const records = makeChain(5);
    // Remove record 2 (index 2)
    const shortened = [records[0], records[1], records[3], records[4]];
    // Record 3 now incorrectly has previousRecordHash from record 1
    shortened[2].previousRecordHash = records[1].recordHash;

    const result = await runVerification(shortened);
    // The hash of record 3 was computed with record 2's hash, not record 1's
    expect(result.valid).toBe(false);
    expect(result.breaks.length).toBeGreaterThanOrEqual(1);
  });

  it('skips records without recordHash (pre-migration)', async () => {
    const records = makeChain(3);
    // Simulate a pre-migration record (no hash) at position 1.
    // The chain is broken: rec-0 is valid, rec-1 is skipped, rec-2
    // still references rec-1's old hash but verification resets
    // lastValidHash on skip, so rec-2 triggers a break.
    records[1].recordHash = null;
    records[1].previousRecordHash = null;

    const result = await runVerification(records);
    expect(result.skippedRecords).toBe(1);
    // rec-0 verified; rec-2 is detected as a break because its
    // previousRecordHash doesn't match the reset (null) chain head
    expect(result.verifiedRecords).toBe(1);
    expect(result.valid).toBe(false);
    expect(result.breaks.length).toBe(1);
    expect(result.breaks[0].recordId).toBe('rec-2');
    expect(result.breaks[0].reason).toContain('previousRecordHash');
  });

  it('verifies chain tip hash is the last valid hash', async () => {
    const records = makeChain(3);
    const result = await runVerification(records);
    expect(result.chainTipHash).toBe(records[2].recordHash);
  });
});

// ---------------------------------------------------------------------------
// Performance measurement
// ---------------------------------------------------------------------------

describe('hash computation performance', () => {
  it('computes hash within acceptable time', () => {
    const fields = {
      eventType: 'ACCESS_CHECK',
      walletId: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0',
      communityId: 'test-community-id-12345',
      resource: 'some-resource-path',
      policyRule: 'MEMBERS_ONLY',
      decision: 'ALLOW',
      reasonCode: 'ACTIVE_MEMBER',
      correlationId: 'corr-123-456-789',
      chainId: 1,
      txHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      blockNumber: 12345678,
      logIndex: 42,
      membershipStateVersion: JSON.stringify({ state: 'active', tokenId: 123 }),
      roleStateVersion: JSON.stringify([{ role: 'admin', source: 'manual' }]),
    };

    const iterations = 10000;
    const start = process.hrtime.bigint();

    for (let i = 0; i < iterations; i++) {
      computeRecordHash(fields, `prevhash-${i % 100}`);
    }

    const elapsedNs = Number(process.hrtime.bigint() - start);
    const avgMicroseconds = elapsedNs / iterations / 1000;

    // Expected: well under 200µs per hash (pure JS keccak256 is fast;
    // CI runners may be slower, so the threshold is generous.)
    expect(avgMicroseconds).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// Backfill function tests
// ---------------------------------------------------------------------------

describe('backfillAuditChain', () => {
  it('backfills records in chronological order', async () => {
    const records: any[] = [];
    let idCounter = 0;
    const mockFindMany = jest.fn().mockImplementation(() => {
      // Simulate incremental backfill: each call returns remaining unhashed records
      const unhashed = records.filter((r) => r.recordHash === null)
        .sort((a, b) => a.createdAt - b.createdAt);
      return Promise.resolve(unhashed);
    });
    const mockUpdate = jest.fn().mockImplementation(({ where, data }) => {
      const rec = records.find((r) => r.id === where.id);
      if (rec) {
        rec.recordHash = data.recordHash;
        rec.previousRecordHash = data.previousRecordHash;
      }
      return Promise.resolve(rec);
    });
    const mockPrisma = {
      auditEvent: { findMany: mockFindMany, update: mockUpdate },
    } as any;

    // Seed 3 unhashed records (simulating pre-migration state)
    for (let i = 0; i < 3; i++) {
      const id = `backfill-rec-${idCounter++}`;
      records.push({
        id,
        eventType: 'ACCESS_CHECK',
        walletId: `0xwallet-${i}`,
        communityId: null,
        resource: null,
        policyRule: null,
        decision: null,
        reasonCode: null,
        beforeState: null,
        afterState: null,
        correlationId: null,
        chainId: null,
        txHash: null,
        blockNumber: null,
        logIndex: null,
        membershipStateVersion: null,
        roleStateVersion: null,
        recordHash: null,
        previousRecordHash: null,
        createdAt: new Date(Date.now() + i * 1000),
      });
    }

    const count = await backfillAuditChain(mockPrisma, 10);
    expect(count).toBe(3);

    // All should now have hashes
    expect(records.every((r: any) => r.recordHash !== null)).toBe(true);
    // First record has null previous
    expect(records[0].previousRecordHash).toBeNull();
    // Second points to first
    expect(records[1].previousRecordHash).toBe(records[0].recordHash);
    // Third points to second
    expect(records[2].previousRecordHash).toBe(records[1].recordHash);
  });
});

// ---------------------------------------------------------------------------
// Value-object test: exact hash value for known inputs
// ---------------------------------------------------------------------------

describe('deterministic hash value', () => {
  it('produces the expected hash for a known input', () => {
    const fields = { eventType: 'ACCESS_CHECK' };
    const prevHash = null;
    const hash = computeRecordHash(fields, prevHash);

    // Verify using the raw keccak256 library directly
    const content = JSON.stringify(fields);
    const input = content + '';
    const expected = keccak256(input);
    expect(hash).toBe(expected);
  });

  it('chains correctly: h2 depends on h1', () => {
    const f1 = { eventType: 'FIRST' };
    const h1 = computeRecordHash(f1, null);

    const f2 = { eventType: 'SECOND' };
    const h2 = computeRecordHash(f2, h1);

    const expectedContent2 = JSON.stringify(f2);
    const expectedInput2 = expectedContent2 + h1;
    const expectedH2 = keccak256(expectedInput2);
    expect(h2).toBe(expectedH2);
    expect(h2).not.toBe(h1);
  });
});
