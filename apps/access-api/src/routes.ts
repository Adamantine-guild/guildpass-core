import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import crypto from "crypto";
import { getMemberService, MemberServiceError } from "./services/memberService";
import {
  getIdentityService,
  IdentityServiceError,
} from "./services/identityService";
import { getGovernanceService } from "./services/governanceService";
import { registerGovernanceRoutes } from "./routes/governanceRoutes";
import { registerCustomRoleRoutes } from "./routes/customRoleRoutes";
import { CustomRoleService } from "./services/customRoleService";
import { registerSuspensionAppealRoutes } from "./routes/suspensionAppealRoutes";
import { registerEventRoutes } from "./routes/eventRoutes";
import { EventService } from "./services/eventService";
import { registerRewardRoutes } from "./routes/rewardRoutes";
import {
  getModerationService,
  ModerationError,
} from "./services/moderation/moderationService";
import { queryAuditEvents } from "./services/auditService";
import { getPrisma } from "./services/prisma";
import {
  getAuditTraceByCorrelationId,
  getAuditTracesByTxHash,
  getAuditTracesByWallet,
} from "./services/auditTraceService";
import {
  notFound,
  validationError,
  validationErrorWithReason,
  internalError,
  forbidden,
  conflict,
  createApiError,
} from "./errors";
import {
  listDeadLetterEvents,
  retryDeadLetterEvent,
  DeadLetterNotFoundError,
  DeadLetterAlreadyResolvedError,
} from "./services/deadLetterService";
import {
  Challenge,
  WalletAddress,
  VALID_ROLES,
} from "@guildpass/shared-types";
import {
  getResourceService,
  ResourceServiceError,
} from "./services/resourceService";
import {
  ConstitutionalViolationError,
  createConstitutionalRuleSet,
  getConstitutionalRuleSetVersions,
  getActiveConstitutionalRuleSet,
} from "./services/constitutionalService";
import { validateRuleTree } from "@guildpass/policy-engine";
import {
  getCommunityRolesSchema,
  getMembershipsSchema,
  getMemberProfileSchema,
  assignMemberRoleSchema,
  removeMemberRoleSchema,
  assignBadgeSchema,
  listBadgesSchema,
  revokeBadgeSchema,
  createAccessOverrideSchema,
  revokeAccessOverrideSchema,
  listAccessOverridesSchema,
  accessCheckSchema,
  listCommunityMembersSchema,
  listDeadLetterEventsSchema,
  retryDeadLetterEventSchema,
  listAuditEventsSchema,
  updateCustomPolicySchema,
  createResourceSchema,
  updateResourceSchema,
  archiveResourceSchema,
  listResourcesSchema,
  AccessCheckBody,
} from "./schemas";
import {
  authenticateApiKey,
  requireSiweSession,
  verifySiweSignature,
} from "./lib/auth/auth";
import { config } from "./config";
import {
  createIdempotencyPreHandler,
  createIdempotencyOnSend,
} from "./lib/idempotency";
import { resolveRequesterWallet } from "./utils/requesterIdentity";

/**
 * Prefer SIWE session wallet. When SIWE is enforced, never trust client
 * identity headers (#240). Otherwise fall back to x-wallet* / Bearer for
 * migration.
 */
function getRequesterWallet(request: FastifyRequest): string {
  if ((request as any).authenticatedWallet) {
    return (request as any).authenticatedWallet;
  }
  if (config.siweEnforced) {
    return "";
  }
  const header =
    request.headers["x-wallet"] ??
    request.headers["x-user-wallet"] ??
    request.headers["x-requester-wallet"];
  if (Array.isArray(header)) {
    return header[0] ?? "";
  }
  if (header) {
    return header;
  }
  const authorization = request.headers.authorization;
  if (
    typeof authorization === "string" &&
    authorization.startsWith("Bearer ")
  ) {
    return authorization.slice(7).trim();
  }
  return "";
}

/** Page size bounds for GET /v1/communities/:communityId/members (issue #259). */
export const MEMBERS_LIST_MAX_PAGE_SIZE = 100;
export const MEMBERS_LIST_DEFAULT_PAGE_SIZE = 25;

