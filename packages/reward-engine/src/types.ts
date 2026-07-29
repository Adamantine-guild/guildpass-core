export type StreakPeriod = "daily" | "weekly" | "monthly";
export type RewardType = "points" | "badge" | (string & {});

export interface RewardEvent {
  id: string;
  eventType: string;
  walletId: string;
  communityId: string;
  occurredAt: Date;
  payload?: Record<string, unknown>;
}

export interface StreakState {
  period: StreakPeriod;
  current: number;
  longest: number;
  lastPeriodKey: string | null;
}

export interface RewardGrant {
  rewardType: RewardType;
  amount?: number;
  metadata?: Record<string, unknown>;
  ruleId?: string;
}

export interface RewardRule {
  readonly id: string;
  evaluate(event: RewardEvent, streak: StreakState): RewardGrant[];
}
