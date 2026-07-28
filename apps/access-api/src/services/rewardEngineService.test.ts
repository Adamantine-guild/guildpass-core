import { RewardEngine, type RewardRule } from "@guildpass/reward-engine";
import {
  createRewardEventHandler,
  getRewardSummary,
} from "./rewardEngineService";

function makeDb() {
  const ledger = new Map<string, any>();
  let state: any = null;
  const tx: any = {
    rewardStreakState: {
      findUnique: jest.fn(async () => state),
      upsert: jest.fn(async ({ create, update }: any) => {
        state = state ? { ...state, ...update } : { id: "state-1", ...create };
        return state;
      }),
      findMany: jest.fn(async () => state ? [state] : []),
    },
    rewardLedger: {
      createMany: jest.fn(async ({ data }: any) => {
        let count = 0;
        for (const row of data) {
          const key = [
            row.walletId, row.communityId, row.rewardType, row.sourceEventId,
          ].join("|");
          if (!ledger.has(key)) {
            ledger.set(key, { id: `ledger-${ledger.size + 1}`, ...row });
            count++;
          }
        }
        return { count };
      }),
      findMany: jest.fn(async () => [...ledger.values()]),
    },
  };
  return {
    ...tx,
    $transaction: jest.fn((callback: any) => callback(tx)),
    _ledger: ledger,
  };
}

const outboxEvent = {
  id: "source-event-1",
  eventType: "EVENT_ATTENDANCE_RECORDED",
  entityId: "attendance-1",
  entityType: "EventAttendance",
  communityId: "community-1",
  payload: { walletId: "wallet-1" },
  createdAt: new Date("2026-01-05T00:00:00Z"),
};

test("replayed events never double-credit the ledger", async () => {
  const db = makeDb();
  const handler = createRewardEventHandler({ db });
  await handler(outboxEvent);
  await handler(outboxEvent);
  expect(db._ledger.size).toBe(1);
  expect([...db._ledger.values()][0]).toMatchObject({
    sourceEventId: "source-event-1",
    rewardType: "points",
    amount: 1,
  });
});

test("custom reward rules flow to the ledger without consumer changes", async () => {
  const db = makeDb();
  const tokenRule: RewardRule = {
    id: "token-extension",
    evaluate: () => [{ rewardType: "token:erc20", amount: 10 }],
  };
  const handler = createRewardEventHandler({
    db,
    engine: new RewardEngine([tokenRule]),
  });
  await handler(outboxEvent);
  expect([...db._ledger.values()][0]).toMatchObject({
    rewardType: "token:erc20",
    ruleId: "token-extension",
  });
});

test("reward summary exposes ledger and streak projections", async () => {
  const db = makeDb();
  await createRewardEventHandler({ db })(outboxEvent);
  const summary = await getRewardSummary(db, "WALLET-1", "community-1");
  expect(summary.wallet).toBe("wallet-1");
  expect(summary.rewards).toHaveLength(1);
  expect(summary.streaks).toHaveLength(1);
});
