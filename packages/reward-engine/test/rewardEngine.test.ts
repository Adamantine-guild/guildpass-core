import {
  RewardEngine,
  StreakTracker,
  type RewardEvent,
  type RewardRule,
} from "../src";

const event = (id: string, occurredAt: string): RewardEvent => ({
  id,
  eventType: "EVENT_ATTENDANCE_RECORDED",
  walletId: "wallet-1",
  communityId: "community-1",
  occurredAt: new Date(occurredAt),
});

describe("StreakTracker", () => {
  test("increments consecutive weeks, ignores replay period, and resets after a miss", () => {
    const tracker = new StreakTracker("weekly");
    const first = tracker.record(null, event("1", "2026-01-05T00:00:00Z").occurredAt);
    const replay = tracker.record(first, event("2", "2026-01-11T23:59:59Z").occurredAt);
    const second = tracker.record(replay, event("3", "2026-01-12T00:00:00Z").occurredAt);
    const reset = tracker.record(second, event("4", "2026-02-02T00:00:00Z").occurredAt);
    expect(replay.current).toBe(1);
    expect(second.current).toBe(2);
    expect(reset).toMatchObject({ current: 1, longest: 2 });
  });

  test("handles month and year boundaries", () => {
    const tracker = new StreakTracker("monthly");
    const dec = tracker.record(null, new Date("2025-12-31T23:59:59Z"));
    expect(tracker.record(dec, new Date("2026-01-01T00:00:00Z")).current).toBe(2);
  });
});

test("new reward types are supplied by rules without core changes", () => {
  const tokenRule: RewardRule = {
    id: "future-token",
    evaluate: () => [{ rewardType: "token:erc20", amount: 5 }],
  };
  const grants = new RewardEngine([tokenRule]).evaluate(
    event("1", "2026-01-05T00:00:00Z"),
    { period: "weekly", current: 1, longest: 1, lastPeriodKey: "weekly:1" },
  );
  expect(grants).toEqual([{
    rewardType: "token:erc20", amount: 5, ruleId: "future-token",
  }]);
});
