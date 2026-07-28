import type { RewardEvent, RewardGrant, RewardRule, StreakState } from "./types";

export class RewardEngine {
  constructor(private readonly rules: readonly RewardRule[] = []) {}

  evaluate(event: RewardEvent, streak: StreakState): RewardGrant[] {
    return this.rules.flatMap((rule) =>
      rule.evaluate(event, streak).map((grant) => ({
        ...grant,
        ruleId: grant.ruleId ?? rule.id,
      })),
    );
  }

  withRule(rule: RewardRule): RewardEngine {
    return new RewardEngine([...this.rules, rule]);
  }
}

export class PointsPerActivityRule implements RewardRule {
  readonly id = "points-per-activity";
  constructor(
    private readonly points = 1,
    private readonly eventTypes: readonly string[] = [
      "MEMBERSHIP_CREATED",
      "MEMBER_ATTENDED",
      "EVENT_ATTENDANCE_RECORDED",
      "CONTRIBUTION_SCORE_UPDATED",
    ],
  ) {}

  evaluate(event: RewardEvent): RewardGrant[] {
    return this.eventTypes.includes(event.eventType)
      ? [{ rewardType: "points", amount: this.points }]
      : [];
  }
}

export class StreakBadgeRule implements RewardRule {
  readonly id: string;
  constructor(
    readonly milestone: number,
    readonly label = `${milestone}-period streak`,
  ) {
    this.id = `streak-badge-${milestone}`;
  }

  evaluate(_event: RewardEvent, streak: StreakState): RewardGrant[] {
    return streak.current === this.milestone
      ? [{ rewardType: "badge", metadata: { label: this.label } }]
      : [];
  }
}
