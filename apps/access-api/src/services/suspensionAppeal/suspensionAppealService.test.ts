/**
 * Unit tests for suspension appeals (#249).
 */

import {
  getSuspensionAppealService,
  SuspensionAppealError,
  ACCESS_DENIED_WHILE_APPEAL_PENDING,
  PROVISIONAL_REINSTATEMENT_PENDING_REVIEW,
} from "./suspensionAppealService";

jest.mock("../auditService", () => ({
  logEventTx: jest.fn(async () => ({ id: "audit-1" })),
}));

jest.mock("../outboxService", () => ({
  logOutboxEventTx: jest.fn(async () => ({ eventId: "outbox-1", status: "pending" })),
}));

import { logEventTx } from "../auditService";
import { logOutboxEventTx } from "../outboxService";

const WALLET = "0x3333333333333333333333333333333333333333";
const ADMIN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COMMUNITY = "community-1";

function makePrisma(overrides: any = {}) {
  const state = {
    member: overrides.member ?? {
      id: "member-1",
      communityId: COMMUNITY,
      membership: {
        id: "membership-1",
        state: "suspended",
        tokenId: 3,
        chainId: 31337,
        activeToken: {
          id: "token-row-1",
          tokenId: 3,
          chainId: 31337,
          contractAddress: "0xcontract",
          state: "suspended",
        },
      },
      membershipTokens: [
        {
          id: "token-row-1",
          tokenId: 3,
          chainId: 31337,
          contractAddress: "0xcontract",
          state: "suspended",
        },
      ],
      wallet: { address: WALLET },
    },
    appeals: [] as any[],
    outbox: [] as any[],
  };

  const tx = {
    member: {
      findFirst: jest.fn(async () => state.member),
      findUnique: jest.fn(async () => state.member),
    },
    suspensionAppeal: {
      findFirst: jest.fn(async ({ where }: any) =>
        state.appeals.find(
          (a) =>
            a.memberId === (where.memberId ?? a.memberId) &&
            a.status === (where.status ?? a.status) &&
            a.communityId === (where.communityId ?? a.communityId),
        ),
      ),
      findUnique: jest.fn(async ({ where }: any) =>
        state.appeals.find((a) => a.id === where.id) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const appeal = {
          id: `appeal-${state.appeals.length + 1}`,
          ...data,
          submittedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        state.appeals.push(appeal);
        return appeal;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const idx = state.appeals.findIndex((a) => a.id === where.id);
        state.appeals[idx] = { ...state.appeals[idx], ...data };
        return state.appeals[idx];
      }),
      count: jest.fn(async () => state.appeals.length),
      findMany: jest.fn(async () => state.appeals),
    },
  };

  const prisma: any = {
    $transaction: async (fn: any) => fn(tx),
    suspensionAppeal: tx.suspensionAppeal,
    _state: state,
    _tx: tx,
  };

  return prisma;
}

describe("suspensionAppealService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("documents access-denied-while-pending default", () => {
    expect(ACCESS_DENIED_WHILE_APPEAL_PENDING).toBe(true);
    expect(PROVISIONAL_REINSTATEMENT_PENDING_REVIEW).toBe(false);
  });

  it("rejects appeal when membership is not suspended", async () => {
    const prisma = makePrisma({
      member: {
        id: "member-1",
        communityId: COMMUNITY,
        membership: {
          id: "membership-1",
          state: "active",
          activeToken: { id: "t1", tokenId: 1, state: "active" },
        },
        membershipTokens: [{ id: "t1", tokenId: 1, state: "active" }],
        wallet: { address: WALLET },
      },
    });
    const svc = getSuspensionAppealService(prisma);

    await expect(
      svc.submitAppeal({
        communityId: COMMUNITY,
        wallet: WALLET,
        memberStatement: "please reinstate",
        requesterWallet: WALLET,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects when requester is not the suspended member", async () => {
    const prisma = makePrisma();
    const svc = getSuspensionAppealService(prisma);

    await expect(
      svc.submitAppeal({
        communityId: COMMUNITY,
        wallet: WALLET,
        memberStatement: "please reinstate",
        requesterWallet: ADMIN,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects duplicate pending appeals", async () => {
    const prisma = makePrisma();
    const svc = getSuspensionAppealService(prisma);
    await svc.submitAppeal({
      communityId: COMMUNITY,
      wallet: WALLET,
      memberStatement: "first",
      requesterWallet: WALLET,
    });

    await expect(
      svc.submitAppeal({
        communityId: COMMUNITY,
        wallet: WALLET,
        memberStatement: "second",
        requesterWallet: WALLET,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("approve writes audit trail and MEMBERSHIP_UNSUSPEND_REQUESTED outbox without flipping membership active", async () => {
    const prisma = makePrisma();
    const svc = getSuspensionAppealService(prisma);
    const created = await svc.submitAppeal({
      communityId: COMMUNITY,
      wallet: WALLET,
      memberStatement: "I was wrongly suspended",
      requesterWallet: WALLET,
    });

    const decided = await svc.decideAppeal({
      communityId: COMMUNITY,
      appealId: created.id,
      decision: "approved",
      rationale: "Evidence reviewed; reinstate on-chain",
      reviewerWallet: ADMIN,
    });

    expect(decided.status).toBe("approved");
    expect(decided.reviewerId).toBe(ADMIN);
    expect(logEventTx).toHaveBeenCalled();
    expect(logOutboxEventTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "MEMBERSHIP_UNSUSPEND_REQUESTED",
        entityType: "SuspensionAppeal",
        payload: expect.objectContaining({
          requiresAuthorizedSigner: true,
          suspended: false,
          action: "setSuspended",
        }),
      }),
    );
    // Membership still suspended in mocked state — restoration waits for on-chain ingest
    expect(prisma._state.member.membershipTokens[0].state).toBe("suspended");
  });

  it("deny records audit and does not emit unsuspend outbox", async () => {
    const prisma = makePrisma();
    const svc = getSuspensionAppealService(prisma);
    const created = await svc.submitAppeal({
      communityId: COMMUNITY,
      wallet: WALLET,
      memberStatement: "please",
      requesterWallet: WALLET,
    });
    (logOutboxEventTx as jest.Mock).mockClear();

    await svc.decideAppeal({
      communityId: COMMUNITY,
      appealId: created.id,
      decision: "denied",
      rationale: "Insufficient evidence",
      reviewerWallet: ADMIN,
    });

    expect(logOutboxEventTx).not.toHaveBeenCalled();
    expect(logEventTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        reasonCode: "SUSPENSION_APPEAL_DENIED",
      }),
    );
  });

  it("rejects decisions on terminal appeals", async () => {
    const prisma = makePrisma();
    const svc = getSuspensionAppealService(prisma);
    const created = await svc.submitAppeal({
      communityId: COMMUNITY,
      wallet: WALLET,
      memberStatement: "please",
      requesterWallet: WALLET,
    });
    await svc.decideAppeal({
      communityId: COMMUNITY,
      appealId: created.id,
      decision: "denied",
      rationale: "no",
      reviewerWallet: ADMIN,
    });

    await expect(
      svc.decideAppeal({
        communityId: COMMUNITY,
        appealId: created.id,
        decision: "approved",
        rationale: "changed mind",
        reviewerWallet: ADMIN,
      }),
    ).rejects.toBeInstanceOf(SuspensionAppealError);
  });
});