const memberListQuerySchema = z.object({
  role: z.enum(["admin", "member", "contributor"]).optional(),
  status: z.enum(["invited", "active", "expired", "suspended"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MEMBERS_LIST_MAX_PAGE_SIZE)
    .default(MEMBERS_LIST_DEFAULT_PAGE_SIZE),
  sort: z.enum(["joinedAt", "role"]).default("joinedAt"),
});

function sendRoleMutationError(reply: FastifyReply, error: unknown) {
  if (error instanceof ConstitutionalViolationError) {
    return reply.status(error.statusCode).send({
      error: error.message,
      code: error.code,
      reasons: error.reasons,
      traces: error.traces,
    });
  }
  if (error instanceof MemberServiceError) {
    return reply.status(error.statusCode).send(
      createApiError({
        statusCode: error.statusCode,
        code:
          error.statusCode === 404
            ? "NOT_FOUND"
            : error.statusCode === 400
              ? "VALIDATION_ERROR"
              : error.statusCode === 409
                ? "CONFLICT"
                : error.statusCode === 403
                  ? "FORBIDDEN"
                  : "INTERNAL_ERROR",
        message: error.message,
      }),
    );
  }
  return reply.status(500).send(internalError("Internal server error"));
}

/**
 * Register all business routes on the Fastify instance.
 * Uses app.inject() friendly routes — no network binding required for tests.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const memberService = getMemberService(prisma);
  const identityService = getIdentityService(prisma);
  const moderationService = getModerationService(prisma);
  const resourceService = getResourceService(prisma);

  registerSuspensionAppealRoutes(app);

  registerGovernanceRoutes(app, {
    governanceService: getGovernanceService(prisma),
    requireCommunityAdmin: (communityId, requesterWallet) =>
      memberService.isCommunityAdmin(communityId, requesterWallet),
    getRequesterWallet,
  });
  registerCustomRoleRoutes(app, {
    service: new CustomRoleService(prisma),
    requireCommunityAdmin: (communityId, requesterWallet) =>
      memberService.isCommunityAdmin(communityId, requesterWallet),
    getRequesterWallet,
  });
  registerEventRoutes(app, {
    service: new EventService(prisma),
    requireCommunityAdmin: (communityId, requesterWallet) =>
      memberService.isCommunityAdmin(communityId, requesterWallet),
    getRequesterWallet,
  });
  registerRewardRoutes(app, { db: prisma, getRequesterWallet });

  // Idempotency-Key support for mutating routes (issue #184). Opt-in per
  // request via the `Idempotency-Key` header; applied to role assignment,
  // policy (access override), and resource mutation routes below.
  const idempotencyPreHandler = createIdempotencyPreHandler(prisma);
  const idempotencyOnSend = createIdempotencyOnSend(prisma);

  // --- SIWE Authentication Routes ---

  // Generate a SIWE nonce
  app.post(
    "/v1/auth/nonce",
    {
      schema: {
        summary: "Generate a SIWE nonce",
        description:
          "Issues a one-time 32-byte hex nonce valid for 5 minutes. " +
          "Pass this nonce in the SIWE message you present for signing, " +
          "then submit the signed message to `POST /v1/auth/verify`.",
        tags: ["Auth"],
        response: {
          200: {
            description: "Nonce issued",
            type: "object",
            required: ["nonce"],
            properties: {
              nonce: {
                type: "string",
                description: "One-time hex nonce, expires in 5 minutes",
                example: "a3f8c2e1b7d94f6a0e5b3d2c9a1f4e7b",
              },
            },
            example: { nonce: "a3f8c2e1b7d94f6a0e5b3d2c9a1f4e7b" },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const nonce = crypto.randomBytes(16).toString("hex");
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes expiry
      await prisma.siweNonce.create({
        data: {
          nonce,
          expiresAt,
        },
      });
      return reply.send({ nonce });
    },
  );

  // Verify SIWE signature and issue session token
  app.post(
    "/v1/auth/verify",
    {
      schema: {
        summary: "Verify a SIWE signature and issue a session token",
        description:
          "Validates the signed EIP-4361 (Sign-In With Ethereum) message and nonce. " +
          "On success, returns a bearer token valid for 2 hours. " +
          "Include the token in the `Authorization: Bearer <token>` header on subsequent requests.",
        tags: ["Auth"],
        body: {
          type: "object",
          required: ["message", "signature"],
          properties: {
            message: {
              type: "string",
              description: "EIP-4361 SIWE message string",
              example:
                "localhost wants you to sign in with your Ethereum account:\n" +
                "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045\n\n" +
                "Sign in to GuildPass\n\n" +
                "URI: http://localhost:3000\nVersion: 1\nChain ID: 1\n" +
                "Nonce: a3f8c2e1b7d94f6a0e5b3d2c9a1f4e7b\nIssued At: 2026-07-28T12:00:00Z",
            },
            signature: {
              type: "string",
              description: "Hex-encoded ECDSA signature over the SIWE message",
              example:
                "0x4a8f2c1d3e7b6a9f5c2e0d8b1a4f3e7c9d5b2a8e1c4f6b3a7d9e2c5f8a1b4e7c0d3f6a9b2e5c8f1a4b7d0e3f6a9c2d5e8f1b4a7c0d3f6a92e",
            },
          },
          example: {
            message:
              "localhost wants you to sign in with your Ethereum account:\n" +
              "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045\n\n" +
              "Sign in to GuildPass\n\n" +
              "URI: http://localhost:3000\nVersion: 1\nChain ID: 1\n" +
              "Nonce: a3f8c2e1b7d94f6a0e5b3d2c9a1f4e7b\nIssued At: 2026-07-28T12:00:00Z",
            signature:
              "0x4a8f2c1d3e7b6a9f5c2e0d8b1a4f3e7c9d5b2a8e1c4f6b3a7d9e2c5f8a1b4e7c0d3f6a9b2e5c8f1a4b7d0e3f6a9c2d5e8f1b4a7c0d3f6a92e",
          },
        },
        response: {
          200: {
            description: "Session token issued — valid for 2 hours",
            type: "object",
            required: ["token", "expiresAt", "walletAddress"],
            properties: {
              token: {
                type: "string",
                description: "Bearer token to include in the Authorization header",
                example: "7e3f1a9b4c2d6e8f0a1b3c5d7e9f2a4b",
              },
              expiresAt: {
                type: "string",
                format: "date-time",
                description: "ISO 8601 timestamp when the session expires",
                example: "2026-07-28T14:00:00.000Z",
              },
              walletAddress: {
                type: "string",
                description: "Checksummed wallet address extracted from the SIWE message",
                example: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
              },
            },
            example: {
              token: "7e3f1a9b4c2d6e8f0a1b3c5d7e9f2a4b",
              expiresAt: "2026-07-28T14:00:00.000Z",
              walletAddress: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
            },
          },
          400: {
            description: "Invalid SIWE message, expired nonce, or signature mismatch",
            type: "object",
            required: ["error", "code", "message", "statusCode"],
            properties: {
              error: { type: "string", example: "VALIDATION_ERROR" },
              code: { type: "string", example: "VALIDATION_ERROR" },
              message: { type: "string", example: "Nonce has expired" },
              statusCode: { type: "integer", example: 400 },
            },
            example: {
              error: "VALIDATION_ERROR",
              code: "VALIDATION_ERROR",
              message: "Nonce has expired",
              statusCode: 400,
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { message, signature } = request.body as {
        message: string;
        signature: string;
      };
      if (!message || !signature) {
        return reply
          .status(400)
          .send({ error: "Missing message or signature" });
      }

      let parsedMessage;
      try {
        const { parseSiweMessage } = require("./lib/auth/auth");
        parsedMessage = parseSiweMessage(message);
      } catch (err) {
        return reply.status(400).send(validationError("Invalid SIWE message format"));
      }

      const storedNonce = await prisma.siweNonce.findUnique({
        where: { nonce: parsedMessage.nonce },
      });

      if (!storedNonce) {
        return reply.status(400).send(validationError("Invalid nonce"));
      }

      if (new Date(storedNonce.expiresAt) < new Date()) {
        return reply.status(400).send(validationError("Nonce has expired"));
      }

      await prisma.siweNonce.delete({ where: { id: storedNonce.id } });

      try {
        const walletAddress = verifySiweSignature(
          message,
          signature,
          parsedMessage.nonce,
        );
        const token = crypto.randomBytes(32).toString("hex");
        const sessionExpiry = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours

        const session = await prisma.session.create({
          data: {
            walletAddress: walletAddress.toLowerCase(),
            token,
            expiresAt: sessionExpiry,
          },
        });

        return reply.send({
          token: session.token,
          expiresAt: session.expiresAt.toISOString(),
          walletAddress: session.walletAddress,
        });
      } catch (err) {
        return reply
          .status(400)
          .send({
            error:
              err instanceof Error
                ? err.message
                : "Signature verification failed",
          });
      }
    },
  );

  // --- Wallet Linking Routes ---

  // Generate a challenge
  app.post(
    "/v1/wallets/:primaryWallet/challenges",
    {
      schema: {
        summary: "Generate a wallet-link challenge",
        description:
          "Creates a one-time challenge that the secondary wallet must sign to " +
          "prove ownership before it can be linked to the primary wallet.",
        tags: ["Wallets"],
        params: {
          type: "object",
          required: ["primaryWallet"],
          properties: {
            primaryWallet: {
              type: "string",
              pattern: "^0x[0-9a-fA-F]{40}$",
              description: "Primary EVM wallet address",
              example: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
            },
          },
        },
        body: {
          type: "object",
          required: ["secondaryWallet"],
          properties: {
            secondaryWallet: {
              type: "string",
              pattern: "^0x[0-9a-fA-F]{40}$",
              description: "Secondary EVM wallet address to link",
              example: "0xAbCd1234567890AbCd1234567890AbCd12345678",
            },
          },
          example: { secondaryWallet: "0xAbCd1234567890AbCd1234567890AbCd12345678" },
        },
        response: {
          200: {
            description: "Challenge generated — pass to POST /v1/wallets/:primaryWallet/link",
            type: "object",
            properties: {
              challenge: { type: "string", description: "Opaque challenge string to sign", example: "guildpass-link:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045:0xAbCd1234567890AbCd1234567890AbCd12345678:1722168000000" },
              expiresAt: { type: "string", format: "date-time", example: "2026-07-28T12:10:00.000Z" },
            },
            example: {
              challenge: "guildpass-link:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045:0xAbCd1234567890AbCd1234567890AbCd12345678:1722168000000",
              expiresAt: "2026-07-28T12:10:00.000Z",
            },
          },
          400: {
            description: "Invalid wallet address or wallets are already linked",
            type: "object",
            required: ["error", "code", "message", "statusCode"],
            properties: {
              error: { type: "string", example: "VALIDATION_ERROR" },
              code: { type: "string", example: "VALIDATION_ERROR" },
              message: { type: "string", example: "Invalid wallet address" },
              statusCode: { type: "integer", example: 400 },
            },
            example: {
              error: "VALIDATION_ERROR",
              code: "VALIDATION_ERROR",
              message: "Invalid wallet address",
              statusCode: 400,
            },
          },
          409: {
            description: "Wallets are already linked",
            type: "object",
            required: ["error", "code", "message", "statusCode"],
            properties: {
              error: { type: "string", example: "CONFLICT" },
              code: { type: "string", example: "CONFLICT" },
              message: { type: "string", example: "Wallets are already linked" },
              statusCode: { type: "integer", example: 409 },
            },
            example: {
              error: "CONFLICT",
              code: "CONFLICT",
              message: "Wallets are already linked",
              statusCode: 409,
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { primaryWallet } = request.params as { primaryWallet: string };
      const { secondaryWallet } = request.body as { secondaryWallet: string };
      try {
        const challenge = await identityService.generateChallenge(
          primaryWallet as WalletAddress,
          secondaryWallet as WalletAddress,
        );
        return reply.send(challenge);
      } catch (error) {
        if (error instanceof IdentityServiceError) {
          return reply.status(error.statusCode).send(
            createApiError({
              statusCode: error.statusCode,
              code: error.statusCode === 404 ? 'NOT_FOUND' : error.statusCode === 400 ? 'VALIDATION_ERROR' : error.statusCode === 409 ? 'CONFLICT' : error.statusCode === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR',
              message: error.message
            })
          );
        }
        throw error;
      }
    },
  );

  // Link a wallet using a challenge and signature
  app.post(
    "/v1/wallets/:primaryWallet/link",
    {
      schema: {
        summary: "Link a secondary wallet to a primary wallet",
        description:
          "Completes the wallet-link flow by submitting the challenge " +
          "(from `POST /v1/wallets/:primaryWallet/challenges`) and the " +
          "secondary wallet's signature over that challenge.",
        tags: ["Wallets"],
        params: {
          type: "object",
          required: ["primaryWallet"],
          properties: {
            primaryWallet: {
              type: "string",
              pattern: "^0x[0-9a-fA-F]{40}$",
              description: "Primary EVM wallet address",
              example: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
            },
          },
        },
        body: {
          type: "object",
          required: ["challenge", "signature"],
          properties: {
            challenge: {
              type: "object",
              description: "Challenge object returned by POST /v1/wallets/:primaryWallet/challenges",
              example: { challenge: "guildpass-link:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045:0xAbCd1234567890AbCd1234567890AbCd12345678:1722168000000", expiresAt: "2026-07-28T12:10:00.000Z" },
            },
            signature: {
              type: "string",
              description: "Hex-encoded ECDSA signature of the challenge by the secondary wallet",
              example: "0x9b3c2a1e4f7d6b8a5c0e2f9d1b4a7c3e6f8b2d5a1c4e7f0b3d6a9c2e5f8b1d4a7c0e3f6a9b2c5e8f1b4d7a0c3f6a9b2e5c8f1a4b7d0e3f6a92e",
            },
          },
          example: {
            challenge: {
              challenge: "guildpass-link:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045:0xAbCd1234567890AbCd1234567890AbCd12345678:1722168000000",
              expiresAt: "2026-07-28T12:10:00.000Z",
            },
            signature: "0x9b3c2a1e4f7d6b8a5c0e2f9d1b4a7c3e6f8b2d5a1c4e7f0b3d6a9c2e5f8b1d4a7c0e3f6a9b2c5e8f1b4d7a0c3f6a9b2e5c8f1a4b7d0e3f6a92e",
          },
        },
        response: {
          200: {
            description: "Wallets successfully linked",
            type: "object",
            properties: {
              primaryWallet: { type: "string", example: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" },
              secondaryWallet: { type: "string", example: "0xabcd1234567890abcd1234567890abcd12345678" },
              linkedAt: { type: "string", format: "date-time", example: "2026-07-28T12:05:00.000Z" },
            },
            example: {
              primaryWallet: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
              secondaryWallet: "0xabcd1234567890abcd1234567890abcd12345678",
              linkedAt: "2026-07-28T12:05:00.000Z",
            },
          },
          400: {
            description: "Invalid or expired challenge, or signature mismatch",
            type: "object",
            required: ["error", "code", "message", "statusCode"],
            properties: {
              error: { type: "string", example: "VALIDATION_ERROR" },
              code: { type: "string", example: "VALIDATION_ERROR" },
              message: { type: "string", example: "Challenge has expired" },
              statusCode: { type: "integer", example: 400 },
            },
            example: {
              error: "VALIDATION_ERROR",
              code: "VALIDATION_ERROR",
              message: "Challenge has expired",
              statusCode: 400,
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { primaryWallet } = request.params as { primaryWallet: string };
      const { challenge, signature } = request.body as {
        challenge: Challenge;
        signature: string;
      };
      try {
        const linkResult = await identityService.linkWallet({
          challenge,
          signature,
        });
        return reply.send(linkResult);
      } catch (error) {
        if (error instanceof IdentityServiceError) {
          return reply.status(error.statusCode).send(
            createApiError({
              statusCode: error.statusCode,
              code: error.statusCode === 404 ? 'NOT_FOUND' : error.statusCode === 400 ? 'VALIDATION_ERROR' : error.statusCode === 409 ? 'CONFLICT' : error.statusCode === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR',
              message: error.message
            })
          );
        }
        throw error;
      }
    },
  );

  // Get linked wallets for a primary wallet
  app.get(
    "/v1/wallets/:primaryWallet/linked",
    {
      schema: {
        summary: "List wallets linked to a primary wallet",
        description: "Returns all secondary wallet addresses that have been successfully linked to the given primary wallet.",
        tags: ["Wallets"],
        params: {
          type: "object",
          required: ["primaryWallet"],
          properties: {
            primaryWallet: {
              type: "string",
              pattern: "^0x[0-9a-fA-F]{40}$",
              description: "Primary EVM wallet address",
              example: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
            },
          },
        },
        response: {
          200: {
            description: "Linked wallets for the primary address",
            type: "object",
            required: ["primaryWallet", "linkedWallets"],
            properties: {
              primaryWallet: { type: "string", example: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" },
              linkedWallets: {
                type: "array",
                items: { type: "string" },
                example: ["0xabcd1234567890abcd1234567890abcd12345678"],
              },
            },
            example: {
              primaryWallet: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
              linkedWallets: ["0xabcd1234567890abcd1234567890abcd12345678"],
            },
          },
          404: {
            description: "Primary wallet not found",
            type: "object",
            required: ["error", "code", "message", "statusCode"],
            properties: {
              error: { type: "string", example: "NOT_FOUND" },
              code: { type: "string", example: "NOT_FOUND" },
              message: { type: "string", example: "Wallet not found" },
              statusCode: { type: "integer", example: 404 },
            },
            example: {
              error: "NOT_FOUND",
              code: "NOT_FOUND",
              message: "Wallet not found",
              statusCode: 404,
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { primaryWallet } = request.params as { primaryWallet: string };
      try {
        const linkedWallets = await identityService.getLinkedWallets(
          primaryWallet as WalletAddress,
        );
        return reply.send({ primaryWallet, linkedWallets });
      } catch (error) {
        if (error instanceof IdentityServiceError) {
          return reply.status(error.statusCode).send(
            createApiError({
              statusCode: error.statusCode,
              code: error.statusCode === 404 ? 'NOT_FOUND' : error.statusCode === 400 ? 'VALIDATION_ERROR' : error.statusCode === 409 ? 'CONFLICT' : error.statusCode === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR',
              message: error.message
            })
          );
        }
        throw error;
      }
    },
  );

  // --- Appeals and Moderation Routes ---

  // File an appeal for a suspended member
  app.post(
    "/v1/memberships/:wallet/appeals",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { wallet } = request.params as { wallet: string };
      const { communityId, reason } = request.body as {
        communityId: string;
        reason: string;
      };
      if (!communityId || !reason) {
        return reply
          .status(400)
          .send({ error: "Missing communityId or reason" });
      }
      try {
        const result = await moderationService.fileAppeal(
          wallet,
          communityId,
          reason,
        );
        return reply.send(result);
      } catch (error) {
        if (error instanceof ModerationError) {
          return reply.status(error.statusCode).send(
            createApiError({
              statusCode: error.statusCode,
              code: error.statusCode === 404 ? 'NOT_FOUND' : error.statusCode === 400 ? 'VALIDATION_ERROR' : error.statusCode === 409 ? 'CONFLICT' : error.statusCode === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR',
              message: error.message
            })
          );
        }
        throw error;
      }
    },
  );

  // Transition an appeal status (Admin only)
  app.post(
    "/v1/appeals/:appealId/transition",
    { preHandler: [authenticateApiKey] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { appealId } = request.params as { appealId: string };
      const { status, adminComment } = request.body as {
        status: string;
        adminComment?: string;
      };
      if (!status) {
        return reply.status(400).send(validationError("Missing status"));
      }
      try {
        const result = await moderationService.transitionAppeal(
          appealId,
          status as any,
          adminComment,
        );
        return reply.send(result);
      } catch (error) {
        if (error instanceof ModerationError) {
          return reply.status(error.statusCode).send(
            createApiError({
              statusCode: error.statusCode,
              code: error.statusCode === 404 ? 'NOT_FOUND' : error.statusCode === 400 ? 'VALIDATION_ERROR' : error.statusCode === 409 ? 'CONFLICT' : error.statusCode === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR',
              message: error.message
            })
          );
        }
        throw error;
      }
    },
  );

  // GET /v1/communities/:communityId/roles — list valid roles and hierarchy for a community
  app.get('/v1/communities/:communityId/roles', { schema: getCommunityRolesSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId } = request.params as { communityId: string };
    const community = await prisma.community.findUnique({ where: { id: communityId } });
    if (!community) {
      return reply.status(404).send(notFound('Community not found'));
    }

    return {
      roles: [
        {
          name: 'admin',
          description: 'Administrator with full permissions',
          implies: ['contributor', 'member'],
        },
        {
          name: 'contributor',
          description: 'Contributor with write permissions',
          implies: ['member'],
        },
        {
          name: 'member',
          description: 'Standard member with basic permissions',
          implies: [],
        },
      ],
    };
  });

  // GET /v1/communities/:communityId/memberships/:wallet — list membership communities for a wallet
  app.get(
    "/v1/communities/:communityId/memberships/:wallet",
    { schema: getMembershipsSchema },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId, wallet } = request.params as {
        communityId: string;
        wallet: string;
      };
      const result = await memberService.getMembershipsByWallet(
        wallet,
        communityId,
      );
      return result;
    },
  );

  // GET /v1/communities/:communityId/members/:wallet — get member profile
  app.get(
    "/v1/communities/:communityId/members/:wallet",
    { schema: getMemberProfileSchema },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId, wallet } = request.params as {
        communityId: string;
        wallet: string;
      };
      const result = await memberService.getProfileByWallet(
        wallet,
        communityId,
      );
      if (!result) {
        return reply.status(404).send(notFound("Member not found"));
      }
      return result;
    },
  );

  // POST /v1/communities/:communityId/members/:wallet/roles — assign a role to a member
  app.post('/v1/communities/:communityId/members/:wallet/roles', { schema: assignMemberRoleSchema, preHandler: [authenticateApiKey, requireSiweSession, idempotencyPreHandler], onSend: [idempotencyOnSend] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId, wallet } = request.params as { communityId: string; wallet: string };
    const body = request.body as { role?: string; expiresAt?: string | null };
    const role = body.role;
    const requesterWallet = resolveRequesterWallet(request);

    if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      return reply.status(400).send(validationErrorWithReason('INVALID_WALLET', 'Invalid wallet format'));
    }

    const community = await prisma.community.findUnique({ where: { id: communityId } });
    if (!community) {
      return reply.status(400).send(validationErrorWithReason('UNKNOWN_COMMUNITY', 'Unknown communityId'));
    }

    if (!role || !(VALID_ROLES as readonly string[]).includes(role)) {
      return reply.status(400).send(validationErrorWithReason('INVALID_ROLE', 'Unrecognized role'));
    }

    try {
      const result = await memberService.assignMemberRole({
        requesterWallet: requesterWallet as import('@guildpass/shared-types').WalletAddress,
        communityId,
        targetWallet: wallet as import('@guildpass/shared-types').WalletAddress,
        role: role as import('@guildpass/shared-types').Role,
        expiresAt: body.expiresAt,
      });
      return reply.status(200).send(result);
    } catch (error) {
      return sendRoleMutationError(reply, error);
    }
  });

  // DELETE /v1/communities/:communityId/members/:wallet/roles/:role — remove an assigned role
  app.delete('/v1/communities/:communityId/members/:wallet/roles/:role', { schema: removeMemberRoleSchema, preHandler: [authenticateApiKey, requireSiweSession, idempotencyPreHandler], onSend: [idempotencyOnSend] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId, wallet, role } = request.params as { communityId: string; wallet: string; role: string };
    const requesterWallet = resolveRequesterWallet(request);

    if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      return reply.status(400).send(validationErrorWithReason('INVALID_WALLET', 'Invalid wallet format'));
    }

    const community = await prisma.community.findUnique({ where: { id: communityId } });
    if (!community) {
      return reply.status(400).send(validationErrorWithReason('UNKNOWN_COMMUNITY', 'Unknown communityId'));
    }

    if (!role || !(VALID_ROLES as readonly string[]).includes(role)) {
      return reply.status(400).send(validationErrorWithReason('INVALID_ROLE', 'Unrecognized role'));
    }

    try {
      const result = await memberService.removeMemberRole({
        requesterWallet: requesterWallet as import('@guildpass/shared-types').WalletAddress,
        communityId,
        targetWallet: wallet as import('@guildpass/shared-types').WalletAddress,
        role: role as import('@guildpass/shared-types').Role,
      });
      return reply.status(200).send(result);
    } catch (error) {
      return sendRoleMutationError(reply, error);
    }
  });

  // POST /v1/communities/:communityId/members/:wallet/badges — assign a badge to a member
  app.post(
    "/v1/communities/:communityId/members/:wallet/badges",
    {
      schema: assignBadgeSchema,
      preHandler: [authenticateApiKey, requireSiweSession, idempotencyPreHandler],
      onSend: [idempotencyOnSend],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId, wallet } = request.params as {
        communityId: string;
        wallet: string;
      };
      const body = request.body as { label?: string };
      const label = body?.label ?? "";
      const requesterWallet = getRequesterWallet(request);

      if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
        return reply
          .status(400)
          .send(
            validationErrorWithReason(
              "INVALID_WALLET",
              "Invalid wallet format",
            ),
          );
      }

      const community = await prisma.community.findUnique({
        where: { id: communityId },
      });
      if (!community) {
        return reply
          .status(400)
          .send(
            validationErrorWithReason(
              "UNKNOWN_COMMUNITY",
              "Unknown communityId",
            ),
          );
      }

      if (!label.trim()) {
        return reply
          .status(400)
          .send(validationError("Missing required field: label"));
      }

      try {
        const result = await memberService.assignBadge({
          requesterWallet:
            requesterWallet as import("@guildpass/shared-types").WalletAddress,
          communityId,
          targetWallet:
            wallet as import("@guildpass/shared-types").WalletAddress,
          label,
        });
        return reply.status(200).send(result);
      } catch (error) {
        return sendRoleMutationError(reply, error);
      }
    },
  );

  // GET /v1/communities/:communityId/members/:wallet/badges — list badges for a member
  app.get(
    "/v1/communities/:communityId/members/:wallet/badges",
    { schema: listBadgesSchema },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId, wallet } = request.params as {
        communityId: string;
        wallet: string;
      };

      if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
        return reply
          .status(400)
          .send(
            validationErrorWithReason(
              "INVALID_WALLET",
              "Invalid wallet format",
            ),
          );
      }

      const community = await prisma.community.findUnique({
        where: { id: communityId },
      });
      if (!community) {
        return reply
          .status(400)
          .send(
            validationErrorWithReason(
              "UNKNOWN_COMMUNITY",
              "Unknown communityId",
            ),
          );
      }

      const result = await memberService.listBadgesForMember(
        communityId,
        wallet,
      );
      if (!result) {
        return reply.status(404).send(notFound("Member not found"));
      }
      return reply.status(200).send(result);
    },
  );

  // DELETE /v1/communities/:communityId/members/:wallet/badges/:badgeId — revoke a badge
  app.delete(
    "/v1/communities/:communityId/members/:wallet/badges/:badgeId",
    {
      schema: revokeBadgeSchema,
      preHandler: [authenticateApiKey, requireSiweSession, idempotencyPreHandler],
      onSend: [idempotencyOnSend],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId, wallet, badgeId } = request.params as {
        communityId: string;
        wallet: string;
        badgeId: string;
      };
      const requesterWallet = getRequesterWallet(request);

      if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
        return reply
          .status(400)
          .send(
            validationErrorWithReason(
              "INVALID_WALLET",
              "Invalid wallet format",
            ),
          );
      }

      const community = await prisma.community.findUnique({
        where: { id: communityId },
      });
      if (!community) {
        return reply
          .status(400)
          .send(
            validationErrorWithReason(
              "UNKNOWN_COMMUNITY",
              "Unknown communityId",
            ),
          );
      }

      try {
        const result = await memberService.revokeBadge({
          requesterWallet:
            requesterWallet as import("@guildpass/shared-types").WalletAddress,
          communityId,
          targetWallet:
            wallet as import("@guildpass/shared-types").WalletAddress,
          badgeId,
        });
        return reply.status(200).send(result);
      } catch (error) {
        return sendRoleMutationError(reply, error);
      }
    },
  );

  // POST /v1/communities/:communityId/overrides — create or update an access override for a wallet/resource
  app.post(
    "/v1/communities/:communityId/overrides",
    {
      schema: createAccessOverrideSchema,
      preHandler: [authenticateApiKey, requireSiweSession, idempotencyPreHandler],
      onSend: [idempotencyOnSend],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId } = request.params as { communityId: string };
      const body = request.body as {
        wallet?: string;
        resource?: string;
        effect?: string;
        reason?: string;
        expiresAt?: string | null;
      };
      if (!body?.wallet || !body?.resource || !body?.effect) {
        return reply
          .status(400)
          .send(
            validationError(
              "Missing required fields: wallet, resource, effect",
            ),
          );
      }
      const requesterWallet = getRequesterWallet(request);
      try {
        const result = await memberService.createAccessOverride({
          requesterWallet:
            requesterWallet as import("@guildpass/shared-types").WalletAddress,
          communityId,
          wallet:
            body.wallet as import("@guildpass/shared-types").WalletAddress,
          resource: body.resource,
          effect: body.effect as "ALLOW" | "DENY",
          reason: body.reason,
          expiresAt: body.expiresAt ?? null,
        });
        return reply.status(200).send(result);
      } catch (error) {
        return sendRoleMutationError(reply, error);
      }
    },
  );

  // GET /v1/communities/:communityId/overrides — list access overrides for a community (admin)
  app.get('/v1/communities/:communityId/overrides', { schema: listAccessOverridesSchema, preHandler: [authenticateApiKey, requireSiweSession] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId } = request.params as { communityId: string };
    const body = request.body as {
      wallet?: string;
      resource?: string;
      effect?: string;
      reason?: string;
      expiresAt?: string | null;
    };
    if (!body?.wallet || !body?.resource || !body?.effect) {
      return reply.status(400).send(
        validationError('Missing required fields: wallet, resource, effect'),
      );
    }
    const requesterWallet = resolveRequesterWallet(request);
    try {
      if (!(await requireCommunityAdmin(communityId, requesterWallet))) {
        return reply.status(403).send(forbidden('Forbidden'));
      }
      const result = await memberService.listAccessOverrides(communityId, requesterWallet);
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof MemberServiceError) {
        return reply.status(error.statusCode).send(
            createApiError({
              statusCode: error.statusCode,
              code: error.statusCode === 404 ? 'NOT_FOUND' : error.statusCode === 400 ? 'VALIDATION_ERROR' : error.statusCode === 409 ? 'CONFLICT' : error.statusCode === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR',
              message: error.message
            })
          );
      }
      return reply.status(500).send(internalError('Internal server error'));
    }
  });

  // DELETE /v1/communities/:communityId/overrides/:wallet/:resource — revoke an access override
  app.delete('/v1/communities/:communityId/overrides/:wallet/:resource', { schema: revokeAccessOverrideSchema, preHandler: [authenticateApiKey, requireSiweSession, idempotencyPreHandler], onSend: [idempotencyOnSend] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId, wallet, resource } = request.params as { communityId: string; wallet: string; resource: string };
    const requesterWallet = resolveRequesterWallet(request);
    try {
      const result = await memberService.revokeAccessOverride({
        requesterWallet: requesterWallet as import('@guildpass/shared-types').WalletAddress,
        communityId,
        wallet: wallet as import('@guildpass/shared-types').WalletAddress,
        resource,
        effect: 'DENY',
      });
      return reply.status(200).send(result);
    } catch (error) {
      return sendRoleMutationError(reply, error);
    }
  });

  // POST /v1/access/check — check access for wallet/resource
  app.post<{ Body: AccessCheckBody }>(
      "/v1/access/check",
      {
        schema: accessCheckSchema,
        preHandler: app.accessCheckRateLimitHook
          ? [app.accessCheckRateLimitHook]
          : undefined,
      },
      async (request: FastifyRequest<{ Body: AccessCheckBody }>, reply: FastifyReply) => {
        const { wallet, communityId, resource } = request.body;

        // Normalize wallet address
        const normalizedWallet = wallet.toLowerCase() as `0x${string}`;

        const result = await memberService.checkAccess({
          wallet: normalizedWallet,
          communityId,
          resource,
        } as import("@guildpass/shared-types").AccessCheckInput);

        return result;
      },
    );


 // Helper function (defined OUTSIDE the route handler)
  async function requireCommunityAdmin(
    communityId: string,
    requesterWallet: string,
  ): Promise<boolean> {
    return memberService.isCommunityAdmin(communityId, requesterWallet);
  }

  // GET /v1/communities/:communityId/members — offset-paginated, sortable admin
  // listing (#259). Returns the shared { data, total, page, pageSize,
  // nextCursor } envelope; supersedes the cursor-based listing from #236.
  app.get(
    "/v1/communities/:communityId/members",
    {
      schema: listCommunityMembersSchema,
      preHandler: [authenticateApiKey, requireSiweSession],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId } = request.params as { communityId: string };
      const parsedQuery = memberListQuerySchema.safeParse(request.query ?? {});
      if (!parsedQuery.success) {
        return reply
          .status(400)
          .send(
            validationError(
              "Invalid query parameters",
              parsedQuery.error.flatten(),
            ),
          );
      }
      const { role, status, page, pageSize, sort } = parsedQuery.data;
      const requesterWallet = getRequesterWallet(request);
      try {
        if (!(await requireCommunityAdmin(communityId, requesterWallet))) {
          return reply.status(403).send(forbidden("Forbidden"));
        }
        const result = await memberService.listMembersForAdmin(communityId, {
          role,
          status,
          page,
          pageSize,
          sort,
        });
        return reply.status(200).send(result);
      } catch (error) {
        if (error instanceof MemberServiceError) {
          return reply.status(error.statusCode).send(
            createApiError({
              statusCode: error.statusCode,
              code:
                error.statusCode === 404
                  ? "NOT_FOUND"
                  : error.statusCode === 400
                    ? "VALIDATION_ERROR"
                    : error.statusCode === 409
                      ? "CONFLICT"
                      : error.statusCode === 403
                        ? "FORBIDDEN"
                        : "INTERNAL_ERROR",
              message: error.message,
            }),
          );
        }
        return reply.status(500).send(internalError("Internal server error"));
      }
    },
  );

  // GET /v1/communities/:communityId/dead-letter-events — inspect webhook
  // deliveries that exhausted the outbox's retry budget
  app.get(
    "/v1/communities/:communityId/dead-letter-events",
    { schema: listDeadLetterEventsSchema, preHandler: [authenticateApiKey, requireSiweSession] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId } = request.params as { communityId: string };
      const { status } = request.query as {
        status?: "pending" | "retried" | "resolved";
      };
      const requesterWallet = getRequesterWallet(request);
      try {
        if (!(await requireCommunityAdmin(communityId, requesterWallet))) {
          return reply.status(403).send(forbidden("Forbidden"));
        }
        const events = await listDeadLetterEvents(getPrisma(), {
          communityId,
          status,
        });
        return { events };
      } catch (error) {
        if (error instanceof MemberServiceError) {
          return reply.status(error.statusCode).send(
            createApiError({
              statusCode: error.statusCode,
              code: error.statusCode === 404 ? 'NOT_FOUND' : error.statusCode === 400 ? 'VALIDATION_ERROR' : error.statusCode === 409 ? 'CONFLICT' : error.statusCode === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR',
              message: error.message
            })
          );
        }
        return reply.status(500).send(internalError("Internal server error"));
      }
    },
  );

  // POST /v1/communities/:communityId/dead-letter-events/:id/retry — re-enqueue
  // a dead-lettered event as a fresh pending OutboxEvent
  app.post(
    "/v1/communities/:communityId/dead-letter-events/:id/retry",
    { schema: retryDeadLetterEventSchema, preHandler: [authenticateApiKey, requireSiweSession] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId, id } = request.params as {
        communityId: string;
        id: string;
      };
      const requesterWallet = getRequesterWallet(request);
      try {
        if (!(await requireCommunityAdmin(communityId, requesterWallet))) {
          return reply.status(403).send(forbidden("Forbidden"));
        }
        const result = await retryDeadLetterEvent(getPrisma(), id);
        return reply.status(200).send(result);
      } catch (error) {
        if (error instanceof DeadLetterNotFoundError) {
          return reply.status(404).send(notFound(error.message));
        }
        if (error instanceof DeadLetterAlreadyResolvedError) {
          return reply.status(409).send(conflict(error.message));
        }
        if (error instanceof MemberServiceError) {
          return reply.status(error.statusCode).send(
            createApiError({
              statusCode: error.statusCode,
              code: error.statusCode === 404 ? 'NOT_FOUND' : error.statusCode === 400 ? 'VALIDATION_ERROR' : error.statusCode === 409 ? 'CONFLICT' : error.statusCode === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR',
              message: error.message
            })
          );
        }
        return reply.status(500).send(internalError("Internal server error"));
      }
    },
  );

  // Issue #243 path aliases for the dead-letter admin surface (same handlers).
  // Prefer these or the dead-letter-events routes interchangeably.
  app.get(
    "/v1/communities/:communityId/outbox/failed",
    { schema: listDeadLetterEventsSchema, preHandler: [authenticateApiKey, requireSiweSession] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId } = request.params as { communityId: string };
      const { status } = request.query as {
        status?: "pending" | "retried" | "resolved";
      };
      const requesterWallet = getRequesterWallet(request);
      try {
        if (!(await requireCommunityAdmin(communityId, requesterWallet))) {
          return reply.status(403).send(forbidden("Forbidden"));
        }
        const events = await listDeadLetterEvents(getPrisma(), {
          communityId,
          status: status ?? "pending",
        });
        return { events };
      } catch (error) {
        if (error instanceof MemberServiceError) {
          return reply.status(error.statusCode).send(
            createApiError({
              statusCode: error.statusCode,
              code:
                error.statusCode === 404
                  ? "NOT_FOUND"
                  : error.statusCode === 400
                    ? "VALIDATION_ERROR"
                    : error.statusCode === 409
                      ? "CONFLICT"
                      : error.statusCode === 403
                        ? "FORBIDDEN"
                        : "INTERNAL_ERROR",
              message: error.message,
            }),
          );
        }
        return reply.status(500).send(internalError("Internal server error"));
      }
    },
  );

  app.post(
    "/v1/communities/:communityId/outbox/:id/retry",
    { schema: retryDeadLetterEventSchema, preHandler: [authenticateApiKey, requireSiweSession] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId, id } = request.params as {
        communityId: string;
        id: string;
      };
      const requesterWallet = getRequesterWallet(request);
      try {
        if (!(await requireCommunityAdmin(communityId, requesterWallet))) {
          return reply.status(403).send(forbidden("Forbidden"));
        }
        const result = await retryDeadLetterEvent(getPrisma(), id);
        return reply.status(200).send(result);
      } catch (error) {
        if (error instanceof DeadLetterNotFoundError) {
          return reply.status(404).send(notFound(error.message));
        }
        if (error instanceof DeadLetterAlreadyResolvedError) {
          return reply.status(409).send(conflict(error.message));
        }
        if (error instanceof MemberServiceError) {
          return reply.status(error.statusCode).send(
            createApiError({
              statusCode: error.statusCode,
              code:
                error.statusCode === 404
                  ? "NOT_FOUND"
                  : error.statusCode === 400
                    ? "VALIDATION_ERROR"
                    : error.statusCode === 409
                      ? "CONFLICT"
                      : error.statusCode === 403
                        ? "FORBIDDEN"
                        : "INTERNAL_ERROR",
              message: error.message,
            }),
          );
        }
        return reply.status(500).send(internalError("Internal server error"));
      }
    },
  );

  // --- Admin Audit Trace Routes ---

  // GET /admin/audit/trace/* — query audit traces (by txHash, wallet, or correlationId)
  app.get('/admin/audit/trace/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const wildcard = (request.params as any)['*'];

    if (wildcard.startsWith('tx/')) {
      const txHash = wildcard.substring(3);
      const result = await getAuditTracesByTxHash(txHash, prisma);
      return { txHash, traces: result };
    }

    if (wildcard.startsWith('wallet/')) {
      const wallet = wildcard.substring(7);
      const { communityId } = request.query as { communityId?: string };
      if (!communityId) {
        return reply.status(400).send(validationError('communityId query parameter is required'));
      }
      const result = await getAuditTracesByWallet(wallet, communityId, 50, prisma);
      return {
        wallet,
        communityId,
        traces: result,
      };
    }

    // Default: treat as correlationId
    const correlationId = wildcard;
    const result = await getAuditTraceByCorrelationId(correlationId, prisma);
    if (!result) {
      return reply.status(404).send(notFound('Audit trace not found'));
    }
    return result;
  });

  // GET /v1/communities/:communityId/audit-events — filterable, paginated audit events for community admin
  app.get(
    "/v1/communities/:communityId/audit-events",
    { schema: listAuditEventsSchema, preHandler: [authenticateApiKey, requireSiweSession] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId } = request.params as { communityId: string };
      const { actorWallet, eventType, resource, from, to, page, limit } =
        request.query as {
          actorWallet?: string;
          eventType?: string;
          resource?: string;
          from?: string;
          to?: string;
          page?: number;
          limit?: number;
        };
      const requesterWallet = getRequesterWallet(request);
      try {
        if (!(await requireCommunityAdmin(communityId, requesterWallet))) {
          return reply.status(403).send(forbidden("Forbidden"));
        }

        let parsedFrom: Date | undefined = undefined;
        let parsedTo: Date | undefined = undefined;

        if (from) {
          parsedFrom = new Date(from);
          if (isNaN(parsedFrom.getTime())) {
            return reply
              .status(400)
              .send(validationError("Invalid from date format"));
          }
        }

        if (to) {
          parsedTo = new Date(to);
          if (isNaN(parsedTo.getTime())) {
            return reply
              .status(400)
              .send(validationError("Invalid to date format"));
          }
        }

        const result = await queryAuditEvents(getPrisma(), {
          communityId,
          actorWallet,
          eventType,
          resource,
          from: parsedFrom,
          to: parsedTo,
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
        });

        return result;
      } catch (error) {
        if (error instanceof MemberServiceError) {
          return reply.status(error.statusCode).send(
            createApiError({
              statusCode: error.statusCode,
              code: error.statusCode === 404 ? 'NOT_FOUND' : error.statusCode === 400 ? 'VALIDATION_ERROR' : error.statusCode === 409 ? 'CONFLICT' : error.statusCode === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR',
              message: error.message
            })
          );
        }
        return reply.status(500).send(internalError("Internal server error"));
      }
    },
  );

  // --- Resource Routes ---

  app.post('/v1/communities/:communityId/resources', { schema: createResourceSchema, preHandler: [authenticateApiKey, requireSiweSession, idempotencyPreHandler], onSend: [idempotencyOnSend] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId } = request.params as { communityId: string };
    const body = request.body as { resourceId: string; name: string; metadata?: any };
    const requesterWallet = getRequesterWallet(request);
    try {
      const result = await resourceService.upsertResource({
        requesterWallet,
        communityId,
        resourceId: body.resourceId,
        name: body.name,
        metadata: body.metadata,
      });
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof ResourceServiceError) {
        return reply.status(error.statusCode).send(
            createApiError({
              statusCode: error.statusCode,
              code: error.statusCode === 404 ? 'NOT_FOUND' : error.statusCode === 400 ? 'VALIDATION_ERROR' : error.statusCode === 409 ? 'CONFLICT' : error.statusCode === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR',
              message: error.message
            })
          );
      }
      return reply.status(500).send(internalError('Internal server error'));
    }
  });

  app.patch('/v1/communities/:communityId/resources/:resourceId', { schema: updateResourceSchema, preHandler: [authenticateApiKey, requireSiweSession, idempotencyPreHandler], onSend: [idempotencyOnSend] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId, resourceId } = request.params as { communityId: string; resourceId: string };
    const body = request.body as { name?: string; metadata?: any };
    const requesterWallet = getRequesterWallet(request);
    try {
      const result = await resourceService.updateResource({
        requesterWallet,
        communityId,
        resourceId,
        name: body.name,
        metadata: body.metadata,
      });
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof ResourceServiceError) {
        return reply.status(error.statusCode).send(
            createApiError({
              statusCode: error.statusCode,
              code: error.statusCode === 404 ? 'NOT_FOUND' : error.statusCode === 400 ? 'VALIDATION_ERROR' : error.statusCode === 409 ? 'CONFLICT' : error.statusCode === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR',
              message: error.message
            })
          );
      }
      return reply.status(500).send(internalError('Internal server error'));
    }
  });

  app.delete('/v1/communities/:communityId/resources/:resourceId', { schema: archiveResourceSchema, preHandler: [authenticateApiKey, requireSiweSession, idempotencyPreHandler], onSend: [idempotencyOnSend] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId, resourceId } = request.params as { communityId: string; resourceId: string };
    const requesterWallet = getRequesterWallet(request);
    try {
      const result = await resourceService.archiveResource({
        requesterWallet,
        communityId,
        resourceId,
      });
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof ResourceServiceError) {
        return reply.status(error.statusCode).send(
            createApiError({
              statusCode: error.statusCode,
              code: error.statusCode === 404 ? 'NOT_FOUND' : error.statusCode === 400 ? 'VALIDATION_ERROR' : error.statusCode === 409 ? 'CONFLICT' : error.statusCode === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR',
              message: error.message
            })
          );
      }
      return reply.status(500).send(internalError('Internal server error'));
    }
  });

  app.get('/v1/communities/:communityId/resources', { schema: listResourcesSchema, preHandler: [authenticateApiKey] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId } = request.params as { communityId: string };
    // listResources does not strictly require admin auth according to the service definition
    try {
      const result = await resourceService.listResources(communityId);
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof ResourceServiceError) {
        return reply.status(error.statusCode).send(
            createApiError({
              statusCode: error.statusCode,
              code: error.statusCode === 404 ? 'NOT_FOUND' : error.statusCode === 400 ? 'VALIDATION_ERROR' : error.statusCode === 409 ? 'CONFLICT' : error.statusCode === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR',
              message: error.message
            })
          );
      }
      return reply.status(500).send(internalError('Internal server error'));
    }
  });

  // --- Constitutional Rule Set Management Routes ---

  // POST /v1/communities/:communityId/constitutional-rulesets — Create a new versioned constitutional rule set
  app.post('/v1/communities/:communityId/constitutional-rulesets', {
    preHandler: [authenticateApiKey, requireSiweSession],
    schema: {
      summary: 'Create a new versioned constitutional rule set',
      description:
        'Creates an immutable, versioned rule set that constrains all role ' +
        'mutations, policy updates, and override actions within the community. ' +
        'The new version becomes active immediately; previous versions are archived.',
      tags: ['Constitutional Rules'],
      params: {
        type: 'object',
        required: ['communityId'],
        properties: {
          communityId: { type: 'string', description: 'Community identifier', example: 'community-mainnet-42' },
        },
      },
      body: {
        type: 'object',
        required: ['rules'],
        properties: {
          rules: {
            type: 'array',
            description: 'Array of constitutional rule objects',
            items: { type: 'object', additionalProperties: true },
            example: [{ type: 'COOLDOWN', action: 'ROLE_ASSIGNMENT', durationMs: 86400000 }],
          },
          description: {
            type: 'string',
            description: 'Human-readable description of this rule set version',
            example: 'Adds a 24-hour cooldown between consecutive role assignments',
          },
        },
        example: {
          rules: [{ type: 'COOLDOWN', action: 'ROLE_ASSIGNMENT', durationMs: 86400000 }],
          description: 'Adds a 24-hour cooldown between consecutive role assignments',
        },
      },
      response: {
        201: {
          description: 'Rule set version created and activated',
          type: 'object',
          properties: {
            id: { type: 'string', example: 'crs_01HZ9K3XB7E4F2WQMN8VDTG1R' },
            communityId: { type: 'string', example: 'community-mainnet-42' },
            version: { type: 'integer', example: 3 },
            description: { type: 'string', example: 'Adds a 24-hour cooldown between consecutive role assignments' },
            createdBy: { type: 'string', example: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045' },
            createdAt: { type: 'string', format: 'date-time', example: '2026-07-28T12:00:00.000Z' },
          },
          example: {
            id: 'crs_01HZ9K3XB7E4F2WQMN8VDTG1R',
            communityId: 'community-mainnet-42',
            version: 3,
            description: 'Adds a 24-hour cooldown between consecutive role assignments',
            createdBy: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
            createdAt: '2026-07-28T12:00:00.000Z',
          },
        },
        400: {
          description: 'Missing rules array or invalid rule definition',
          type: 'object',
          required: ['error', 'code', 'message', 'statusCode'],
          properties: {
            error: { type: 'string', example: 'VALIDATION_ERROR' },
            code: { type: 'string', example: 'VALIDATION_ERROR' },
            message: { type: 'string', example: "Missing required field: rules array" },
            statusCode: { type: 'integer', example: 400 },
          },
          example: {
            error: 'VALIDATION_ERROR',
            code: 'VALIDATION_ERROR',
            message: 'Missing required field: rules array',
            statusCode: 400,
          },
        },
        401: {
          description: 'Unauthorized',
          type: 'object',
          required: ['error', 'code', 'message', 'statusCode'],
          properties: {
            error: { type: 'string', example: 'UNAUTHORIZED' },
            code: { type: 'string', example: 'UNAUTHORIZED' },
            message: { type: 'string', example: 'Missing or invalid API key' },
            statusCode: { type: 'integer', example: 401 },
          },
          example: {
            error: 'UNAUTHORIZED',
            code: 'UNAUTHORIZED',
            message: 'Missing or invalid API key',
            statusCode: 401,
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId } = request.params as { communityId: string };
    const body = request.body as { rules?: any[]; description?: string };
    const requesterWallet = getRequesterWallet(request);

    if (!body?.rules || !Array.isArray(body.rules)) {
      return reply.status(400).send(validationError('Missing required field: rules array'));
    }

    try {
      const result = await createConstitutionalRuleSet(prisma, {
        communityId,
        rules: body.rules,
        createdBy: requesterWallet,
        description: body.description,
      });
      return reply.status(201).send(result);
    } catch (error) {
      return reply.status(400).send(validationError(error instanceof Error ? error.message : 'Invalid rule set'));
    }
  });

  // GET /v1/communities/:communityId/constitutional-rulesets — List all rule set versions
  app.get('/v1/communities/:communityId/constitutional-rulesets', {
    preHandler: [authenticateApiKey],
    schema: {
      summary: 'List all constitutional rule set versions for a community',
      description: 'Returns every version of the community constitutional rule set in descending order (newest first). The active version is the first entry.',
      tags: ['Constitutional Rules'],
      params: {
        type: 'object',
        required: ['communityId'],
        properties: {
          communityId: { type: 'string', description: 'Community identifier', example: 'community-mainnet-42' },
        },
      },
      response: {
        200: {
          description: 'All rule set versions',
          type: 'object',
          required: ['communityId', 'versions'],
          properties: {
            communityId: { type: 'string', example: 'community-mainnet-42' },
            versions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  version: { type: 'integer' },
                  description: { type: 'string', nullable: true },
                  createdBy: { type: 'string' },
                  createdAt: { type: 'string', format: 'date-time' },
                },
              },
              example: [
                { id: 'crs_01HZ9K3XB7E4F2WQMN8VDTG1R', version: 3, description: 'Adds a 24-hour cooldown', createdBy: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045', createdAt: '2026-07-28T12:00:00.000Z' },
                { id: 'crs_01HZ8B2WA6D3E1VPLN7UCSH0Q', version: 2, description: null, createdBy: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045', createdAt: '2026-06-15T09:00:00.000Z' },
              ],
            },
          },
          example: {
            communityId: 'community-mainnet-42',
            versions: [
              { id: 'crs_01HZ9K3XB7E4F2WQMN8VDTG1R', version: 3, description: 'Adds a 24-hour cooldown', createdBy: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045', createdAt: '2026-07-28T12:00:00.000Z' },
            ],
          },
        },
        401: {
          description: 'Unauthorized',
          type: 'object',
          required: ['error', 'code', 'message', 'statusCode'],
          properties: {
            error: { type: 'string', example: 'UNAUTHORIZED' },
            code: { type: 'string', example: 'UNAUTHORIZED' },
            message: { type: 'string', example: 'Missing or invalid API key' },
            statusCode: { type: 'integer', example: 401 },
          },
          example: {
            error: 'UNAUTHORIZED',
            code: 'UNAUTHORIZED',
            message: 'Missing or invalid API key',
            statusCode: 401,
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId } = request.params as { communityId: string };
    const result = await getConstitutionalRuleSetVersions(prisma, communityId);
    return { communityId, versions: result };
  });

  // GET /v1/communities/:communityId/constitutional-rulesets/active — Get current active rule set
  app.get('/v1/communities/:communityId/constitutional-rulesets/active', {
    schema: {
      summary: 'Get the currently active constitutional rule set',
      description: 'Returns the highest-version rule set that is currently enforced for this community. Returns 404 when no rule set has been created yet.',
      tags: ['Constitutional Rules'],
      params: {
        type: 'object',
        required: ['communityId'],
        properties: {
          communityId: { type: 'string', description: 'Community identifier', example: 'community-mainnet-42' },
        },
      },
      response: {
        200: {
          description: 'Active constitutional rule set',
          type: 'object',
          properties: {
            id: { type: 'string', example: 'crs_01HZ9K3XB7E4F2WQMN8VDTG1R' },
            communityId: { type: 'string', example: 'community-mainnet-42' },
            version: { type: 'integer', example: 3 },
            rules: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
              example: [{ type: 'COOLDOWN', action: 'ROLE_ASSIGNMENT', durationMs: 86400000 }],
            },
            description: { type: 'string', nullable: true, example: 'Adds a 24-hour cooldown between consecutive role assignments' },
            createdBy: { type: 'string', example: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045' },
            createdAt: { type: 'string', format: 'date-time', example: '2026-07-28T12:00:00.000Z' },
          },
          example: {
            id: 'crs_01HZ9K3XB7E4F2WQMN8VDTG1R',
            communityId: 'community-mainnet-42',
            version: 3,
            rules: [{ type: 'COOLDOWN', action: 'ROLE_ASSIGNMENT', durationMs: 86400000 }],
            description: 'Adds a 24-hour cooldown between consecutive role assignments',
            createdBy: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
            createdAt: '2026-07-28T12:00:00.000Z',
          },
        },
        404: {
          description: 'No active constitutional rule set found for this community',
          type: 'object',
          required: ['error', 'code', 'message', 'statusCode'],
          properties: {
            error: { type: 'string', example: 'NOT_FOUND' },
            code: { type: 'string', example: 'NOT_FOUND' },
            message: { type: 'string', example: 'No active constitutional rule set found for this community' },
            statusCode: { type: 'integer', example: 404 },
          },
          example: {
            error: 'NOT_FOUND',
            code: 'NOT_FOUND',
            message: 'No active constitutional rule set found for this community',
            statusCode: 404,
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { communityId } = request.params as { communityId: string };
    const active = await getActiveConstitutionalRuleSet(prisma, communityId);
    if (!active) {
      return reply.status(404).send(notFound('No active constitutional rule set found for this community'));
    }
    return active;
  });

  // PUT /v1/communities/:communityId/resources/:resource/policy — Create or update custom rule tree policy
  app.put(
    '/v1/communities/:communityId/resources/:resource/policy',
    { schema: updateCustomPolicySchema, preHandler: [authenticateApiKey] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { communityId, resource } = request.params as { communityId: string; resource: string };
      const body = request.body as { ruleTree: any; requiredPermissions?: string[] };

      if (!body || !body.ruleTree) {
        return reply.status(400).send(validationError('Missing required field: ruleTree'));
      }

      const validation = validateRuleTree(body.ruleTree);
      if (!validation.valid) {
        return reply.status(400).send(validationErrorWithReason('Invalid rule tree AST', validation.errors.join('; ')));
      }

      try {
        const policy = await memberService.upsertAccessPolicy(
          communityId,
          resource,
          'COMPOSABLE',
          { ruleTree: body.ruleTree },
          body.requiredPermissions,
        );
        return reply.status(200).send({ success: true, policy });
      } catch (error) {
        return reply.status(500).send(internalError(error instanceof Error ? error.message : 'Failed to update policy'));
      }
    }
  );
}
