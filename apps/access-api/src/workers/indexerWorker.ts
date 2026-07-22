import { PrismaClient } from '@prisma/client';
import { applyContractEvent, DecodedContractEvent } from '../services/contractEventHelpers';
import { getPrisma } from '../services/prisma';

export interface BlockInfo {
  number: number;
  hash: string;
  parentHash: string;
}

export interface ChainProvider {
  getLatestBlockNumber(): Promise<number>;
  getBlock(blockNumber: number): Promise<BlockInfo>;
  getLogs(fromBlock: number, toBlock: number): Promise<DecodedContractEvent[]>;
}

export class IndexerWorker {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaClient = getPrisma(),
    private readonly provider: ChainProvider,
    private readonly intervalMs: number = 5000,
    private readonly finalityWindow: number = 12,
    public readonly chainId: number = 31337,
    private readonly batchSize: number = 100,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.runPass(), this.intervalMs);
    console.info(`IndexerWorker started for chain ${this.chainId} (interval: ${this.intervalMs}ms, finalityWindow: ${this.finalityWindow})`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.info('IndexerWorker stopped');
  }

  async runPass() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      await this.processBlocks();
    } catch (error) {
      console.error('IndexerWorker error in runPass:', error);
    } finally {
      this.isRunning = false;
    }
  }

  async backfill(fromBlock: number, toBlock: number) {
    console.info(`Starting indexer backfill on chain ${this.chainId} from block ${fromBlock} to ${toBlock}`);
    let current = fromBlock;
    while (current <= toBlock) {
      const batchEnd = Math.min(current + this.batchSize - 1, toBlock);
      await this.processBlockRange(current, batchEnd);
      current = batchEnd + 1;
    }
    console.info(`Backfill completed on chain ${this.chainId} up to block ${toBlock}`);
  }

  private async processBlocks() {
    const latestBlockNumber = await this.provider.getLatestBlockNumber();
    const safeBlockNumber = latestBlockNumber - this.finalityWindow;

    const checkpoint = await this.prisma.indexerCheckpoint.findUnique({
      where: { chainId: this.chainId },
    });

    let currentBlock = checkpoint ? checkpoint.lastProcessedBlock + 1 : safeBlockNumber;

    // Record lag metric
    const processedBlock = checkpoint ? checkpoint.lastProcessedBlock : safeBlockNumber - 1;
    const lag = Math.max(0, latestBlockNumber - processedBlock);
    const { metrics } = require('../observability/metrics');
    metrics.indexerLag.set({ chain_id: String(this.chainId) }, lag);

    // If we are already beyond safe block, wait.
    if (currentBlock > safeBlockNumber) {
      return;
    }

    // Reorg Detection
    if (checkpoint) {
      const lastProcessedBlockInfo = await this.provider.getBlock(checkpoint.lastProcessedBlock);
      if (lastProcessedBlockInfo.hash !== checkpoint.lastProcessedBlockHash) {
        console.warn(`REORG DETECTED on chain ${this.chainId} at block ${checkpoint.lastProcessedBlock}. Expected ${checkpoint.lastProcessedBlockHash}, got ${lastProcessedBlockInfo.hash}`);
        await this.handleReorg(checkpoint.lastProcessedBlock);
        return;
      }
    }

    const toBlock = Math.min(currentBlock + this.batchSize - 1, safeBlockNumber);
    await this.processBlockRange(currentBlock, toBlock);
  }

  private async processBlockRange(fromBlock: number, toBlock: number) {
    console.info(`Indexer scanning blocks ${fromBlock} to ${toBlock} on chain ${this.chainId}`);
    const logs = await this.provider.getLogs(fromBlock, toBlock);

    // Sort logs by block number and log index to ensure ordered application
    const sortedLogs = [...logs].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return (a.blockNumber || 0) - (b.blockNumber || 0);
      }
      return (a.logIndex || 0) - (b.logIndex || 0);
    });

    await this.prisma.$transaction(async (tx) => {
      for (const log of sortedLogs) {
        await applyContractEvent(tx as any, log);
      }

      // Record block headers for LCA checking
      for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
        const block = await this.provider.getBlock(blockNum);
        await tx.blockHeader.upsert({
          where: {
            chainId_blockNumber: {
              chainId: this.chainId,
              blockNumber: blockNum,
            },
          },
          update: { blockHash: block.hash },
          create: {
            chainId: this.chainId,
            blockNumber: blockNum,
            blockHash: block.hash,
          },
        });
      }

      // Update checkpoint
      const lastBlock = await this.provider.getBlock(toBlock);
      await tx.indexerCheckpoint.upsert({
        where: { chainId: this.chainId },
        update: {
          lastProcessedBlock: toBlock,
          lastProcessedBlockHash: lastBlock.hash,
        },
        create: {
          chainId: this.chainId,
          lastProcessedBlock: toBlock,
          lastProcessedBlockHash: lastBlock.hash,
        },
      });

      // Prune old block headers (keep recent 1000 blocks to prevent unbounded DB growth)
      const pruneThreshold = toBlock - 1000;
      if (pruneThreshold > 0) {
        await tx.blockHeader.deleteMany({
          where: {
            chainId: this.chainId,
            blockNumber: { lt: pruneThreshold },
          },
        });
      }
    });
  }

  private async handleReorg(lastProcessedBlockNumber: number) {
    let commonAncestor = lastProcessedBlockNumber - 1;
    let found = false;

    // Walk back to find the Last Common Ancestor (LCA)
    while (commonAncestor > 0) {
      const providerBlock = await this.provider.getBlock(commonAncestor);
      const storedHeader = await this.prisma.blockHeader.findUnique({
        where: {
          chainId_blockNumber: {
            chainId: this.chainId,
            blockNumber: commonAncestor,
          },
        },
      });

      if (storedHeader && storedHeader.blockHash === providerBlock.hash) {
        found = true;
        break;
      }
      commonAncestor--;
    }

    // Default fallback if no common ancestor is found
    const rewindTo = found ? commonAncestor : Math.max(0, lastProcessedBlockNumber - this.finalityWindow * 2);
    const block = await this.provider.getBlock(rewindTo);

    await this.prisma.$transaction(async (tx) => {
      await tx.indexerCheckpoint.upsert({
        where: { chainId: this.chainId },
        update: {
          lastProcessedBlock: rewindTo,
          lastProcessedBlockHash: block.hash,
        },
        create: {
          chainId: this.chainId,
          lastProcessedBlock: rewindTo,
          lastProcessedBlockHash: block.hash,
        },
      });

      // Prune processed events after reorg point to trigger re-processing
      await tx.processedEvent.deleteMany({
        where: {
          blockNumber: { gt: rewindTo },
        },
      });

      // Clear block headers past the common ancestor
      await tx.blockHeader.deleteMany({
        where: {
          chainId: this.chainId,
          blockNumber: { gt: rewindTo },
        },
      });
    });

    console.info(`Rewound indexer on chain ${this.chainId} to block ${rewindTo} due to reorg (LCA found: ${found})`);
  }
}

export function createIndexerWorker(
  provider: ChainProvider,
  intervalMs?: number,
  finalityWindow?: number,
  prisma?: PrismaClient,
  chainId?: number,
  batchSize?: number,
) {
  return new IndexerWorker(prisma, provider, intervalMs, finalityWindow, chainId, batchSize);
}
