import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticateApiKey, requireSiweSession } from "../lib/auth/auth";
import { forbidden } from "../errors";
import { getRewardSummary } from "../services/rewardEngineService";

export function registerRewardRoutes(
  app: FastifyInstance,
  deps: {
    db: any;
    getRequesterWallet: (request: FastifyRequest) => string;
  },
): void {
  app.get("/v1/members/:wallet/rewards", {
    preHandler: [authenticateApiKey, requireSiweSession],
    schema: {
      tags: ["Rewards"],
      summary: "Get a member's reward ledger and current streaks",
      params: {
        type: "object",
        required: ["wallet"],
        properties: {
          wallet: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
        },
      },
      querystring: {
        type: "object",
        properties: { communityId: { type: "string" } },
      },
      response: {
        200: {
          type: "object",
          required: ["wallet", "rewards", "streaks"],
          properties: {
            wallet: { type: "string" },
            rewards: { type: "array", items: { type: "object", additionalProperties: true } },
            streaks: { type: "array", items: { type: "object", additionalProperties: true } },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { wallet } = request.params as { wallet: string };
    if (deps.getRequesterWallet(request).toLowerCase() !== wallet.toLowerCase()) {
      return reply.status(403).send(forbidden("Reward history is private"));
    }
    const { communityId } = request.query as { communityId?: string };
    return getRewardSummary(deps.db, wallet, communityId);
  });
}
