/**
 * Community-scoped suspension appeal routes (#249).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticateApiKey, requireSiweSession } from "../lib/auth/auth";
import { resolveRequesterWallet } from "../utils/requesterIdentity";
import {
  getSuspensionAppealService,
  SuspensionAppealError,
} from "../services/suspensionAppeal/suspensionAppealService";
import { getMemberService } from "../services/memberService";
import { getPrisma } from "../services/prisma";
import {
  createApiError,
  forbidden,
  unauthorized,
  validationError,
} from "../errors";
import {
  submitSuspensionAppealSchema,
  listSuspensionAppealsSchema,
  decideSuspensionAppealSchema,
} from "../schemas";

function getRequesterWallet(request: FastifyRequest): string {
  const fromSession = (request as any).authenticatedWallet;
  if (typeof fromSession === "string" && fromSession.trim()) {
    return fromSession.trim().toLowerCase();
  }
  return resolveRequesterWallet(request).trim().toLowerCase();
}

function mapAppealError(error: SuspensionAppealError) {
  return createApiError({
    statusCode: error.statusCode,
    code: error.code as any,
    message: error.message,
  });
}

export function registerSuspensionAppealRoutes(app: FastifyInstance): void {
  const prisma = getPrisma();
  const appeals = getSuspensionAppealService(prisma);
  const memberService = getMemberService(prisma);

  // Member submits an appeal against their own active suspension
  app.post(
    "/v1/communities/:communityId/members/:wallet/appeals",
    {
      schema: submitSuspensionAppealSchema,
      preHandler: [authenticateApiKey, requireSiweSession],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId, wallet } = request.params as {
        communityId: string;
        wallet: string;
      };
      const body = request.body as { memberStatement?: string };
      const requesterWallet = getRequesterWallet(request);
      if (!requesterWallet) {
        return reply.status(401).send(unauthorized("Requester wallet required"));
      }
      try {
        const result = await appeals.submitAppeal({
          communityId,
          wallet,
          memberStatement: body.memberStatement ?? "",
          requesterWallet,
        });
        return reply.status(201).send(result);
      } catch (error) {
        if (error instanceof SuspensionAppealError) {
          return reply.status(error.statusCode).send(mapAppealError(error));
        }
        throw error;
      }
    },
  );

  // Admin review queue
  app.get(
    "/v1/communities/:communityId/appeals",
    {
      schema: listSuspensionAppealsSchema,
      preHandler: [authenticateApiKey, requireSiweSession],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId } = request.params as { communityId: string };
      const query = request.query as {
        status?: "pending" | "approved" | "denied";
        page?: string | number;
        limit?: string | number;
      };
      const requesterWallet = getRequesterWallet(request);
      if (!requesterWallet) {
        return reply.status(401).send(unauthorized("Requester wallet required"));
      }
      if (!(await memberService.isCommunityAdmin(communityId, requesterWallet))) {
        return reply.status(403).send(forbidden("Forbidden"));
      }
      try {
        return await appeals.listAppeals({
          communityId,
          status: query.status,
          page: query.page != null ? Number(query.page) : undefined,
          limit: query.limit != null ? Number(query.limit) : undefined,
        });
      } catch (error) {
        if (error instanceof SuspensionAppealError) {
          return reply.status(error.statusCode).send(mapAppealError(error));
        }
        throw error;
      }
    },
  );

  // Admin decision
  app.post(
    "/v1/communities/:communityId/appeals/:appealId/decision",
    {
      schema: decideSuspensionAppealSchema,
      preHandler: [authenticateApiKey, requireSiweSession],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId, appealId } = request.params as {
        communityId: string;
        appealId: string;
      };
      const body = request.body as {
        decision?: "approved" | "denied";
        rationale?: string;
      };
      const requesterWallet = getRequesterWallet(request);
      if (!requesterWallet) {
        return reply.status(401).send(unauthorized("Requester wallet required"));
      }
      if (!(await memberService.isCommunityAdmin(communityId, requesterWallet))) {
        return reply.status(403).send(forbidden("Forbidden"));
      }
      if (!body.decision) {
        return reply.status(400).send(validationError("Missing decision"));
      }
      try {
        const result = await appeals.decideAppeal({
          communityId,
          appealId,
          decision: body.decision,
          rationale: body.rationale ?? "",
          reviewerWallet: requesterWallet,
        });
        return reply.send(result);
      } catch (error) {
        if (error instanceof SuspensionAppealError) {
          return reply.status(error.statusCode).send(mapAppealError(error));
        }
        throw error;
      }
    },
  );
}
