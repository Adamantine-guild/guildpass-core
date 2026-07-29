import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AttendanceMethod } from "@guildpass/shared-types";
import { authenticateApiKey, requireSiweSession } from "../lib/auth/auth";
import {
  EventService,
  EventServiceError,
  type EventMutationInput,
} from "../services/eventService";
import { createApiError } from "../errors";

export interface EventRoutesDeps {
  service: EventService;
  requireCommunityAdmin: (
    communityId: string,
    wallet: string,
  ) => Promise<boolean>;
  getRequesterWallet: (request: FastifyRequest) => string;
}

const walletPattern = "^0x[0-9a-fA-F]{40}$";
const authHooks = [authenticateApiKey, requireSiweSession];
const communityParams = {
  type: "object",
  required: ["communityId"],
  properties: { communityId: { type: "string" } },
} as const;
const eventParams = {
  type: "object",
  required: ["communityId", "eventId"],
  properties: {
    communityId: { type: "string" },
    eventId: { type: "string" },
  },
} as const;
const eventBody = {
  type: "object",
  additionalProperties: false,
  required: ["title", "startsAt", "endsAt"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: ["string", "null"], maxLength: 2000 },
    startsAt: { type: "string", format: "date-time" },
    endsAt: { type: "string", format: "date-time" },
  },
} as const;
const eventSchema = {
  type: "object",
  required: [
    "id", "communityId", "title", "startsAt", "endsAt",
    "createdAt", "updatedAt",
  ],
  properties: {
    id: { type: "string" },
    communityId: { type: "string" },
    title: { type: "string" },
    description: { type: ["string", "null"] },
    startsAt: { type: "string", format: "date-time" },
    endsAt: { type: "string", format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;
const errorSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
      },
    },
  },
} as const;

function mutationInput(body: {
  title: string;
  description?: string | null;
  startsAt: string;
  endsAt: string;
}): EventMutationInput {
  return {
    title: body.title,
    description: body.description,
    startsAt: new Date(body.startsAt),
    endsAt: new Date(body.endsAt),
  };
}

function sendEventError(reply: FastifyReply, error: unknown) {
  if (error instanceof EventServiceError) {
    return reply.status(error.statusCode).send(createApiError({
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
    }));
  }
  throw error;
}

