import { PrismaClient } from "@prisma/client";
import {
  AccessCheckInput,
  AccessDecision,
  RoleContext,
} from "@guildpass/shared-types";
import { evaluate } from "@guildpass/policy-engine";
import { logEvent } from "./auditService";

const prisma = new PrismaClient();

export function getMemberService(prismaOverride?: PrismaClient) {
  const db = prismaOverride ?? prisma;
  return {
    async getMembershipsByWallet(wallet: string, communityId: string) {
      const w = await db.wallet.findUnique({
        where: { address: wallet.toLowerCase() },
      });
      if (!w) return { wallet, communities: [] };
      const members = await db.member.findMany({
        where: { walletId: w.id, communityId },
        include: { membership: true },
      });
      const communities = members.map((m) => ({
        communityId: m.communityId,
        state: m.membership?.state || "invited",
        expiresAt: m.membership?.expiresAt?.toISOString() ?? null,
      }));
      return { wallet, communities };
    },
    async getProfileByWallet(wallet: string, communityId: string) {
      const w = await db.wallet.findUnique({
        where: { address: wallet.toLowerCase() },
      });
      if (!w) return null;
      const m = await db.member.findFirst({
        where: { walletId: w.id, communityId },
        include: { profile: true, membership: true, roles: true },
      });
      if (!m) return null;
      return {
        wallet,
        communityId: m.communityId,
        profile: {
          id: m.profile?.id ?? "",
          displayName: m.profile?.displayName ?? "",
          bio: m.profile?.bio ?? "",
        },
        membership: {
          state: m.membership?.state ?? "invited",
          expiresAt: m.membership?.expiresAt?.toISOString() ?? null,
        },
        roles: m.roles.filter((r) => r.active).map((r) => r.role),
      };
    },

    async checkAccess(input: AccessCheckInput): Promise<AccessDecision> {
      const wallet = input.wallet.toLowerCase();
      const w = await db.wallet.findUnique({ where: { address: wallet } });
      if (!w) {
        return {
          allowed: false,
          code: "DENY",
          reasons: [{ code: "NO_WALLET", message: "Wallet not known" }],
          membershipState: "invited",
          effectiveRoles: [],
        };
      }
      const member = await db.member.findFirst({
        where: { walletId: w.id, communityId: input.communityId },
        include: { roles: true, membership: true },
      });
      if (!member) {
        return {
          allowed: false,
          code: "DENY",
          reasons: [
            {
              code: "NOT_MEMBER",
              message: "Wallet is not a member of community",
            },
          ],
          membershipState: "invited",
          effectiveRoles: [],
        };
      }
      const policy = await db.accessPolicy.findFirst({
        where: { communityId: input.communityId, resource: input.resource },
      });
      const ruleType = policy ? policy.ruleType : "MEMBERS_ONLY";
      const ctx: RoleContext = {
        assignments: member.roles.map((r) => ({
          role: r.role as any,
          source: r.source as any,
          active: r.active,
        })),
        membershipState: (member.membership?.state as any) ?? "invited",
      };
      const decision = evaluate(
        {
          id: policy?.id ?? "default",
          communityId: input.communityId,
          resource: input.resource,
          ruleType: ruleType,
          params: policy?.params as Record<string, any> | undefined,
        },
        ctx,
      );
      return decision;
    },
    async listMembersForAdmin(
      communityId: string,
      role?: "admin" | "member" | "contributor",
    ) {

      // TODO: add auth to ensure requester is admin
      const members = await db.member.findMany({
        where: { communityId },
        include: { wallet: true, membership: true, roles: true, profile: true },
      });
      const list = members
        .map((m) => {
          const activeRoles = m.roles
            .filter((r) => r.active)
            .map((r) => r.role);
          return {
            wallet: m.wallet.address,
            displayName: m.profile?.displayName ?? null,
            state: m.membership?.state ?? "invited",
            roles: activeRoles,
          };
        })
        .filter((item) => (role ? item.roles.includes(role) : true));
      return { communityId, members: list };
    },
  };
}
