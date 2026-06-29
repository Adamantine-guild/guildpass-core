import { IndexerWorker, ChainProvider } from './indexerWorker';
import { DecodedContractEvent } from '../services/contractEventHelpers';

describe('IndexerWorker', () => {
  let prisma: any;
  let provider: jest.Mocked<ChainProvider>;
  let worker: IndexerWorker;

  beforeEach(() => {
    prisma = {
      indexerState: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
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

    worker = new IndexerWorker(prisma as any, provider, 5000, 12);
  });

  test('should process blocks and update checkpoint', async () => {
    provider.getLatestBlockNumber.mockResolvedValue(100);
    prisma.indexerState.findUnique.mockResolvedValue({
      lastBlockNumber: 80,
      lastBlockHash: 'hash80',
    });
    provider.getBlock.mockImplementation(async (n) => ({
      number: n,
      hash: `hash${n}`,
      parentHash: `hash${n - 1}`,
    }));
    provider.getLogs.mockResolvedValue([]);

    await worker.runPass();

    expect(provider.getLogs).toHaveBeenCalledWith(81, 88); // 100 - 12 = 88
    expect(prisma.indexerState.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ lastBlockNumber: 88 }),
    }));
  });

  test('should detect reorg and rewind', async () => {
    provider.getLatestBlockNumber.mockResolvedValue(100);
    prisma.indexerState.findUnique.mockResolvedValue({
      lastBlockNumber: 80,
      lastBlockHash: 'hash80-old',
    });
    provider.getBlock.mockImplementation(async (n) => ({
      number: n,
      hash: `hash${n}`, // Will return hash80 for block 80, which differs from hash80-old
      parentHash: `hash${n - 1}`,
    }));

    await worker.runPass();

    expect(prisma.indexerState.update).toHaveBeenCalled();
    // Rewind 80 - 12*2 = 56
    expect(prisma.processedEvent.deleteMany).toHaveBeenCalledWith({
      where: { blockNumber: { gt: 56 } },
    });
  });

  test('should handle duplicate logs idempotently via applyContractEvent', async () => {
    provider.getLatestBlockNumber.mockResolvedValue(100);
    prisma.indexerState.findUnique.mockResolvedValue({
      lastBlockNumber: 80,
      lastBlockHash: 'hash80',
    });
    provider.getBlock.mockResolvedValue({ number: 80, hash: 'hash80', parentHash: 'hash79' });

    const mockLog: DecodedContractEvent = {
      type: 'MembershipMinted',
      to: '0x123',
      tokenId: 1,
      communityId: 'c1',
      expiresAt: 1000,
      transactionHash: 'tx1',
      logIndex: 0,
      blockNumber: 81,
      blockHash: 'hash81',
    };
    provider.getLogs.mockResolvedValue([mockLog]);

    // Simulate already processed
    prisma.processedEvent.findUnique.mockResolvedValue({ id: 'existing' });

    await worker.runPass();

    // Should NOT call wallet upsert because it's already processed
    expect(prisma.wallet.upsert).not.toHaveBeenCalled();
  });
});
