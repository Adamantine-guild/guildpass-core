/**
 * indexerWorker.ts
 *
 * Multi-chain contract-event indexer with reorg-safe checkpoints.
 *
 * Reorg recovery (#144): rather than unconditionally rewinding by
 * `finalityWindow * 2`, we walk a persisted rolling window of block hashes
 * (`BlockHeader`) backward until the provider's current hash matches —
 * the true common ancestor — then delete and re-process only blocks after
 * that point. A configurable max search depth bounds work on catastrophic
 * reorgs and surfaces a clear operational error instead of silently
 * under-rewinding.
 */

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

export interface IndexerWorkerOptions {
  intervalMs?: number;
  finalityWindow?: number;
  /** Max blocks to walk back when seeking a common ancestor. Default: finalityWindow * 16. */
  maxReorgSearchDepth?: number;
  /** How many recent block hashes to retain in BlockHeader. Default: 1000. */
  blockHeaderRetention?: number;
  batchSize?: number;
  chainConfig?: ChainAdapterConfig;
}

/** Thrown when no common ancestor is found within `maxReorgSearchDepth`. */
export class ReorgTooDeepError extends Error {
  readonly code = 'REORG_TOO_DEEP' as const;
  readonly chainId: number;
  readonly lastKnownBlock: number;
  readonly maxSearchDepth: number;

  constructor(args: {
    chainId: number;
    lastKnownBlock: number;
    maxSearchDepth: number;
  }) {
    super(
      `REORG TOO DEEP on chain ${args.chainId}: no common ancestor within ` +
        `${args.maxSearchDepth} blocks of tip ${args.lastKnownBlock}. ` +
        `Manual intervention required — refusing to silently under-rewind.`,
    );
    this.name = 'ReorgTooDeepError';
    this.chainId = args.chainId;
    this.lastKnownBlock = args.lastKnownBlock;
    this.maxSearchDepth = args.maxSearchDepth;
  }
}

export interface CommonAncestorResult {
  blockNumber: number;
  blockHash: string;
  depth: number;
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

  private readonly intervalMs: number;
  private readonly finalityWindow: number;
  private readonly maxReorgSearchDepth: number;
  private readonly blockHeaderRetention: number;
  private readonly batchSize: number;
  private readonly chainConfig: ChainAdapterConfig;

  /** Alias used by older call sites / tests. */
  public readonly confirmationDepth: number;

  constructor(
    private readonly prisma: PrismaClient = getPrisma(),
    private readonly provider: ChainProvider,
    intervalMsOrOptions: number | IndexerWorkerOptions = 5000,
    finalityWindow: number = 12,
    chainConfig: ChainAdapterConfig = {
      chainId: Number(process.env.CHAIN_ID || '31337'),
      membershipNftAddress:
        process.env.MEMBERSHIP_NFT_ADDRESS ||
        '0x0000000000000000000000000000000000000000',
    },
    batchSize: number = 100,
  ) {
    if (typeof intervalMsOrOptions === 'object' && intervalMsOrOptions) {
      const opts = intervalMsOrOptions;
      this.intervalMs = opts.intervalMs ?? 5000;
      this.finalityWindow = opts.finalityWindow ?? 12;
      this.maxReorgSearchDepth =
        opts.maxReorgSearchDepth ?? this.finalityWindow * 16;
      this.blockHeaderRetention = opts.blockHeaderRetention ?? 1000;
      this.batchSize = opts.batchSize ?? 100;
      this.chainConfig = opts.chainConfig ?? chainConfig;
    } else {
      this.intervalMs = intervalMsOrOptions;
      this.finalityWindow = finalityWindow;
      this.maxReorgSearchDepth = finalityWindow * 16;
      this.blockHeaderRetention = 1000;
      this.batchSize = batchSize;
      this.chainConfig = chainConfig;
    }
    this.confirmationDepth = this.finalityWindow;
  }

  get chainId(): number {
    return this.chainConfig.chainId;
  }

