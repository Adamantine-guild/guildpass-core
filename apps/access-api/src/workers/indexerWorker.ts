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
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.runPass(), this.intervalMs);
    console.info(`IndexerWorker started (interval: ${this.intervalMs}ms, finalityWindow: ${this.finalityWindow})`);
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

  private async processBlocks() {
    const latestBlockNumber = await this.provider.getLatestBlockNumber();
    const safeBlockNumber = latestBlockNumber - this.finalityWindow;

    const state = await this.prisma.indexerState.findUnique({
      where: { id: 'singleton' },
    });

    let currentBlock = state ? state.lastBlockNumber + 1 : safeBlockNumber;

    // If we are already beyond safe block, wait.
    if (currentBlock > safeBlockNumber) {
      return;
    }

    // Reorg Detection
    if (state) {
      const lastProcessedBlock = await this.provider.getBlock(state.lastBlockNumber);
      if (lastProcessedBlock.hash !== state.lastBlockHash) {
        console.warn(`REORG DETECTED at block ${state.lastBlockNumber}. Expected ${state.lastBlockHash}, got ${lastProcessedBlock.hash}`);
        await this.handleReorg(state.lastBlockNumber);
        return;
      }
    }

    // Process blocks in batches
    const toBlock = Math.min(currentBlock + 100, safeBlockNumber);
    console.info(`Indexer scanning blocks ${currentBlock} to ${toBlock}`);

    const logs = await this.provider.getLogs(currentBlock, toBlock);

    // Sort logs by block number and log index to ensure ordered application
    const sortedLogs = [...logs].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return (a.blockNumber || 0) - (b.blockNumber || 0);
      }
      return (a.logIndex || 0) - (b.logIndex || 0);
    });

    for (const log of sortedLogs) {
      await applyContractEvent(this.prisma, log);
    }

    // Update checkpoint
    const lastBlock = await this.provider.getBlock(toBlock);
    await this.prisma.indexerState.upsert({
      where: { id: 'singleton' },
      update: {
        lastBlockNumber: toBlock,
        lastBlockHash: lastBlock.hash,
      },
      create: {
        id: 'singleton',
        lastBlockNumber: toBlock,
        lastBlockHash: lastBlock.hash,
      },
    });
  }

  private async handleReorg(lastProcessedBlockNumber: number) {
    // Simple reorg handling: Rewind checkpoint by a safe amount or to last known good block.
    // In a real implementation, we might want to find the common ancestor.
    // For now, we rewind by the finality window to re-process and let idempotency handle it.
    const rewindTo = Math.max(0, lastProcessedBlockNumber - this.finalityWindow * 2);
    const block = await this.provider.getBlock(rewindTo);

    await this.prisma.$transaction(async (tx) => {
      await tx.indexerState.update({
        where: { id: 'singleton' },
        data: {
          lastBlockNumber: rewindTo,
          lastBlockHash: block.hash,
        },
      });

      // Optional: Delete processed events after the reorg point to allow re-processing
      // Note: applyContractEvent uses transactionHash_logIndex for idempotency,
      // but in a reorg, these might be in different blocks or even different hashes.
      // If we want to fully re-process, we should remove them from ProcessedEvent.
      await tx.processedEvent.deleteMany({
        where: {
          blockNumber: { gt: rewindTo },
        },
      });
    });

    console.info(`Rewound indexer to block ${rewindTo} due to reorg`);
  }
}

export function createIndexerWorker(
  provider: ChainProvider,
  intervalMs?: number,
  finalityWindow?: number,
  prisma?: PrismaClient,
) {
  return new IndexerWorker(prisma, provider, intervalMs, finalityWindow);
}
