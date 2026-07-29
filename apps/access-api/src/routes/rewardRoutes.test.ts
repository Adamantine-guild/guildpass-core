import Fastify from "fastify";
import { registerRewardRoutes } from "./rewardRoutes";

const WALLET = "0x1111111111111111111111111111111111111111";

function appFor(requester = WALLET) {
  const app = Fastify();
  const db: any = {
    rewardLedger: {
      findMany: jest.fn().mockResolvedValue([{
        id: "reward-1",
        walletId: WALLET,
        communityId: "community-1",
        rewardType: "points",
        amount: 1,
        sourceEventId: "event-1",
        grantedAt: new Date(),
      }]),
    },
    rewardStreakState: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  registerRewardRoutes(app, {
    db,
    getRequesterWallet: () => requester,
  });
  return { app, db };
}

test("returns a member's ledger and streaks", async () => {
  const { app, db } = appFor();
  const response = await app.inject({
    method: "GET",
    url: `/v1/members/${WALLET}/rewards?communityId=community-1`,
    headers: { "x-api-key": "test-api-key", "x-wallet": WALLET },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().rewards).toHaveLength(1);
  expect(db.rewardLedger.findMany).toHaveBeenCalledWith({
    where: { walletId: WALLET, communityId: "community-1" },
    orderBy: { grantedAt: "desc" },
  });
  await app.close();
});

test("does not expose another member's rewards", async () => {
  const { app } = appFor("0x2222222222222222222222222222222222222222");
  const response = await app.inject({
    method: "GET",
    url: `/v1/members/${WALLET}/rewards`,
    headers: { "x-api-key": "test-api-key" },
  });
  expect(response.statusCode).toBe(403);
  await app.close();
});
