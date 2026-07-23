/**
 * index.ts
 * Process entry point. Builds the Fastify app, binds the port, and wires up
 * graceful shutdown (SIGTERM / SIGINT) so in-flight requests and the Prisma
 * connection pool are cleaned up before the process exits.
 */

import { buildApp } from './app';
import { config } from './config';
import { disconnectPrisma } from './services/prisma';
import { createReconciliationWorker } from './workers/reconciliationWorker';
import { createOutboxWorker } from './workers/outboxWorker';
import { createIndexerWorker, ChainProvider } from './workers/indexerWorker';
import { createOnChainReconciliationWorker, OnChainViewProvider } from './workers/onChainReconciliationWorker';
import { createContributionScoreHandler } from './handlers/contributionScoreHandler';

async function main() {
  const app = await buildApp();

  const worker = createReconciliationWorker(config.reconciliationIntervalMs);
  worker.start();

  const contributionHandler = createContributionScoreHandler();
  const outboxWorker = createOutboxWorker({
    intervalMs: config.outboxWorkerIntervalMs,
    handler: contributionHandler,
    db: undefined, // Use default Prisma client
    maxBatchSize: config.outboxWorkerBatchSize,
    minBatchSize: config.outboxWorkerMinBatchSize,
    workerCount: config.outboxWorkerCount,
    workerId: undefined, // Use a generated worker id (unique per process)
    claimLeaseMs: config.outboxWorkerClaimLeaseMs,
  });
  outboxWorker.start();

  // Initialize IndexerWorker if a provider is available
  // Note: In a real production environment, you would inject a real RPC-backed ChainProvider here.
  // For now, we instantiate it only if explicitly needed or with a mock/stub if desired.
  // Example stub for demonstration:
  const stubProvider: ChainProvider = {
    getLatestBlockNumber: async () => 0,
    getBlock: async () => ({ number: 0, hash: '0x0', parentHash: '0x0' }),
    getLogs: async () => [],
  };

  const indexerWorker = createIndexerWorker(
    stubProvider,
    config.indexerIntervalMs,
    config.indexerFinalityWindow,
  );
  // indexerWorker.start(); // Keep disabled by default until provider is configured

  // ---------------------------------------------------------------------------
  // On-chain reconciliation worker
  // ---------------------------------------------------------------------------
  // This worker performs a systematic, field-by-field comparison between what
  // the contract says is true (via view-function calls) and what the database
  // says is true.  It raises RECONCILIATION_DISCREPANCY audit events for any
  // mismatch found but does NOT auto-correct — see onChainReconciliationWorker.ts
  // for rationale and full cost/sampling documentation.
  //
  // In production, replace `stubViewProvider` with a real implementation backed
  // by your RPC endpoint (e.g. using ethers.js Contract.connect(provider)):
  //
  //   import { ethers } from 'ethers';
  //   import { MembershipNFTAbi } from '@guildpass/contracts';
  //   const rpcProvider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  //   const contract = new ethers.Contract(
  //     process.env.MEMBERSHIP_NFT_ADDRESS,
  //     MembershipNFTAbi,
  //     rpcProvider,
  //   );
  //   const realViewProvider: OnChainViewProvider = {
  //     async getTokenState(tokenId) {
  //       const [owner, isActive, expiry, suspended, communityId] =
  //         await Promise.all([
  //           contract.ownerOf(tokenId),
  //           contract.isActive(tokenId),
  //           contract.expiry(tokenId),
  //           contract.suspended(tokenId),
  //           contract.communityOf(tokenId),
  //         ]);
  //       return {
  //         owner: owner.toLowerCase(),
  //         isActive,
  //         expiry: Number(expiry),
  //         suspended,
  //         communityId,
  //       };
  //     },
  //   };
  const stubViewProvider: OnChainViewProvider = {
    getTokenState: async (_tokenId: number) => {
      throw new Error('No RPC provider configured — set up a real OnChainViewProvider');
    },
  };

  const onChainReconciliationWorker = createOnChainReconciliationWorker(
    config.onChainReconciliationIntervalMs,
    stubViewProvider,
    { sampleSize: config.onChainReconciliationSampleSize },
  );
  // onChainReconciliationWorker.start(); // Keep disabled by default until provider is configured

  await app.listen({ port: config.port, host: '0.0.0.0' });

  console.log(
    `🚀 Server running on http://0.0.0.0:${config.port} (${config.nodeEnv})`
  );

  // -----------------------------------------------------------------------
  // Graceful shutdown
  // -----------------------------------------------------------------------
  const shutdown = async (signal: string) => {
    console.log(
      `\n⏹️  Received ${signal} shutdown signal, closing server...`
    );
    try {
      worker.stop();
      outboxWorker.stop();
      indexerWorker.stop();
      onChainReconciliationWorker.stop();
      await disconnectPrisma();
      console.log('✅ Server and database connections closed cleanly.');
      process.exit(0);
    } catch (err) {
      console.error(`\n❌ Error during graceful shutdown:\n`, err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(`\n❌ Failed to start server:\n`, err);
  process.exit(1);
});
