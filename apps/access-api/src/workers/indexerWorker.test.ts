import { IndexerWorker, ChainProvider } from './indexerWorker';
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
      startTimer: jest.fn().mockReturnValue(jest.fn()),
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

    worker = new IndexerWorker(prisma as any, provider, 5000, 12, chainId, 100, contractAddress);
    jest.clearAllMocks();
  });

  test('should process blocks and update indexerCheckpoint per chain & contract', async () => {
    provider.getLatestBlockNumber.mockResolvedValue(100);
    prisma.indexerCheckpoint.findUnique.mockResolvedValue({
      chainId,
      contractAddress,
      lastProcessedBlock: 80,
      lastProcessedBlockNumber: 80,
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
      create: expect.objectContaining({ chainId, contractAddress, lastProcessedBlockNumber: 88 }),
    }));
    expect(metrics.indexerLag.set).toHaveBeenCalledWith({ chain_id: String(chainId) }, 20); // 100 - 80 = 20
  });

  test('should detect reorg, trigger reconciliation duration metric, and rewind to LCA', async () => {
    provider.getLatestBlockNumber.mockResolvedValue(100);
    prisma.indexerCheckpoint.findUnique.mockResolvedValue({
      chainId,
      contractAddress,
      lastProcessedBlock: 80,
      lastProcessedBlockNumber: 80,
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

    // Reorg metrics should be triggered
    expect(metrics.indexerReorgsDetectedTotal.inc).toHaveBeenCalledWith({ chain_id: String(chainId) });
    expect(metrics.indexerReconciliationDuration.startTimer).toHaveBeenCalledWith({ chain_id: String(chainId) });

    // Checkpoint should be updated to block 78 (common ancestor)
    expect(prisma.indexerCheckpoint.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ lastProcessedBlockNumber: 78, lastProcessedBlockHash: 'hash78' }),
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

    expect(provider.getLogs).toHaveBeenCalledTimes(3);
    expect(provider.getLogs).toHaveBeenNthCalledWith(1, 50, 149);
    expect(provider.getLogs).toHaveBeenNthCalledWith(2, 150, 249);
    expect(provider.getLogs).toHaveBeenNthCalledWith(3, 250, 250);
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
