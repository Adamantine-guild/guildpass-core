/**
 * Suspension appeals service (#249).
 *
 * State machine: pending → approved | denied (terminal).
 * One pending appeal per suspended membership.
 *
 * Default security posture: while an appeal is pending (and after approval,
 * until the on-chain unsuspend is ingested), access remains denied. The API
 * never auto-signs `setSuspended`; approval emits a durable outbox event for
 * an explicitly authorized operator / wallet step.
 */

import type { PrismaClient, SuspensionAppealStatus } from "@prisma/client";
import { logEventTx } from "../auditService";
import { logOutboxEventTx } from "../outboxService";

export class SuspensionAppealError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode: number = 400, code: string = "VALIDATION_ERROR") {
    super(message);
    this.name = "SuspensionAppealError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** Product default: suspension still applies while an appeal is pending. */
export const ACCESS_DENIED_WHILE_APPEAL_PENDING = true;

/** Provisional reinstatement during review is not enabled by default. */
export const PROVISIONAL_REINSTATEMENT_PENDING_REVIEW = false;

const TERMINAL: ReadonlySet<SuspensionAppealStatus> = new Set(["approved", "denied"]);

export type AppealDecision = "approved" | "denied";

export interface SubmitAppealInput {
  communityId: string;
  wallet: string;
  memberStatement: string;
  requesterWallet: string;
}

export interface DecideAppealInput {
  communityId: string;
  appealId: string;
  decision: AppealDecision;
  rationale: string;
  reviewerWallet: string;
}

export interface ListAppealsQuery {
  communityId: string;
  status?: SuspensionAppealStatus;
  page?: number;
  limit?: number;
}

function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

export function getSuspensionAppealService(prisma: PrismaClient) {
  async function submitAppeal(input: SubmitAppealInput) {
    const communityId = input.communityId;
    const wallet = normalizeWallet(input.wallet);
    const requester = normalizeWallet(input.requesterWallet);
    const statement = input.memberStatement?.trim() ?? "";

    if (!statement) {
      throw new SuspensionAppealError("memberStatement is required", 400, "VALIDATION_ERROR");
    }
    if (requester !== wallet) {
      throw new SuspensionAppealError(
        "Members may only appeal their own suspension",
        403,
        "FORBIDDEN",
      );
    }

    return prisma.$transaction(async (tx) => {
      const member = await tx.member.findFirst({
        where: {
          communityId,
          wallet: { address: wallet },
        },
        include: {
          membership: { include: { activeToken: true } },
          membershipTokens: true,
          wallet: true,
        },
      });

      if (!member || !member.membership) {
        throw new SuspensionAppealError("Member or membership not found", 404, "NOT_FOUND");
      }

      const tokens = member.membershipTokens ?? [];
      const suspendedToken =
        tokens.find((t) => t.state === "suspended") ??
        (member.membership.activeToken?.state === "suspended"
          ? member.membership.activeToken
          : undefined);

      const isSuspended =
        Boolean(suspendedToken) || member.membership.state === "suspended";

      if (!isSuspended) {
        throw new SuspensionAppealError(
          "No active suspension exists for this membership",
          400,
          "VALIDATION_ERROR",
        );
      }

      const pending = await tx.suspensionAppeal.findFirst({
        where: {
          communityId,
          memberId: member.id,
          status: "pending",
        },
      });
      if (pending) {
        throw new SuspensionAppealError(
          "A pending appeal already exists for this suspension",
          409,
          "CONFLICT",
        );
      }

      const tokenMeta = suspendedToken ?? member.membership.activeToken ?? tokens[0];

      const appeal = await tx.suspensionAppeal.create({
        data: {
          membershipId: member.membership.id,
          memberId: member.id,
          wallet,
          communityId,
          memberStatement: statement,
          status: "pending",
        },
      });

      await logEventTx(tx as any, {
        eventType: "OTHER",
        walletId: wallet,
        communityId,
        decision: "DENY",
        reasonCode: "SUSPENSION_APPEAL_SUBMITTED",
        beforeState: {
          membershipState: "suspended",
          tokenId: tokenMeta?.tokenId ?? null,
          accessDeniedWhilePending: ACCESS_DENIED_WHILE_APPEAL_PENDING,
          provisionalReinstatement: PROVISIONAL_REINSTATEMENT_PENDING_REVIEW,
        },
        afterState: {
          appealId: appeal.id,
          status: "pending",
        },
      });

      return appeal;
    });
  }

  async function listAppeals(query: ListAppealsQuery) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const where: any = { communityId: query.communityId };
    if (query.status) where.status = query.status;

    const [total, appeals] = await Promise.all([
      prisma.suspensionAppeal.count({ where }),
      prisma.suspensionAppeal.findMany({
        where,
        orderBy: { submittedAt: "asc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      appeals,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async function decideAppeal(input: DecideAppealInput) {
    const communityId = input.communityId;
    const appealId = input.appealId;
    const decision = input.decision;
    const rationale = input.rationale?.trim() ?? "";
    const reviewerWallet = normalizeWallet(input.reviewerWallet);

    if (decision !== "approved" && decision !== "denied") {
      throw new SuspensionAppealError(
        'decision must be "approved" or "denied"',
        400,
        "VALIDATION_ERROR",
      );
    }
    if (!rationale) {
      throw new SuspensionAppealError("reviewerRationale is required", 400, "VALIDATION_ERROR");
    }

    return prisma.$transaction(async (tx) => {
      const appeal = await tx.suspensionAppeal.findUnique({ where: { id: appealId } });
      if (!appeal || appeal.communityId !== communityId) {
        throw new SuspensionAppealError("Appeal not found", 404, "NOT_FOUND");
      }

      if (TERMINAL.has(appeal.status)) {
        throw new SuspensionAppealError(
          `Appeal is already ${appeal.status}; no further transitions are allowed`,
          400,
          "VALIDATION_ERROR",
        );
      }
      if (appeal.status !== "pending") {
        throw new SuspensionAppealError(
          `Invalid transition from ${appeal.status} to ${decision}`,
          400,
          "VALIDATION_ERROR",
        );
      }

      const member = await tx.member.findUnique({
        where: { id: appeal.memberId },
        include: {
          membership: { include: { activeToken: true } },
          membershipTokens: true,
          wallet: true,
        },
      });
      if (!member) {
        throw new SuspensionAppealError("Member not found", 404, "NOT_FOUND");
      }

      const updated = await tx.suspensionAppeal.update({
        where: { id: appealId },
        data: {
          status: decision,
          reviewerId: reviewerWallet,
          reviewedAt: new Date(),
          reviewerRationale: rationale,
        },
      });

      await logEventTx(tx as any, {
        eventType: "OTHER",
        walletId: appeal.wallet,
        communityId,
        decision: decision === "approved" ? "ALLOW" : "DENY",
        reasonCode:
          decision === "approved"
            ? "SUSPENSION_APPEAL_APPROVED"
            : "SUSPENSION_APPEAL_DENIED",
        beforeState: { appealStatus: "pending" },
        afterState: {
          appealId,
          appealStatus: decision,
          reviewerId: reviewerWallet,
          reviewerRationale: rationale,
        },
      });

      if (decision === "approved") {
        const suspendedToken =
          member.membershipTokens.find((t) => t.state === "suspended") ??
          member.membership?.activeToken ??
          null;

        // Do NOT flip off-chain membership to active here. Access stays denied
        // until the indexer ingests MembershipSuspended(isSuspended=false).
        // Emit an operator-facing outbox event for the authorized on-chain step.
        await logOutboxEventTx(tx as any, {
          eventType: "MEMBERSHIP_UNSUSPEND_REQUESTED",
          entityId: appeal.id,
          entityType: "SuspensionAppeal",
          communityId,
          payload: {
            appealId: appeal.id,
            membershipId: appeal.membershipId,
            memberId: appeal.memberId,
            wallet: appeal.wallet,
            communityId,
            tokenId: suspendedToken?.tokenId ?? member.membership?.tokenId ?? null,
            chainId: suspendedToken?.chainId ?? member.membership?.chainId ?? null,
            contractAddress: suspendedToken?.contractAddress ?? null,
            action: "setSuspended",
            suspended: false,
            requiresAuthorizedSigner: true,
            note:
              "API does not auto-sign. An authorized admin wallet or operator process must call MembershipNFT.setSuspended(tokenId, false).",
            reviewerId: reviewerWallet,
            reviewedAt: updated.reviewedAt?.toISOString() ?? new Date().toISOString(),
          },
        });
      }

      return updated;
    });
  }

  return {
    submitAppeal,
    listAppeals,
    decideAppeal,
  };
}
