/**
 * indexer.ts
 *
 * MembershipNFT Event Indexer
 *
 * Consumes MembershipMinted, MembershipRenewed, and MembershipSuspended events
 * from the configured MEMBERSHIP_NFT_ADDRESS and synchronizes membership state
 * into the access API database.
 *
 * Features:
 *   - Reads from configured RPC_URL, CHAIN_ID, and MEMBERSHIP_NFT_ADDRESS
 *   - Processes events in batches to avoid RPC rate limits
 *   - Persists indexing checkpoint to avoid duplicate processing
 *   - Idempotent: can be safely re-run without creating duplicate records
 *   - Graceful shutdown on SIGTERM/SIGINT
 *
 * Usage:
 *   npm run indexer          # Run once from current checkpoint
 *   npm run indexer -- --watch  # Continuous mode (future enhancement)
 */

import { ethers } from 'ethers';
import { MembershipNFTAbi, addresses } from '@guildpass/contracts';
import { getPrisma, disconnectPrisma } from '../services/prisma';
import { logger } from '../observability/logger';
import { MembershipState } from '@prisma/client';

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

interface IndexerConfig {
  rpcUrl: string;
  chainId: number;
  contractAddress: string;
  startBlock: number;
  batchSize: number;
}

function loadConfig(): IndexerConfig {
  const rpcUrl = process.env.RPC_URL;
  const chainId = parseInt(process.env.CHAIN_ID || '31337', 10);
  const contractAddress = process.env.MEMBERSHIP_NFT_ADDRESS || addresses.membershipNFT;
  const startBlock = parseInt(process.env.INDEXER_START_BLOCK || '0', 10);
  const batchSize = parseInt(process.env.INDEXER_BATCH_SIZE || '1000', 10);

  if (!rpcUrl) {
    throw new Error('RPC_URL is required');
  }
  if (!contractAddress) {
    throw new Error('MEMBERSHIP_NFT_ADDRESS is required');
  }

  return { rpcUrl, chainId, contractAddress, startBlock, batchSize };
}

// --------------------------------------------------------------------------
// Event Types
// --------------------------------------------------------------------------

interface MembershipMintedEvent {
  to: string;
  tokenId: bigint;
  communityId: string;
  expiresAt: bigint;
  blockNumber: number;
  transactionHash: string;
}

interface MembershipRenewedEvent {
  tokenId: bigint;
  newExpiresAt: bigint;
  blockNumber: number;
  transactionHash: string;
}

interface MembershipSuspendedEvent {
  tokenId: bigint;
  isSuspended: boolean;
  blockNumber: number;
  transactionHash: string;
}

// --------------------------------------------------------------------------
// Indexer Service
// --------------------------------------------------------------------------

class MembershipIndexer {
  private provider: ethers.JsonRpcProvider;
  private contract: ethers.Contract;
  private config: IndexerConfig;
  private prisma: ReturnType<typeof getPrisma>;
  private shouldStop = false;

  constructor(config: IndexerConfig) {
    this.config = config;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.contract = new ethers.Contract(
      config.contractAddress,
      MembershipNFTAbi,
      this.provider
    );
    this.prisma = getPrisma();
  }

  /**
   * Run the indexer once from the last checkpoint to current block
   */
  async run(): Promise<void> {
    logger.info(
      { config: this.config },
      'Starting MembershipNFT indexer'
    );

    try {
      const currentBlock = await this.provider.getBlockNumber();
      const checkpoint = await this.loadCheckpoint();
      const fromBlock = checkpoint ? Number(checkpoint.lastBlock) + 1 : this.config.startBlock;

      logger.info(
        { fromBlock, currentBlock, checkpoint: checkpoint?.lastBlock },
        'Loaded checkpoint'
      );

      if (fromBlock > currentBlock) {
        logger.info('Already synced to latest block');
        return;
      }

      await this.syncEvents(fromBlock, currentBlock);

      logger.info({ currentBlock }, 'Indexer run completed successfully');
    } catch (error) {
      logger.error({ err: error }, 'Indexer failed');
      throw error;
    }
  }