  get contractAddress(): string {
    return normalizeAddress(this.chainConfig.membershipNftAddress);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.runPass(), this.intervalMs);
    console.info(
      `IndexerWorker started for chain ${this.chainConfig.chainId} contract ${this.contractAddress} ` +
        `(interval: ${this.intervalMs}ms, finalityWindow: ${this.finalityWindow}, maxReorgSearchDepth: ${this.maxReorgSearchDepth})`,
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
      console.error(
        `IndexerWorker error in runPass for chain ${this.chainConfig.chainId}:`,
        error,
      );
    } finally {
      this.isRunning = false;
    }
  }

  async backfill(fromBlock: number, toBlock: number) {
    console.info(
      `Starting indexer backfill on chain ${this.chainId} from block ${fromBlock} to ${toBlock}`,
    );
    let current = fromBlock;
    while (current <= toBlock) {
      const batchEnd = Math.min(current + this.batchSize - 1, toBlock);
      await this.processBlockRange(current, batchEnd);
      current = batchEnd + 1;
    }
    console.info(`Backfill completed on chain ${this.chainId} up to block ${toBlock}`);
  }

  /**
   * Walk backward from `fromBlock` comparing persisted `BlockHeader` hashes to
   * the provider's current chain until they match. Bounded by
   * `maxReorgSearchDepth`; throws `ReorgTooDeepError` if no ancestor is found.
   */
  async findCommonAncestor(
    fromBlock: number,
    options: { maxSearchDepth?: number } = {},
  ): Promise<CommonAncestorResult> {
    const maxDepth = options.maxSearchDepth ?? this.maxReorgSearchDepth;
    let candidate = fromBlock - 1;
    let depth = 1;

    while (candidate >= 0 && depth <= maxDepth) {
      const providerBlock = await this.provider.getBlock(candidate);
      const storedHeader = await this.prisma.blockHeader.findUnique({
        where: {
          chainId_blockNumber: {
            chainId: this.chainConfig.chainId,
            blockNumber: candidate,
          },
        },
      });

      if (storedHeader && storedHeader.blockHash === providerBlock.hash) {
        return {
          blockNumber: candidate,
          blockHash: providerBlock.hash,
          depth,
        };
      }

      candidate -= 1;
      depth += 1;
    }

    throw new ReorgTooDeepError({
      chainId: this.chainConfig.chainId,
      lastKnownBlock: fromBlock,
      maxSearchDepth: maxDepth,
    });
  }

  private async processBlocks() {
    const latestBlockNumber = await this.provider.getLatestBlockNumber();
    const safeBlockNumber = latestBlockNumber - this.finalityWindow;
    const stateId = indexerStateId(this.chainConfig);

    const state = await this.prisma.indexerState.findUnique({
      where: { id: stateId },
    });

    const lastBlockNum = state ? state.lastBlockNumber : safeBlockNumber - 1;
    const currentBlock = state ? lastBlockNum + 1 : safeBlockNumber;

    try {
      const { metrics } = require('../observability/metrics');
      metrics.indexerLag.set(
        { chain_id: String(this.chainConfig.chainId) },
        Math.max(0, latestBlockNumber - lastBlockNum),
      );
    } catch {
      // Metrics optional in unit tests that don't load the registry.
    }

    if (currentBlock > safeBlockNumber) {
      return;
    }

    if (state) {
      const lastProcessedBlock = await this.provider.getBlock(state.lastBlockNumber);
      if (lastProcessedBlock.hash !== state.lastBlockHash) {
        console.warn(
          `REORG DETECTED on chain ${this.chainConfig.chainId} at block ${state.lastBlockNumber}. ` +
            `Expected ${state.lastBlockHash}, got ${lastProcessedBlock.hash}`,
        );
        await this.handleReorg(state.lastBlockNumber);
        return;
      }
    }

    const toBlock = Math.min(currentBlock + this.batchSize - 1, safeBlockNumber);
    await this.processBlockRange(currentBlock, toBlock);
  }

  private async processBlockRange(fromBlock: number, toBlock: number) {
    console.info(
      `Indexer scanning chain ${this.chainConfig.chainId} blocks ${fromBlock} to ${toBlock}`,
    );
    const logs = await this.provider.getLogs(fromBlock, toBlock);
    const stateId = indexerStateId(this.chainConfig);

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

    // Persist rolling block-hash history for LCA seeking (#144).
    for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
      const block = await this.provider.getBlock(blockNum);
      await this.prisma.blockHeader.upsert({
        where: {
          chainId_blockNumber: {
            chainId: this.chainConfig.chainId,
            blockNumber: blockNum,
          },
        },
        update: { blockHash: block.hash },
        create: {
          chainId: this.chainConfig.chainId,
          blockNumber: blockNum,
          blockHash: block.hash,
        },
      });
    }

    const lastBlock = await this.provider.getBlock(toBlock);
    await this.prisma.indexerState.upsert({
      where: { id: stateId },
      update: {
        chainId: this.chainConfig.chainId,
        contractAddress: this.contractAddress,
        lastBlockNumber: toBlock,
        lastBlockHash: lastBlock.hash,
      },
      create: {
        id: stateId,
        chainId: this.chainConfig.chainId,
        contractAddress: this.contractAddress,
        lastBlockNumber: toBlock,
        lastBlockHash: lastBlock.hash,
      },
    });

    const pruneThreshold = toBlock - this.blockHeaderRetention;
    if (pruneThreshold > 0) {
      await this.prisma.blockHeader.deleteMany({
        where: {
          chainId: this.chainConfig.chainId,
          blockNumber: { lt: pruneThreshold },
        },
      });
    }
  }

  private async handleReorg(lastProcessedBlockNumber: number) {
    let endTimer: (() => void) | undefined;
    try {
      const { metrics } = require('../observability/metrics');
      metrics.indexerReorgsDetectedTotal?.inc?.({
        chain_id: String(this.chainConfig.chainId),
      });
      endTimer = metrics.indexerReconciliationDuration?.startTimer?.({
        chain_id: String(this.chainConfig.chainId),
      });
    } catch {
      // optional
    }

    try {
      const ancestor = await this.findCommonAncestor(lastProcessedBlockNumber);
      const rewindTo = ancestor.blockNumber;
      const stateId = indexerStateId(this.chainConfig);

      await this.prisma.$transaction(async (tx) => {
        await tx.indexerState.update({
          where: { id: stateId },
          data: {
            lastBlockNumber: rewindTo,
            lastBlockHash: ancestor.blockHash,
          },
        });

        // Only drop events / headers after the true common ancestor —
        // unaffected blocks are left alone (#144).
        await tx.processedEvent.deleteMany({
          where: {
            chainId: this.chainConfig.chainId,
            blockNumber: { gt: rewindTo },
          },
        });

        await tx.blockHeader.deleteMany({
          where: {
            chainId: this.chainConfig.chainId,
            blockNumber: { gt: rewindTo },
          },
        });
      });

      console.info(
        `Rewound indexer for chain ${this.chainConfig.chainId} to common ancestor ` +
          `block ${rewindTo} (reorg depth ${ancestor.depth})`,
      );
    } catch (error) {
      if (error instanceof ReorgTooDeepError) {
        console.error(
          `[OPERATIONAL ALERT] ${error.message}`,
        );
      }
      throw error;
    } finally {
      endTimer?.();
    }
  }
}

export function createIndexerWorker(
  provider: ChainProvider,
  intervalMs?: number,
  confirmationDepth?: number,
  prisma?: PrismaClient,
  chainIdOrConfig?: number | ChainAdapterConfig,
  batchSize?: number,
  contractAddress?: string,
) {
  const chainConfig: ChainAdapterConfig =
    typeof chainIdOrConfig === 'object' && chainIdOrConfig !== null
      ? chainIdOrConfig
      : {
          chainId:
            typeof chainIdOrConfig === 'number'
              ? chainIdOrConfig
              : Number(process.env.CHAIN_ID || '31337'),
          membershipNftAddress:
            contractAddress ||
            process.env.MEMBERSHIP_NFT_ADDRESS ||
            '0x0000000000000000000000000000000000000000',
        };

  return new IndexerWorker(
    prisma ?? getPrisma(),
    provider,
    {
      intervalMs,
      finalityWindow: confirmationDepth,
      batchSize,
      chainConfig,
    },
  );
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
    chainWorkers.map(
      ({ provider, chainConfig }) =>
        new IndexerWorker(prisma ?? getPrisma(), provider, {
          intervalMs,
          finalityWindow,
          chainConfig,
        }),
    ),
  );
}
