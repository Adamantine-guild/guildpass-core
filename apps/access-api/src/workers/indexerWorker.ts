import { PrismaClient } from '@prisma/client';
import { applyContractEvent, DecodedContractEvent } from '../services/contractEventHelpers';
import { getPrisma } from '../services/prisma';

export interface BlockInfo {
  number: number;
  hash: string;
  parentHash: string;
}

export interface ChainAdapterConfig {
  chainId: number;
  rpcUrl?: string;
  membershipNftAddress: string;
  name?: string;
}

export interface ChainProvider {
  getLatestBlockNumber(): Promise<number>;
  getBlock(blockNumber: number): Promise<BlockInfo>;
  getLogs(fromBlock: number, toBlock: number): Promise<DecodedContractEvent[]>;
}

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

export function indexerStateId(config: ChainAdapterConfig): string {
  return `${config.chainId}:${normalizeAddress(config.membershipNftAddress)}`;
}

export class IndexerWorker {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  public readonly confirmationDepth: number;

  constructor(
    private readonly prisma: PrismaClient = getPrisma(),
    private readonly provider: ChainProvider,
    private readonly intervalMs: number = 5000,
    private readonly finalityWindow: number = 12,
    private readonly chainConfig: ChainAdapterConfig = {
      chainId: Number(process.env.CHAIN_ID || '31337'),
      membershipNftAddress: process.env.MEMBERSHIP_NFT_ADDRESS || '0x0000000000000000000000000000000000000000',
    },
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.runPass(), this.intervalMs);
    console.info(
      `IndexerWorker started for chain ${this.chainConfig.chainId} contract ${this.chainConfig.membershipNftAddress} (interval: ${this.intervalMs}ms, finalityWindow: ${this.finalityWindow})`,
    );
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.info(`IndexerWorker stopped for chain ${this.chainConfig.chainId}`);
  }

  async runPass() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      await this.processBlocks();
    } catch (error) {
      console.error(`IndexerWorker error in runPass for chain ${this.chainConfig.chainId}:`, error);
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
    const stateId = indexerStateId(this.chainConfig);

    const state = await this.prisma.indexerState.findUnique({
      where: { id: stateId },
    });

    const lastBlockNum = checkpoint
      ? checkpoint.lastProcessedBlockNumber !== undefined && checkpoint.lastProcessedBlockNumber !== 0
        ? checkpoint.lastProcessedBlockNumber
        : checkpoint.lastProcessedBlock
      : safeBlockNumber - 1;

    if (currentBlock > safeBlockNumber) {
      return;
    }

    if (state) {
      const lastProcessedBlock = await this.provider.getBlock(state.lastBlockNumber);
      if (lastProcessedBlock.hash !== state.lastBlockHash) {
        console.warn(
          `REORG DETECTED on chain ${this.chainConfig.chainId} at block ${state.lastBlockNumber}. Expected ${state.lastBlockHash}, got ${lastProcessedBlock.hash}`,
        );
        await this.handleReorg(state.lastBlockNumber);
        return;
      }
    }

    const toBlock = Math.min(currentBlock + 100, safeBlockNumber);
    console.info(`Indexer scanning chain ${this.chainConfig.chainId} blocks ${currentBlock} to ${toBlock}`);

    const toBlock = Math.min(currentBlock + this.batchSize - 1, safeBlockNumber);
    await this.processBlockRange(currentBlock, toBlock);
  }

  private async processBlockRange(fromBlock: number, toBlock: number) {
    console.info(`Indexer scanning blocks ${fromBlock} to ${toBlock} on chain ${this.chainId}`);
    const logs = await this.provider.getLogs(fromBlock, toBlock);

    const sortedLogs = [...logs].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return (a.blockNumber || 0) - (b.blockNumber || 0);
      }
      return (a.logIndex || 0) - (b.logIndex || 0);
    });

    for (const log of sortedLogs) {
      await applyContractEvent(this.prisma, {
        ...log,
        chainId: this.chainConfig.chainId,
      });
    }

    const lastBlock = await this.provider.getBlock(toBlock);
    await this.prisma.indexerState.upsert({
      where: { id: stateId },
      update: {
        chainId: this.chainConfig.chainId,
        contractAddress: normalizeAddress(this.chainConfig.membershipNftAddress),
        lastBlockNumber: toBlock,
        lastBlockHash: lastBlock.hash,
      },
      create: {
        id: stateId,
        chainId: this.chainConfig.chainId,
        contractAddress: normalizeAddress(this.chainConfig.membershipNftAddress),
        lastBlockNumber: toBlock,
        lastBlockHash: lastBlock.hash,
      },
    });
  }

  private async handleReorg(lastProcessedBlockNumber: number) {
    const rewindTo = Math.max(0, lastProcessedBlockNumber - this.finalityWindow * 2);
    const block = await this.provider.getBlock(rewindTo);
    const stateId = indexerStateId(this.chainConfig);

    await this.prisma.$transaction(async (tx) => {
      await tx.indexerState.update({
        where: { id: stateId },
        data: {
          lastBlockNumber: rewindTo,
          lastBlockHash: block.hash,
        },
      });

      await tx.processedEvent.deleteMany({
        where: {
          chainId: this.chainConfig.chainId,
          blockNumber: { gt: rewindTo },
        },
      });

    console.info(`Rewound indexer for chain ${this.chainConfig.chainId} to block ${rewindTo} due to reorg`);
  }
}

export function createIndexerWorker(
  provider: ChainProvider,
  intervalMs?: number,
  confirmationDepth?: number,
  prisma?: PrismaClient,
  chainConfig?: ChainAdapterConfig,
) {
  return new IndexerWorker(prisma, provider, intervalMs, finalityWindow, chainConfig);
}

export class MultiChainIndexerWorker {
  constructor(private readonly workers: IndexerWorker[]) {}

  start() {
    this.workers.forEach((worker) => worker.start());
  }

  stop() {
    this.workers.forEach((worker) => worker.stop());
  }
}

export function createMultiChainIndexerWorker(
  chainWorkers: Array<{ provider: ChainProvider; chainConfig: ChainAdapterConfig }>,
  intervalMs?: number,
  finalityWindow?: number,
  prisma?: PrismaClient,
) {
  return new MultiChainIndexerWorker(
    chainWorkers.map(({ provider, chainConfig }) => new IndexerWorker(prisma, provider, intervalMs, finalityWindow, chainConfig)),
  );
}