export function registerEventRoutes(
  app: FastifyInstance,
  deps: EventRoutesDeps,
): void {
  const requireAdmin = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<boolean> => {
    const { communityId } = request.params as { communityId: string };
    const allowed = await deps.requireCommunityAdmin(
      communityId,
      deps.getRequesterWallet(request),
    );
    if (!allowed) {
      reply.status(403).send(createApiError({
        statusCode: 403,
        code: "FORBIDDEN",
        message: "Community administrator access is required",
      }));
    }
    return allowed;
  };

  app.post("/v1/communities/:communityId/events", {
    preHandler: authHooks,
    schema: {
      tags: ["Events"],
      summary: "Create a community event (admin only)",
      security: [{ RequesterWallet: [] }],
      params: communityParams,
      body: eventBody,
      response: { 201: eventSchema, 400: errorSchema, 403: errorSchema },
    },
  }, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const { communityId } = request.params as { communityId: string };
    try {
      const event = await deps.service.create(
        communityId,
        mutationInput(request.body as any),
      );
      return reply.status(201).send(event);
    } catch (error) {
      return sendEventError(reply, error);
    }
  });

  app.get("/v1/communities/:communityId/events", {
    preHandler: authHooks,
    schema: {
      tags: ["Events"],
      summary: "List community events (admin only)",
      security: [{ RequesterWallet: [] }],
      params: communityParams,
      response: {
        200: {
          type: "object",
          required: ["events"],
          properties: { events: { type: "array", items: eventSchema } },
        },
        403: errorSchema,
      },
    },
  }, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const { communityId } = request.params as { communityId: string };
    return { events: await deps.service.list(communityId) };
  });

  app.get("/v1/communities/:communityId/events/:eventId", {
    preHandler: authHooks,
    schema: {
      tags: ["Events"],
      summary: "Get a community event (admin only)",
      security: [{ RequesterWallet: [] }],
      params: eventParams,
      response: { 200: eventSchema, 404: errorSchema, 403: errorSchema },
    },
  }, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const { communityId, eventId } = request.params as {
      communityId: string; eventId: string;
    };
    const event = await deps.service.get(communityId, eventId);
    if (!event) {
      return sendEventError(
        reply,
        new EventServiceError("Event not found", 404, "NOT_FOUND"),
      );
    }
    return event;
  });

  app.put("/v1/communities/:communityId/events/:eventId", {
    preHandler: authHooks,
    schema: {
      tags: ["Events"],
      summary: "Replace a community event (admin only)",
      security: [{ RequesterWallet: [] }],
      params: eventParams,
      body: eventBody,
      response: {
        200: eventSchema, 400: errorSchema, 404: errorSchema, 403: errorSchema,
      },
    },
  }, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const { communityId, eventId } = request.params as {
      communityId: string; eventId: string;
    };
    try {
      return await deps.service.update(
        communityId,
        eventId,
        mutationInput(request.body as any),
      );
    } catch (error) {
      return sendEventError(reply, error);
    }
  });

  app.delete("/v1/communities/:communityId/events/:eventId", {
    preHandler: authHooks,
    schema: {
      tags: ["Events"],
      summary: "Delete a community event (admin only)",
      security: [{ RequesterWallet: [] }],
      params: eventParams,
      response: { 204: { type: "null" }, 404: errorSchema, 403: errorSchema },
    },
  }, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const { communityId, eventId } = request.params as {
      communityId: string; eventId: string;
    };
    try {
      await deps.service.remove(communityId, eventId);
      return reply.status(204).send();
    } catch (error) {
      return sendEventError(reply, error);
    }
  });

  app.post("/v1/communities/:communityId/events/:eventId/attend", {
    preHandler: authHooks,
    schema: {
      tags: ["Event attendance"],
      summary: "Check an active community member into a current event",
      security: [{ RequesterWallet: [] }],
      params: eventParams,
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          wallet: { type: "string", pattern: walletPattern },
          method: {
            type: "string",
            enum: ["manual", "qr", "signed_message"],
            default: "manual",
          },
        },
      },
      response: {
        201: {
          type: "object",
          required: ["id", "eventId", "walletId", "wallet", "checkedInAt", "method"],
          properties: {
            id: { type: "string" },
            eventId: { type: "string" },
            walletId: { type: "string" },
            wallet: { type: "string", pattern: walletPattern },
            checkedInAt: { type: "string", format: "date-time" },
            method: {
              type: "string",
              enum: ["manual", "qr", "signed_message"],
            },
          },
        },
        404: errorSchema,
        409: errorSchema,
      },
    },
  }, async (request, reply) => {
    const { communityId, eventId } = request.params as {
      communityId: string; eventId: string;
    };
    const requester = deps.getRequesterWallet(request).toLowerCase();
    const body = request.body as {
      wallet?: string;
      method?: AttendanceMethod;
    };
    const target = (body.wallet ?? requester).toLowerCase();
    if (target !== requester && !await deps.requireCommunityAdmin(communityId, requester)) {
      return reply.status(403).send(createApiError({
        statusCode: 403,
        code: "FORBIDDEN",
        message: "Only administrators can check in another member",
      }));
    }
    try {
      const attendance = await deps.service.checkIn({
        communityId,
        eventId,
        wallet: target,
        method: body.method ?? "manual",
      });
      return reply.status(201).send(attendance);
    } catch (error) {
      return sendEventError(reply, error);
    }
  });

  app.get("/v1/communities/:communityId/members/:wallet/attendance", {
    preHandler: authHooks,
    schema: {
      tags: ["Event attendance"],
      summary: "List a member's community event attendance history",
      security: [{ RequesterWallet: [] }],
      params: {
        type: "object",
        required: ["communityId", "wallet"],
        properties: {
          communityId: { type: "string" },
          wallet: { type: "string", pattern: walletPattern },
        },
      },
      response: {
        200: {
          type: "object",
          required: ["attendance"],
          properties: {
            attendance: {
              type: "array",
              items: {
                type: "object",
                required: ["id", "eventId", "wallet", "checkedInAt", "method", "event"],
                properties: {
                  id: { type: "string" },
                  eventId: { type: "string" },
                  wallet: { type: "string", pattern: walletPattern },
                  checkedInAt: { type: "string", format: "date-time" },
                  method: {
                    type: "string",
                    enum: ["manual", "qr", "signed_message"],
                  },
                  event: eventSchema,
                },
              },
            },
          },
        },
        403: errorSchema,
      },
    },
  }, async (request, reply) => {
    const { communityId, wallet } = request.params as {
      communityId: string; wallet: string;
    };
    const requester = deps.getRequesterWallet(request).toLowerCase();
    if (
      requester !== wallet.toLowerCase() &&
      !await deps.requireCommunityAdmin(communityId, requester)
    ) {
      return reply.status(403).send(createApiError({
        statusCode: 403,
        code: "FORBIDDEN",
        message: "Attendance history is private to the member and administrators",
      }));
    }
    return {
      attendance: await deps.service.listMemberAttendance(communityId, wallet),
    };
  });
}
