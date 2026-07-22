/**
 * reconciliationWorker.ts
 *
 * Periodically scans memberships whose stored state is `active` but whose
 * `expiresAt` has passed, and updates them to `expired`.
 *
 * Design notes:
 * - Idempotent: only updates records where state != 'expired' AND expiresAt < now.
 * - Emits one MEMBERSHIP_RECONCILED audit event per changed record.
 * - Does NOT touch `suspended` memberships whose expiry has passed; those are
 *   included intentionally so they can be expired as well.
 * - Read-time expiry checks in memberService remain the first line of defence.
 */

import { PrismaClient } from "@prisma/client";
import { getPrisma } from "../services/prisma";
import { logEvent } from "../services/auditService";
import { logOutboxEventTx } from "../services/outboxService";

export interface ReconciliationResult {
  updatedCount: number;
  errors: number;
}

/**
 * Run one reconciliation pass. Finds all memberships with a stale non-expired
 * state where expiresAt is in the past, and marks each as `expired`.
 */
export async function reconcileMemberships(
  db?: PrismaClient,
): Promise<ReconciliationResult> {
  const prisma = db ?? getPrisma();
  const now = new Date();

  // Fetch all stale membership tokens in one query, including the member for audit context.
  const stale = await prisma.membershipToken.findMany({
    where: {
      state: { in: ["active", "suspended"] },
      expiresAt: { lt: now },
    },
    include: { member: true },
  });

  let updatedCount = 0;
  let errors = 0;

  for (const token of stale) {
    try {
      // Wrap the mutation, outbox event, and audit event in a transaction
      // so that state change and event are atomically durable.
      await prisma.$transaction(async (tx: any) => {
        await tx.membershipToken.update({
          where: { tokenId: token.tokenId },
          data: { state: "expired" },
        });

        await logOutboxEventTx(tx, {
          eventType: "MEMBERSHIP_UPDATED",
          entityId: token.memberId,
          entityType: "Member",
          communityId: token.member.communityId,
          payload: {
            previousState: token.state,
            newState: "expired",
            reasonCode: "EXPIRY_RECONCILIATION",
          },
        });
      });

      // Audit log outside the transaction (best-effort, non-blocking)
      await logEvent({
        eventType: "MEMBERSHIP_RECONCILED",
        walletId: token.member.walletId,
        communityId: token.member.communityId,
        beforeState: { state: token.state },
        afterState: { state: "expired" },
        reasonCode: "EXPIRY_RECONCILIATION",
      });

      updatedCount++;
    } catch (err) {
      // Log individual failures without aborting the whole pass.
      console.error(
        `[reconciliationWorker] Failed to reconcile membership token ${token.tokenId}:`,
        err,
      );
      errors++;
    }
  }

  return { updatedCount, errors };
}

export interface ReconciliationWorker {
  start(): void;
  stop(): void;
}

/**
 * Create a scheduled reconciliation worker that runs at the given interval.
 * Returns a handle with `start()` and `stop()` methods.
 */
export function createReconciliationWorker(
  intervalMs: number,
  db?: PrismaClient,
): ReconciliationWorker {
  let timer: ReturnType<typeof setInterval> | null = null;

  async function run() {
    try {
      const result = await reconcileMemberships(db);
      if (result.updatedCount > 0 || result.errors > 0) {
        console.log(
          `[reconciliationWorker] Pass complete: updated=${result.updatedCount} errors=${result.errors}`,
        );
      }
    } catch (err) {
      console.error("[reconciliationWorker] Unhandled error in pass:", err);
    }
  }

  return {
    start() {
      if (timer !== null) return; // already running
      timer = setInterval(run, intervalMs);
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