  /**
   * Sync events from fromBlock to toBlock in batches
   */
  private async syncEvents(fromBlock: number, toBlock: number): Promise<void> {
    let currentFrom = fromBlock;

    while (currentFrom <= toBlock && !this.shouldStop) {
      const currentTo = Math.min(currentFrom + this.config.batchSize - 1, toBlock);

      logger.info(
        { fromBlock: currentFrom, toBlock: currentTo },
        'Processing block range'
      );

      await this.processBatch(currentFrom, currentTo);

      // Update checkpoint after each successful batch
      await this.saveCheckpoint(currentTo);

      currentFrom = currentTo + 1;
    }
  }

  /**
   * Process a batch of blocks
   */
  private async processBatch(fromBlock: number, toBlock: number): Promise<void> {
    // Query all three event types in parallel
    const [mintedEvents, renewedEvents, suspendedEvents] = await Promise.all([
      this.contract.queryFilter('MembershipMinted', fromBlock, toBlock),
      this.contract.queryFilter('MembershipRenewed', fromBlock, toBlock),
      this.contract.queryFilter('MembershipSuspended', fromBlock, toBlock),
    ]);

    logger.info(
      {
        minted: mintedEvents.length,
        renewed: renewedEvents.length,
        suspended: suspendedEvents.length,
      },
      'Fetched events'
    );

    // Process events in order by block number and log index
    const allEvents = [
      ...mintedEvents.map(e => ({ type: 'minted' as const, event: e })),
      ...renewedEvents.map(e => ({ type: 'renewed' as const, event: e })),
      ...suspendedEvents.map(e => ({ type: 'suspended' as const, event: e })),
    ].sort((a, b) => {
      if (a.event.blockNumber !== b.event.blockNumber) {
        return a.event.blockNumber - b.event.blockNumber;
      }
      return (a.event.index || 0) - (b.event.index || 0);
    });

    for (const { type, event } of allEvents) {
      if (this.shouldStop) break;

      try {
        switch (type) {
          case 'minted':
            await this.handleMembershipMinted(event);
            break;
          case 'renewed':
            await this.handleMembershipRenewed(event);
            break;
          case 'suspended':
            await this.handleMembershipSuspended(event);
            break;
        }
      } catch (error) {
        logger.error(
          { err: error, eventType: type, blockNumber: event.blockNumber, txHash: event.transactionHash },
          'Failed to process event'
        );
        throw error;
      }
    }
  }

  /**
   * Handle MembershipMinted event
   * Creates or updates: Wallet, Community, Member, Membership
   */
  private async handleMembershipMinted(event: ethers.EventLog): Promise<void> {
    const args = event.args as unknown as [string, bigint, string, bigint];
    const [to, tokenId, communityId, expiresAt] = args;

    const walletAddress = to.toLowerCase();
    const tokenIdNum = Number(tokenId);
    const expiresAtDate = new Date(Number(expiresAt) * 1000);

    logger.debug(
      {
        walletAddress: `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`,
        tokenId: tokenIdNum,
        communityId,
        expiresAt: expiresAtDate.toISOString(),
        blockNumber: event.blockNumber,
      },
      'Processing MembershipMinted'
    );

    await this.prisma.$transaction(async (tx) => {
      // Upsert wallet
      const wallet = await tx.wallet.upsert({
        where: { address: walletAddress },
        create: { address: walletAddress },
        update: {},
      });

      // Upsert community (in a real system, this might come from a separate source)
      await tx.community.upsert({
        where: { id: communityId },
        create: { id: communityId, name: communityId },
        update: {},
      });

      // Upsert member
      const member = await tx.member.upsert({
        where: {
          communityId_walletId: {
            communityId,
            walletId: wallet.id,
          },
        },
        create: {
          communityId,
          walletId: wallet.id,
        },
        update: {},
      });

      // Determine membership state based on expiry
      const now = new Date();
      const state: MembershipState = expiresAtDate > now ? 'active' : 'expired';

      // Upsert membership by tokenId
      await tx.membership.upsert({
        where: { tokenId: tokenIdNum },
        create: {
          memberId: member.id,
          tokenId: tokenIdNum,
          state,
          expiresAt: expiresAtDate,
        },
        update: {
          memberId: member.id,
          state,
          expiresAt: expiresAtDate,
        },
      });
    });

    logger.info(
      {
        tokenId: tokenIdNum,
        communityId,
        blockNumber: event.blockNumber,
      },
      'MembershipMinted processed'
    );
  }

