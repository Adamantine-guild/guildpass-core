/**
 * Contribution Score Outbox Handler
 *
 * An OutboxEventHandler that triggers contribution score recomputation
 * when relevant domain events arrive (ROLE_ASSIGNED, BADGE_ASSIGNED,
 * MEMBER_ATTENDED, MEMBERSHIP_CREATED, etc.).
 *
 * This is the event-driven recompute path: rather than requiring a manual
 * admin action, the contribution score is incrementally updated whenever
 * the member's contribution signals change.
 *
 * Wire this into the outbox worker alongside (or instead of) the default
 * no-op handler:
 *
 *   import { createContributionScoreHandler } from './handlers/contributionScoreHandler';
 *   import { createOutboxWorker } from './workers/outboxWorker';
 *
 *   const handler = createContributionScoreHandler({ db: prisma });
 *   const worker = createOutboxWorker({ handler, ... });
 */

import type { PrismaClient } from '@prisma/client';
import { recomputeAndPersist } from '../services/contributionService';
import type { OutboxEventHandler } from '../workers/outboxWorker';

/**
 * Event types that should trigger a contribution score recomputation.
 */
const SCORE_RECOMPUTE_EVENTS = new Set([
  'ROLE_ASSIGNED',
  'ROLE_REMOVED',
  'BADGE_ASSIGNED',
  'BADGE_REVOKED',
  'MEMBER_ATTENDED',
  'MEMBERSHIP_CREATED',
  'MEMBERSHIP_UPDATED',
]);

export interface ContributionScoreHandlerConfig {
  /** Injectable Prisma client. Defaults to the module-level singleton. */
  db?: PrismaClient;
}

/**
 * Create an OutboxEventHandler that recomputes contribution scores
 * on relevant events.
 *
 * The handler extracts the wallet and communityId from the event payload,
 * re-runs all registered signals, and upserts the result into the
 * ContributionScore table. Errors during recomputation are logged but
 * do NOT cause the handler to throw — the event is still marked as
 * delivered, since the score can be recomputed on the next relevant event.
 */
export function createContributionScoreHandler(
  config: ContributionScoreHandlerConfig = {},
): OutboxEventHandler {
  // Lazy import to avoid circular dependency at module load time
  let prismaSingleton: PrismaClient | null = null;

  async function getPrisma(): Promise<PrismaClient> {
    if (config.db) return config.db;
    if (!prismaSingleton) {
      const { getPrisma } = require('../services/prisma');
      prismaSingleton = getPrisma();
    }
    return prismaSingleton!;
  }

  return async (event) => {
    if (!SCORE_RECOMPUTE_EVENTS.has(event.eventType)) {
      return; // Not a score-relevant event
    }

    const payload = event.payload ?? {};
    const wallet = payload.wallet as string | undefined;
    const communityId = event.communityId as string | undefined;

    if (!wallet || !communityId) {
      // Cannot recompute without wallet and community context
      return;
    }

    try {
      const db = await getPrisma();
      await recomputeAndPersist(db, wallet, communityId);
    } catch (err: any) {
      // Log but don't throw — the score will be recomputed on the next
      // relevant event, and we don't want to stall the outbox worker.
      // eslint-disable-next-line no-console
      console.error(
        `[contributionScoreHandler] Failed to recompute score for ` +
          `wallet=${wallet} community=${communityId}:`,
        err?.message ?? err,
      );
    }
  };
}
