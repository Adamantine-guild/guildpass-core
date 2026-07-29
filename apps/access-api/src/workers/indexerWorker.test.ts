import { IndexerWorker, ChainProvider, indexerStateId } from './indexerWorker';
import { applyContractEvent, DecodedContractEvent } from '../services/contractEventHelpers';
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
    indexerReorgsDetectedTotal: {
      inc: jest.fn(),
    },
    indexerReconciliationDuration: {
      startTimer: jest.fn(() => jest.fn()),
    },
  },
}));

describe('IndexerWorker', () => {
  let prisma: any;
  let provider: jest.Mocked<ChainProvider>;
  let worker: IndexerWorker;
  const chainId = 31337;
  const contractAddress = '0x0000000000000000000000000000000000000000';

  beforeEach(() => {
    prisma = {
      indexerState: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
      },
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
      auditEvent: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn(),
      },
      outboxEvent: {
        deleteMany: jest.fn(),
      },
      $transaction: jest.fn((cb) => cb(prisma)),
      wallet: { upsert: jest.fn() },
      community: { upsert: jest.fn() },
      member: { upsert: jest.fn() },
      membership: { upsert: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
      membershipToken: { upsert: jest.fn(), findUnique: jest.fn(), update: jest.fn(), deleteMany: jest.fn() },
      contractAdmin: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn(), deleteMany: jest.fn() },
      contractOwnership: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn(), deleteMany: jest.fn() },
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

  test('should process blocks and update indexerCheckpoint per chain & contract', async () => {
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
    expect(metrics.indexerLag.set).toHaveBeenCalledWith({ chain_id: '1' }, 20); // 100 - 80 = 20
  });

  test('should detect reorg, trigger reconciliation duration metric, and rewind to LCA', async () => {
    provider.getLatestBlockNumber.mockResolvedValue(100);
    prisma.indexerState.findUnique.mockResolvedValue({
      lastBlockNumber: 80,
      id: indexerStateId({ chainId: 1, membershipNftAddress: '0x0000000000000000000000000000000000000001' }),
      chainId: 1,
      contractAddress: '0x0000000000000000000000000000000000000001',
      lastBlockHash: 'hash80-old',
    });
    prisma.blockHeader.findUnique.mockImplementation(async ({ where }: any) => {
      const n = where.chainId_blockNumber.blockNumber;
      if (n > 75) return { chainId: 1, blockNumber: n, blockHash: `hash${n}-old` };
      return { chainId: 1, blockNumber: n, blockHash: `hash${n}` };
    });
    provider.getBlock.mockImplementation(async (n) => ({
      number: n,
      hash: `hash${n}`,
      parentHash: `hash${n - 1}`,
    }));

    await worker.runPass();

    expect(prisma.indexerState.update).toHaveBeenCalledWith({
      where: { id: '1:0x0000000000000000000000000000000000000001' },
      data: { lastBlockNumber: 75, lastBlockHash: 'hash75' },
    });
    expect(prisma.processedEvent.deleteMany).toHaveBeenCalledWith({
      where: { chainId: 1, blockNumber: { gt: 75 } },
    });
    expect(metrics.indexerReorgsDetectedTotal.inc).toHaveBeenCalled();
  });

  test('should support backfill mode to process historical block range', async () => {
    provider.getLogs.mockResolvedValue([]);
    provider.getBlock.mockImplementation(async (n) => ({
      number: n,
      hash: `hash${n}`,
      parentHash: `hash${n - 1}`,
    }));

    await worker.backfill(50, 55);

    expect(prisma.indexerState.upsert).toHaveBeenCalled();
    expect(provider.getLogs).toHaveBeenCalled();
  });

  describe('applyContractEvent - Admin & Ownership Events', () => {
    const transactionHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const blockHash = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    const logIndex = 1;
    const blockNumber = 100;

    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('should handle AdminUpdated event (grant admin)', async () => {
      const event: DecodedContractEvent = {
        type: 'AdminUpdated',
        admin: '0xAdminAddress12345678901234567890123456',
        enabled: true,
        chainId,
        transactionHash,
        blockHash,
        logIndex,
        blockNumber,
      };

      prisma.processedEvent.findUnique.mockResolvedValue(null);
      prisma.contractAdmin.findUnique.mockResolvedValue(null);
      prisma.contractAdmin.upsert.mockResolvedValue({
        chainId,
        address: event.admin.toLowerCase(),
        enabled: true,
      });

      const { writeChainedAuditEvent } = require('../services/auditChainHasher');

      await applyContractEvent(prisma as any, event);

      expect(prisma.contractAdmin.upsert).toHaveBeenCalledWith({
        where: {
          chainId_address: {
            chainId,
            address: event.admin.toLowerCase(),
          },
        },
        update: { enabled: true },
        create: {
          chainId,
          address: event.admin.toLowerCase(),
          enabled: true,
        },
      });

      expect(writeChainedAuditEvent).toHaveBeenCalledWith(prisma, expect.objectContaining({
        eventType: 'CONTRACT_ADMIN_UPDATED',
        walletId: event.admin.toLowerCase(),
        chainId,
        txHash: transactionHash,
        blockNumber,
        logIndex,
        afterState: { enabled: true },
      }));

      expect(prisma.processedEvent.create).toHaveBeenCalledWith({
        data: {
          chainId,
          transactionHash,
          logIndex,
          blockHash,
          blockNumber,
          eventType: 'AdminUpdated',
        },
      });
    });

    test('should handle AdminUpdated event (revoke admin)', async () => {
      const event: DecodedContractEvent = {
        type: 'AdminUpdated',
        admin: '0xAdminAddress12345678901234567890123456',
        enabled: false,
        chainId,
        transactionHash,
        blockHash,
        logIndex,
        blockNumber,
      };

      prisma.processedEvent.findUnique.mockResolvedValue(null);
      prisma.contractAdmin.findUnique.mockResolvedValue({
        chainId,
        address: event.admin.toLowerCase(),
        enabled: true,
      });
      prisma.contractAdmin.upsert.mockResolvedValue({
        chainId,
        address: event.admin.toLowerCase(),
        enabled: false,
      });

      const { writeChainedAuditEvent } = require('../services/auditChainHasher');

      await applyContractEvent(prisma as any, event);

      expect(prisma.contractAdmin.upsert).toHaveBeenCalledWith({
        where: {
          chainId_address: {
            chainId,
            address: event.admin.toLowerCase(),
          },
        },
        update: { enabled: false },
        create: {
          chainId,
          address: event.admin.toLowerCase(),
          enabled: false,
        },
      });

      expect(writeChainedAuditEvent).toHaveBeenCalledWith(prisma, expect.objectContaining({
        eventType: 'CONTRACT_ADMIN_UPDATED',
        walletId: event.admin.toLowerCase(),
        beforeState: { enabled: true },
        afterState: { enabled: false },
      }));
    });

    test('should handle OwnershipTransferProposed event', async () => {
      const event: DecodedContractEvent = {
        type: 'OwnershipTransferProposed',
        currentOwner: '0xCurrentOwnerAddress1234567890123456',
        proposedOwner: '0xProposedOwnerAddress1234567890123456',
        chainId,
        transactionHash,
        blockHash,
        logIndex,
        blockNumber,
      };

      prisma.processedEvent.findUnique.mockResolvedValue(null);
      prisma.contractOwnership.findUnique.mockResolvedValue(null);
      prisma.contractOwnership.upsert.mockResolvedValue({
        chainId,
        owner: event.currentOwner.toLowerCase(),
        proposedOwner: event.proposedOwner.toLowerCase(),
      });

      const { writeChainedAuditEvent } = require('../services/auditChainHasher');

      await applyContractEvent(prisma as any, event);

      expect(prisma.contractOwnership.upsert).toHaveBeenCalledWith({
        where: { chainId },
        update: { proposedOwner: event.proposedOwner.toLowerCase() },
        create: {
          chainId,
          owner: event.currentOwner.toLowerCase(),
          proposedOwner: event.proposedOwner.toLowerCase(),
        },
      });

      expect(writeChainedAuditEvent).toHaveBeenCalledWith(prisma, expect.objectContaining({
        eventType: 'CONTRACT_OWNERSHIP_TRANSFERRED',
        walletId: event.proposedOwner.toLowerCase(),
        afterState: {
          owner: event.currentOwner.toLowerCase(),
          proposedOwner: event.proposedOwner.toLowerCase(),
        },
      }));
    });

    test('should handle OwnershipTransferred event', async () => {
      const event: DecodedContractEvent = {
        type: 'OwnershipTransferred',
        previousOwner: '0xPreviousOwnerAddress1234567890123456',
        newOwner: '0xNewOwnerAddress1234567890123456',
        chainId,
        transactionHash,
        blockHash,
        logIndex,
        blockNumber,
      };

      prisma.processedEvent.findUnique.mockResolvedValue(null);
      prisma.contractOwnership.findUnique.mockResolvedValue({
        chainId,
        owner: event.previousOwner.toLowerCase(),
        proposedOwner: event.newOwner.toLowerCase(),
      });
      prisma.contractOwnership.upsert.mockResolvedValue({
        chainId,
        owner: event.newOwner.toLowerCase(),
        proposedOwner: null,
      });

      const { writeChainedAuditEvent } = require('../services/auditChainHasher');

      await applyContractEvent(prisma as any, event);

      expect(prisma.contractOwnership.upsert).toHaveBeenCalledWith({
        where: { chainId },
        update: {
          owner: event.newOwner.toLowerCase(),
          proposedOwner: null,
        },
        create: {
          chainId,
          owner: event.newOwner.toLowerCase(),
          proposedOwner: null,
        },
      });

      expect(writeChainedAuditEvent).toHaveBeenCalledWith(prisma, expect.objectContaining({
        eventType: 'CONTRACT_OWNERSHIP_TRANSFERRED',
        walletId: event.newOwner.toLowerCase(),
        beforeState: {
          owner: event.previousOwner.toLowerCase(),
          proposedOwner: event.newOwner.toLowerCase(),
        },
        afterState: {
          owner: event.newOwner.toLowerCase(),
          proposedOwner: null,
        },
      }));
    });

    test('should skip duplicate events (idempotency)', async () => {
      const event: DecodedContractEvent = {
        type: 'AdminUpdated',
        admin: '0xAdminAddress12345678901234567890123456',
        enabled: true,
        chainId,
        transactionHash,
        blockHash,
        logIndex,
        blockNumber,
      };

      prisma.processedEvent.findUnique.mockResolvedValue({
        transactionHash,
        logIndex,
        blockHash,
        blockNumber,
        eventType: 'AdminUpdated',
      });

      await applyContractEvent(prisma as any, event);

      expect(prisma.contractAdmin.upsert).not.toHaveBeenCalled();
      expect(prisma.processedEvent.create).not.toHaveBeenCalled();
    });
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
      communityContract: { upsert: jest.fn() },
      member: { upsert: jest.fn().mockResolvedValue({ id: 'member-1' }) },
      membership: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest
          .fn()
          .mockResolvedValue({
            id: 'membership-1',
            tokenId: 7,
            state: 'active',
            expiresAt: new Date(2000 * 1000),
          }),
      },
      membershipToken: {
        upsert: jest.fn().mockResolvedValue({
          id: 'token-1',
          tokenId: 7,
          chainId: 1,
          contractAddress: '0x0000000000000000000000000000000000000000',
          state: 'active',
          expiresAt: new Date(2000 * 1000),
        }),
        findUnique: jest.fn().mockResolvedValue(null),
      },
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
