import { IndexerWorker, ChainProvider, indexerStateId } from './indexerWorker';
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

    worker = new IndexerWorker(prisma as any, provider, 5000, 12, {
      chainId: 1,
      membershipNftAddress: '0x0000000000000000000000000000000000000001',
    });
  });

  test('should process blocks and update checkpoint', async () => {
    provider.getLatestBlockNumber.mockResolvedValue(100);
    prisma.indexerState.findUnique.mockResolvedValue({
      lastBlockNumber: 80,
      id: indexerStateId({ chainId: 1, membershipNftAddress: '0x0000000000000000000000000000000000000001' }),
      chainId: 1,
      contractAddress: '0x0000000000000000000000000000000000000001',
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
    expect(prisma.indexerState.findUnique).toHaveBeenCalledWith({
      where: { id: '1:0x0000000000000000000000000000000000000001' },
    });
    expect(prisma.indexerState.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ chainId: 1, lastBlockNumber: 88 }),
    }));
  });

  test('should detect reorg and rewind', async () => {
    provider.getLatestBlockNumber.mockResolvedValue(100);
    prisma.indexerState.findUnique.mockResolvedValue({
      lastBlockNumber: 80,
      id: indexerStateId({ chainId: 1, membershipNftAddress: '0x0000000000000000000000000000000000000001' }),
      chainId: 1,
      contractAddress: '0x0000000000000000000000000000000000000001',
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
      where: { chainId: 1, blockNumber: { gt: 56 } },
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

describe('multi-chain replay protection', () => {
  function makePrisma(existing: unknown = null): any {
    const txContexts: any[] = [];
    const createTx = () => ({
      processedEvent: {
        findUnique: jest.fn().mockResolvedValue(existing),
        create: jest.fn(),
        deleteMany: jest.fn(),
      },
      wallet: { upsert: jest.fn().mockResolvedValue({ id: 'wallet-1' }) },
      community: { upsert: jest.fn() },
      member: { upsert: jest.fn().mockResolvedValue({ id: 'member-1' }) },
      membership: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({ id: 'membership-1', tokenId: 7, state: 'active', expiresAt: new Date(2000 * 1000) }) },
      auditEvent: { create: jest.fn() },
      outboxEvent: { create: jest.fn() },
    });
    return {
      txContexts,
      indexerState: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
      processedEvent: { findUnique: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
      $transaction: jest.fn((cb) => {
        const tx = createTx();
        txContexts.push(tx);
        return cb(tx);
      }),
    };
  }

  test('uses chainId in processed-event identity so identical tx/log on different chains is not replayed', async () => {
    const { applyContractEvent } = await import('../services/contractEventHelpers');
    const prisma = makePrisma();
    const baseEvent: DecodedContractEvent = {
      type: 'MembershipMinted',
      to: '0x00000000000000000000000000000000000000aa',
      tokenId: 7,
      communityId: 'community-1',
      expiresAt: 2000,
      transactionHash: '0xabc',
      logIndex: 0,
      blockNumber: 10,
      blockHash: '0xblock',
    };

    await applyContractEvent(prisma as any, { ...baseEvent, chainId: 1 });
    await applyContractEvent(prisma as any, { ...baseEvent, chainId: 137 });

    expect(prisma.txContexts[0].processedEvent.findUnique).toHaveBeenCalledWith({
      where: { chainId_transactionHash_logIndex: { chainId: 1, transactionHash: '0xabc', logIndex: 0 } },
    });
    expect(prisma.txContexts[1].processedEvent.findUnique).toHaveBeenCalledWith({
      where: { chainId_transactionHash_logIndex: { chainId: 137, transactionHash: '0xabc', logIndex: 0 } },
    });
  });
});
