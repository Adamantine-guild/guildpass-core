import {
  PointsPerActivityRule,
  RewardEngine,
  StreakBadgeRule,
  StreakTracker,
  type RewardEvent,
  type StreakPeriod,
} from "@guildpass/reward-engine";
import {
  OUTBOX_EVENT_TYPES,
  type OutboxEventType,
} from "@guildpass/shared-types";
import type { OutboxEventHandler } from "../workers/outboxWorker";

const REWARD_EVENTS: ReadonlySet<OutboxEventType> = new Set([
  OUTBOX_EVENT_TYPES.MEMBERSHIP_CREATED,
  OUTBOX_EVENT_TYPES.MEMBER_ATTENDED,
  OUTBOX_EVENT_TYPES.EVENT_ATTENDANCE_RECORDED,
  OUTBOX_EVENT_TYPES.CONTRIBUTION_SCORE_UPDATED,
]);

export interface RewardConsumerOptions {
  db: any;
  period?: StreakPeriod;
  engine?: RewardEngine;
}

export function createRewardEventHandler(
  options: RewardConsumerOptions,
): OutboxEventHandler {
  const period = options.period ?? "weekly";
  const tracker = new StreakTracker(period);
  const engine = options.engine ?? new RewardEngine([
    new PointsPerActivityRule(1),
    new StreakBadgeRule(4, "4-week streak"),
    new StreakBadgeRule(12, "12-week streak"),
  ]);

  return async (outboxEvent) => {
    if (!REWARD_EVENTS.has(outboxEvent.eventType) || !outboxEvent.communityId) return;
    const communityId = outboxEvent.communityId;
    const walletId = String(
      outboxEvent.payload?.walletId ?? outboxEvent.payload?.wallet ?? "",
    ).toLowerCase();
    if (!walletId) return;

    await options.db.$transaction(async (tx: any) => {
      const persisted = await tx.rewardStreakState.findUnique({
        where: {
          walletId_communityId_period: {
            walletId,
            communityId,
            period,
          },
        },
      });
      const previous = persisted ? {
        period,
        current: persisted.currentStreak,
        longest: persisted.longestStreak,
        lastPeriodKey: persisted.lastPeriodKey,
      } : null;
      const occurredAt = outboxEvent.createdAt ?? new Date();
      const streak = tracker.record(previous, occurredAt);
      const lastActivityAt =
        persisted?.lastActivityAt && persisted.lastActivityAt > occurredAt
          ? persisted.lastActivityAt
          : occurredAt;

      await tx.rewardStreakState.upsert({
        where: {
          walletId_communityId_period: {
            walletId,
            communityId,
            period,
          },
        },
        create: {
          walletId,
          communityId,
          period,
          currentStreak: streak.current,
          longestStreak: streak.longest,
          lastPeriodKey: streak.lastPeriodKey,
          lastActivityAt,
        },
        update: {
          currentStreak: streak.current,
          longestStreak: streak.longest,
          lastPeriodKey: streak.lastPeriodKey,
          lastActivityAt,
        },
      });

      const event: RewardEvent = {
        id: outboxEvent.id,
        eventType: outboxEvent.eventType,
        walletId,
        communityId,
        occurredAt,
        payload: outboxEvent.payload,
      };
      const grants = engine.evaluate(event, streak);
      if (grants.length > 0) {
        await tx.rewardLedger.createMany({
          data: grants.map((grant) => ({
            walletId,
            communityId,
            rewardType: grant.rewardType,
            amount: grant.amount,
            metadata: grant.metadata,
            ruleId: grant.ruleId,
            sourceEventId: outboxEvent.id,
          })),
          skipDuplicates: true,
        });
      }
    });
  };
}

export async function getRewardSummary(
  db: any,
  walletId: string,
  communityId?: string,
) {
  const wallet = walletId.toLowerCase();
  const communityFilter = communityId ? { communityId } : {};
  const [ledger, streaks] = await Promise.all([
    db.rewardLedger.findMany({
      where: { walletId: wallet, ...communityFilter },
      orderBy: { grantedAt: "desc" },
    }),
    db.rewardStreakState.findMany({
      where: { walletId: wallet, ...communityFilter },
      orderBy: { updatedAt: "desc" },
    }),
  ]);
  return { wallet, rewards: ledger, streaks };
}
