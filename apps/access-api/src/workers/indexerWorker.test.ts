import { IndexerWorker, ChainProvider } from './indexerWorker';
import { DecodedContractEvent } from '../services/contractEventHelpers';
import { metrics } from '../observability/metrics';

// Mock the audit chain service
jest.mock('../services/auditChainHasher', () => ({
  writeChainedAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

// Mock the metrics
jest.mock('../observability/metrics', () => ({
  metrics: {
    indexerLag: {
      set: jest.fn(),
    },
  },
}));

describe('IndexerWorker', () => {
  let prisma: any;
  let provider: jest.Mocked<ChainProvider>;
  let worker: IndexerWorker;
  const chainId = 31337;

  beforeEach(() => {
    prisma = {
      indexerCheckpoint: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
      },
      blockHeader: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
      },
      processedEvent: {
        findUnique: jest.fn(),
        create: jest.fn(),
        deleteMany: jest.fn(),
      },
      $transaction: jest.fn((cb) => cb(prisma)),
      wallet: { upsert: jest.fn() },
      community: { upsert: jest.fn() },
      member: { upsert: jest.fn() },
      membership: { upsert: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    };

    provider = {
      getLatestBlockNumber: jest.fn(),
      getBlock: jest.fn(),
      getLogs: jest.fn(),
    };

    worker = new IndexerWorker(prisma as any, provider, 5000, 12, chainId, 100);
    jest.clearAllMocks();
  });

  test('should process blocks and update indexerCheckpoint per chain', async () => {
    provider.getLatestBlockNumber.mockResolvedValue(100);
    prisma.indexerCheckpoint.findUnique.mockResolvedValue({
      chainId,
      lastProcessedBlock: 80,
      lastProcessedBlockHash: 'hash80',
    });
    provider.getBlock.mockImplementation(async (n) => ({
      number: n,
      hash: `hash${n}`,
      parentHash: `hash${n - 1}`,
    }));
    provider.getLogs.mockResolvedValue([]);

    await worker.runPass();

    expect(provider.getLogs).toHaveBeenCalledWith(81, 88); // 100 - 12 = 88
    expect(prisma.indexerCheckpoint.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ chainId, lastProcessedBlock: 88 }),
    }));
    expect(metrics.indexerLag.set).toHaveBeenCalledWith({ chain_id: String(chainId) }, 20); // 100 - 80 = 20
  });

  test('should detect reorg and rewind to last common ancestor (LCA)', async () => {
    provider.getLatestBlockNumber.mockResolvedValue(100);
    prisma.indexerCheckpoint.findUnique.mockResolvedValue({
      chainId,
      lastProcessedBlock: 80,
      lastProcessedBlockHash: 'hash80-old',
    });

    // Mock block hash mismatch at block 80
    provider.getBlock.mockImplementation(async (n) => {
      if (n === 80) return { number: 80, hash: 'hash80-new', parentHash: 'hash79-new' };
      if (n === 79) return { number: 79, hash: 'hash79-new', parentHash: 'hash78' };
      if (n === 78) return { number: 78, hash: 'hash78', parentHash: 'hash77' };
      return { number: n, hash: `hash${n}`, parentHash: `hash${n - 1}` };
    });

    // Stored headers in DB: 79 is mismatch, 78 is match
    prisma.blockHeader.findUnique.mockImplementation(async (args: any) => {
      const blockNum = args.where.chainId_blockNumber.blockNumber;
      if (blockNum === 79) return { chainId, blockNumber: 79, blockHash: 'hash79-old' };
      if (blockNum === 78) return { chainId, blockNumber: 78, blockHash: 'hash78' };
      return null;
    });

    await worker.runPass();

    // Checkpoint should be updated to block 78 (common ancestor)
    expect(prisma.indexerCheckpoint.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ lastProcessedBlock: 78, lastProcessedBlockHash: 'hash78' }),
    }));
    // Should clear events and headers past block 78
    expect(prisma.processedEvent.deleteMany).toHaveBeenCalledWith({
      where: { blockNumber: { gt: 78 } },
    });
    expect(prisma.blockHeader.deleteMany).toHaveBeenCalledWith({
      where: { chainId, blockNumber: { gt: 78 } },
    });
  });

  test('should support backfill mode to process historical block range', async () => {
    provider.getLogs.mockResolvedValue([]);
    provider.getBlock.mockImplementation(async (n) => ({
      number: n,
      hash: `hash${n}`,
      parentHash: `hash${n - 1}`,
    }));

    await worker.backfill(50, 250);

    // With batchSize 100:
    // Batch 1: 50 to 149
    // Batch 2: 150 to 249
    // Batch 3: 250 to 250
    expect(provider.getLogs).toHaveBeenCalledTimes(3);
    expect(provider.getLogs).toHaveBeenNthCalledWith(1, 50, 149);
    expect(provider.getLogs).toHaveBeenNthCalledWith(2, 150, 249);
    expect(provider.getLogs).toHaveBeenNthCalledWith(3, 250, 250);
  });
});
