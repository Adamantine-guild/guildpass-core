/**
 * Common-ancestor reorg recovery tests for IndexerWorker (#144).
 */

import {
  IndexerWorker,
  ChainProvider,
  indexerStateId,
  ReorgTooDeepError,
} from './indexerWorker';

jest.mock('../services/contractEventHelpers', () => ({
  applyContractEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../observability/metrics', () => ({
  metrics: {
    indexerLag: { set: jest.fn() },
    indexerReorgsDetectedTotal: { inc: jest.fn() },
    indexerReconciliationDuration: {
      startTimer: jest.fn(() => jest.fn()),
    },
  },
}));

describe('IndexerWorker common-ancestor reorg (#144)', () => {
  const chainConfig = {
    chainId: 1,
    membershipNftAddress: '0x0000000000000000000000000000000000000001',
  };
  const stateId = indexerStateId(chainConfig);

  let prisma: any;
  let provider: jest.Mocked<ChainProvider>;
  /** Canonical (post-reorg) hashes: hash{n}. Orphaned tip used hash{n}-old. */
  let chainHashes: Map<number, string>;

  beforeEach(() => {
    chainHashes = new Map();
    for (let n = 0; n <= 100; n++) {
      chainHashes.set(n, `hash${n}`);
    }

    const headers = new Map<string, { chainId: number; blockNumber: number; blockHash: string }>();

    prisma = {
      indexerState: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
      },
      blockHeader: {
        findUnique: jest.fn(async ({ where }: any) => {
          const key = `${where.chainId_blockNumber.chainId}:${where.chainId_blockNumber.blockNumber}`;
          return headers.get(key) ?? null;
        }),
        upsert: jest.fn(async ({ where, create, update }: any) => {
          const key = `${where.chainId_blockNumber.chainId}:${where.chainId_blockNumber.blockNumber}`;
          const existing = headers.get(key);
          const next = existing
            ? { ...existing, blockHash: update.blockHash }
            : create;
          headers.set(key, next);
          return next;
        }),
        deleteMany: jest.fn(async ({ where }: any) => {
          for (const key of [...headers.keys()]) {
            const h = headers.get(key)!;
            if (
              h.chainId === where.chainId &&
              (where.blockNumber?.gt === undefined || h.blockNumber > where.blockNumber.gt) &&
              (where.blockNumber?.lt === undefined || h.blockNumber < where.blockNumber.lt)
            ) {
              headers.delete(key);
            }
          }
          return { count: 0 };
        }),
      },
      processedEvent: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: jest.fn(async (cb: any) => cb(prisma)),
      // seed helper used by tests
      __headers: headers,
    };

    provider = {
      getLatestBlockNumber: jest.fn(),
      getBlock: jest.fn(async (n) => ({
        number: n,
        hash: chainHashes.get(n) ?? `hash${n}`,
        parentHash: chainHashes.get(n - 1) ?? `hash${n - 1}`,
      })),
      getLogs: jest.fn().mockResolvedValue([]),
    };
  });

  function seedHeaders(upTo: number, hashFn: (n: number) => string = (n) => `hash${n}`) {
    for (let n = 0; n <= upTo; n++) {
      prisma.__headers.set(`1:${n}`, {
        chainId: 1,
        blockNumber: n,
        blockHash: hashFn(n),
      });
    }
  }

  test('shallow reorg finds the true common ancestor and rewinds exactly there', async () => {
    // Headers stored for old tip through 80. Common ancestor is 75:
    // blocks 76..80 were reorged (stored *-old, provider now hash{n}).
    seedHeaders(80, (n) => (n > 75 ? `hash${n}-old` : `hash${n}`));

    prisma.indexerState.findUnique.mockResolvedValue({
      id: stateId,
      chainId: 1,
      contractAddress: chainConfig.membershipNftAddress,
      lastBlockNumber: 80,
      lastBlockHash: 'hash80-old',
    });
    provider.getLatestBlockNumber.mockResolvedValue(100);

    const worker = new IndexerWorker(prisma, provider, {
      intervalMs: 5000,
      finalityWindow: 12,
      maxReorgSearchDepth: 64,
      chainConfig,
    });

    await worker.runPass();

    expect(prisma.indexerState.update).toHaveBeenCalledWith({
      where: { id: stateId },
      data: { lastBlockNumber: 75, lastBlockHash: 'hash75' },
    });
    expect(prisma.processedEvent.deleteMany).toHaveBeenCalledWith({
      where: { chainId: 1, blockNumber: { gt: 75 } },
    });
    // Must NOT have rewound the full fixed window (80 - 24 = 56).
    expect(prisma.processedEvent.deleteMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ blockNumber: { gt: 56 } }),
      }),
    );
    // No getLogs yet — reorg pass returns early so unaffected range isn't re-scanned here.
    expect(provider.getLogs).not.toHaveBeenCalled();
  });

  test('deeper reorg beyond the old fixed window still finds the true LCA', async () => {
    // Fixed window would rewind to 80 - 24 = 56. True ancestor is 40.
    seedHeaders(80, (n) => (n > 40 ? `hash${n}-old` : `hash${n}`));

    prisma.indexerState.findUnique.mockResolvedValue({
      id: stateId,
      chainId: 1,
      contractAddress: chainConfig.membershipNftAddress,
      lastBlockNumber: 80,
      lastBlockHash: 'hash80-old',
    });
    provider.getLatestBlockNumber.mockResolvedValue(100);

    const worker = new IndexerWorker(prisma, provider, {
      finalityWindow: 12,
      maxReorgSearchDepth: 64,
      chainConfig,
    });

    await worker.runPass();

    expect(prisma.indexerState.update).toHaveBeenCalledWith({
      where: { id: stateId },
      data: { lastBlockNumber: 40, lastBlockHash: 'hash40' },
    });
    expect(prisma.processedEvent.deleteMany).toHaveBeenCalledWith({
      where: { chainId: 1, blockNumber: { gt: 40 } },
    });
  });

  test('reorg deeper than maxSearchDepth throws ReorgTooDeepError (operational alert)', async () => {
    // Every stored header mismatches provider — LCA would be below 0 or beyond depth.
    seedHeaders(80, (n) => `hash${n}-old`);

    prisma.indexerState.findUnique.mockResolvedValue({
      id: stateId,
      chainId: 1,
      contractAddress: chainConfig.membershipNftAddress,
      lastBlockNumber: 80,
      lastBlockHash: 'hash80-old',
    });
    provider.getLatestBlockNumber.mockResolvedValue(100);

    const worker = new IndexerWorker(prisma, provider, {
      finalityWindow: 12,
      maxReorgSearchDepth: 5,
      chainConfig,
    });

    // runPass swallows errors — call findCommonAncestor / handle path directly.
    await expect(worker.findCommonAncestor(80, { maxSearchDepth: 5 })).rejects.toBeInstanceOf(
      ReorgTooDeepError,
    );

    await expect(worker.findCommonAncestor(80, { maxSearchDepth: 5 })).rejects.toMatchObject({
      code: 'REORG_TOO_DEEP',
      chainId: 1,
      lastKnownBlock: 80,
      maxSearchDepth: 5,
    });

    // Ensure we do not silently under-rewind via handleReorg.
    prisma.indexerState.update.mockClear();
    prisma.processedEvent.deleteMany.mockClear();

    // Force reorg detection path
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    await worker.runPass();
    expect(prisma.indexerState.update).not.toHaveBeenCalled();
    expect(prisma.processedEvent.deleteMany).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('OPERATIONAL ALERT'),
    );
    consoleError.mockRestore();
  });

  test('findCommonAncestor returns depth and hash for a known match', async () => {
    seedHeaders(50);
    const worker = new IndexerWorker(prisma, provider, {
      maxReorgSearchDepth: 20,
      chainConfig,
    });

    // Tip 50 mismatches so walk starts at 49 — all match, so ancestor is 49.
    const result = await worker.findCommonAncestor(50);
    expect(result).toEqual({
      blockNumber: 49,
      blockHash: 'hash49',
      depth: 1,
    });
  });
});
