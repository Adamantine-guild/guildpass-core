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
  public readonly confirmationDepth: number;

  constructor(
    private readonly prisma: PrismaClient = getPrisma(),
    private readonly provider: ChainProvider,
    private readonly intervalMs: number = 5000,
    finalityWindowOrDepth: number = 12,
    public readonly chainId: number = 31337,
    private readonly batchSize: number = 100,
    public readonly contractAddress: string = '0x0000000000000000000000000000000000000000',
  ) {
    this.confirmationDepth = finalityWindowOrDepth;
  }

  get finalityWindow(): number {
    return this.confirmationDepth;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.runPass(), this.intervalMs);
    console.info(
      `IndexerWorker started for chain ${this.chainId} (contract: ${this.contractAddress}, interval: ${this.intervalMs}ms, confirmationDepth: ${this.confirmationDepth})`,
    );
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
    const safeBlockNumber = latestBlockNumber - this.confirmationDepth;

    const checkpoint = await this.prisma.indexerCheckpoint.findUnique({
      where: {
        chainId_contractAddress: {
          chainId: this.chainId,
          contractAddress: this.contractAddress,
        },
      },
    });

    const lastBlockNum = checkpoint
      ? checkpoint.lastProcessedBlockNumber !== undefined && checkpoint.lastProcessedBlockNumber !== 0
        ? checkpoint.lastProcessedBlockNumber
        : checkpoint.lastProcessedBlock
      : safeBlockNumber - 1;

    let currentBlock = checkpoint ? lastBlockNum + 1 : safeBlockNumber;

    // Record lag metric
    const lag = Math.max(0, latestBlockNumber - lastBlockNum);
    const { metrics } = require('../observability/metrics');
    metrics.indexerLag.set({ chain_id: String(this.chainId) }, lag);

    // If we are already beyond safe block, wait.
    if (currentBlock > safeBlockNumber) {
      return;
    }

    // Reorg Detection
    if (checkpoint) {
      const lastProcessedBlockInfo = await this.provider.getBlock(lastBlockNum);
      if (lastProcessedBlockInfo.hash !== checkpoint.lastProcessedBlockHash) {
        console.warn(
          `REORG DETECTED on chain ${this.chainId} at block ${lastBlockNum}. Expected ${checkpoint.lastProcessedBlockHash}, got ${lastProcessedBlockInfo.hash}`,
        );
        await this.handleReorg(lastBlockNum);
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
        where: {
          chainId_contractAddress: {
            chainId: this.chainId,
            contractAddress: this.contractAddress,
          },
        },
        update: {
          lastProcessedBlock: toBlock,
          lastProcessedBlockNumber: toBlock,
          lastProcessedBlockHash: lastBlock.hash,
        },
        create: {
          chainId: this.chainId,
          contractAddress: this.contractAddress,
          lastProcessedBlock: toBlock,
          lastProcessedBlockNumber: toBlock,
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
    const { metrics } = require('../observability/metrics');
    metrics.indexerReorgsDetectedTotal.inc({ chain_id: String(this.chainId) });
    const endTimer = metrics.indexerReconciliationDuration.startTimer({ chain_id: String(this.chainId) });

    try {
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
      const rewindTo = found
        ? commonAncestor
        : Math.max(0, lastProcessedBlockNumber - this.confirmationDepth * 2);
      const block = await this.provider.getBlock(rewindTo);

      await this.prisma.$transaction(async (tx) => {
        // Reconcile state by rolling back state changes from orphaned events past rewindTo
        const orphanedAuditEvents = await tx.auditEvent.findMany({
          where: {
            blockNumber: { gt: rewindTo },
          },
          orderBy: { createdAt: 'desc' },
        });

        for (const audit of orphanedAuditEvents) {
          const beforeState = audit.beforeState as any;
          const afterState = audit.afterState as any;

          if (audit.eventType === 'MEMBERSHIP_CREATED' || audit.eventType === 'MEMBERSHIP_UPDATED') {
            const tokenId = afterState?.tokenId;
            if (tokenId !== undefined) {
              if (beforeState && beforeState.state) {
                await tx.membershipToken.updateMany({
                  where: { chainId: this.chainId, contractAddress: this.contractAddress, tokenId },
                  data: {
                    state: beforeState.state,
                    expiresAt: beforeState.expiresAt ? new Date(beforeState.expiresAt) : null,
                  },
                });
              } else if (audit.eventType === 'MEMBERSHIP_CREATED') {
                // Token was created in an orphaned block — remove it
                const orphanedTokens = await tx.membershipToken.findMany({
                  where: { chainId: this.chainId, contractAddress: this.contractAddress, tokenId },
                });
                const orphanedIds = orphanedTokens.map((t) => t.id);
                if (orphanedIds.length > 0) {
                  await tx.membership.updateMany({
                    where: { activeTokenId: { in: orphanedIds } },
                    data: { activeTokenId: null },
                  });
                }
                await tx.membershipToken.deleteMany({
                  where: { chainId: this.chainId, contractAddress: this.contractAddress, tokenId },
                });
              }
            }
          } else if (audit.eventType === 'CONTRACT_ADMIN_UPDATED') {
            if (audit.walletId) {
              if (beforeState && beforeState.enabled !== undefined) {
                await tx.contractAdmin.update({
                  where: { chainId_address: { chainId: this.chainId, address: audit.walletId } },
                  data: { enabled: beforeState.enabled },
                });
              } else {
                await tx.contractAdmin.deleteMany({
                  where: { chainId: this.chainId, address: audit.walletId },
                });
              }
            }
          } else if (audit.eventType === 'CONTRACT_OWNERSHIP_TRANSFERRED') {
            if (beforeState && beforeState.owner !== undefined) {
              await tx.contractOwnership.update({
                where: { chainId: this.chainId },
                data: {
                  owner: beforeState.owner,
                  proposedOwner: beforeState.proposedOwner ?? null,
                },
              });
            } else {
              await tx.contractOwnership.deleteMany({
                where: { chainId: this.chainId },
              });
            }
          }
        }

        // Delete audit and outbox events past rewindTo
        await tx.auditEvent.deleteMany({
          where: { blockNumber: { gt: rewindTo } },
        });

        await tx.outboxEvent.deleteMany({
          where: { blockNumber: { gt: rewindTo } },
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

        // Update checkpoint
        await tx.indexerCheckpoint.upsert({
          where: {
            chainId_contractAddress: {
              chainId: this.chainId,
              contractAddress: this.contractAddress,
            },
          },
          update: {
            lastProcessedBlock: rewindTo,
            lastProcessedBlockNumber: rewindTo,
            lastProcessedBlockHash: block.hash,
          },
          create: {
            chainId: this.chainId,
            contractAddress: this.contractAddress,
            lastProcessedBlock: rewindTo,
            lastProcessedBlockNumber: rewindTo,
            lastProcessedBlockHash: block.hash,
          },
        });
      });

      console.info(
        `Rewound indexer on chain ${this.chainId} (contract ${this.contractAddress}) to block ${rewindTo} due to reorg (LCA found: ${found})`,
      );
    } finally {
      endTimer();
    }
  }
}

export function createIndexerWorker(
  provider: ChainProvider,
  intervalMs?: number,
  confirmationDepth?: number,
  prisma?: PrismaClient,
  chainId?: number,
  batchSize?: number,
  contractAddress?: string,
) {
  return new IndexerWorker(prisma, provider, intervalMs, confirmationDepth, chainId, batchSize, contractAddress);
}