  /**
   * Handle MembershipRenewed event
   * Updates membership.expiresAt and membership.renewedAt
   */
  private async handleMembershipRenewed(event: ethers.EventLog): Promise<void> {
    const args = event.args as unknown as [bigint, bigint];
    const [tokenId, newExpiresAt] = args;

    const tokenIdNum = Number(tokenId);
    const newExpiresAtDate = new Date(Number(newExpiresAt) * 1000);

    logger.debug(
      {
        tokenId: tokenIdNum,
        newExpiresAt: newExpiresAtDate.toISOString(),
        blockNumber: event.blockNumber,
      },
      'Processing MembershipRenewed'
    );

    await this.prisma.$transaction(async (tx) => {
      const membership = await tx.membership.findUnique({
        where: { tokenId: tokenIdNum },
      });

      if (!membership) {
        logger.warn(
          { tokenId: tokenIdNum, blockNumber: event.blockNumber },
          'MembershipRenewed: tokenId not found, skipping'
        );
        return;
      }

      // Determine new state based on expiry
      const now = new Date();
      const newState: MembershipState = newExpiresAtDate > now ? 'active' : 'expired';

      await tx.membership.update({
        where: { tokenId: tokenIdNum },
        data: {
          expiresAt: newExpiresAtDate,
          renewedAt: now,
          state: newState,
        },
      });
    });

    logger.info(
      { tokenId: tokenIdNum, blockNumber: event.blockNumber },
      'MembershipRenewed processed'
    );
  }

  /**
   * Handle MembershipSuspended event
   * Updates membership.state to 'suspended' or back to 'active'
   */
  private async handleMembershipSuspended(event: ethers.EventLog): Promise<void> {
    const args = event.args as unknown as [bigint, boolean];
    const [tokenId, isSuspended] = args;

    const tokenIdNum = Number(tokenId);

    logger.debug(
      {
        tokenId: tokenIdNum,
        isSuspended,
        blockNumber: event.blockNumber,
      },
      'Processing MembershipSuspended'
    );

    await this.prisma.$transaction(async (tx) => {
      const membership = await tx.membership.findUnique({
        where: { tokenId: tokenIdNum },
      });

      if (!membership) {
        logger.warn(
          { tokenId: tokenIdNum, blockNumber: event.blockNumber },
          'MembershipSuspended: tokenId not found, skipping'
        );
        return;
      }

      let newState: MembershipState;

      if (isSuspended) {
        newState = 'suspended';
      } else {
        // Unsuspending: check if expired
        const now = new Date();
        newState = membership.expiresAt && membership.expiresAt > now ? 'active' : 'expired';
      }

      await tx.membership.update({
        where: { tokenId: tokenIdNum },
        data: { state: newState },
      });
    });

    logger.info(
      { tokenId: tokenIdNum, isSuspended, blockNumber: event.blockNumber },
      'MembershipSuspended processed'
    );
  }

  /**
   * Load checkpoint from database
   */
  private async loadCheckpoint() {
    return this.prisma.indexerCheckpoint.findUnique({
      where: {
        chainId_contractAddress: {
          chainId: this.config.chainId,
          contractAddress: this.config.contractAddress.toLowerCase(),
        },
      },
    });
  }

  /**
   * Save checkpoint to database
   */
  private async saveCheckpoint(blockNumber: number): Promise<void> {
    const block = await this.provider.getBlock(blockNumber);
    const blockHash = block?.hash || null;

    await this.prisma.indexerCheckpoint.upsert({
      where: {
        chainId_contractAddress: {
          chainId: this.config.chainId,
          contractAddress: this.config.contractAddress.toLowerCase(),
        },
      },
      create: {
        chainId: this.config.chainId,
        contractAddress: this.config.contractAddress.toLowerCase(),
        lastBlock: BigInt(blockNumber),
        lastBlockHash: blockHash,
      },
      update: {
        lastBlock: BigInt(blockNumber),
        lastBlockHash: blockHash,
      },
    });

    logger.debug({ blockNumber, blockHash }, 'Checkpoint saved');
  }

  /**
   * Graceful shutdown
   */
  async stop(): Promise<void> {
    logger.info('Stopping indexer...');
    this.shouldStop = true;
  }
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main() {
  const config = loadConfig();
  const indexer = new MembershipIndexer(config);

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal');
    await indexer.stop();
    await disconnectPrisma();
    logger.info('Indexer stopped cleanly');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await indexer.run();
    await disconnectPrisma();
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Indexer failed');
    await disconnectPrisma();
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export { MembershipIndexer, loadConfig };
