import { PrismaClient } from "@prisma/client";
import { getMemberService } from "./memberService";
import { InMemoryCacheService } from "./cacheService";

jest.mock("./auditService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

// Minimal Prisma mock: getMembershipsByWallet only reads wallet + member.
function buildMockPrisma() {
  return {
    wallet: {
      findUnique: jest.fn(async ({ where }: any) => ({
        id: "wallet-1",
        address: where.address,
      })),
    },
    member: {
      findMany: jest.fn(async () => [
        {
          communityId: "comm-1",
          membership: {
            activeToken: {
              state: "active",
              expiresAt: new Date(Date.now() + 86_400_000),
            },
          },
        },
      ]),
    },
  } as unknown as PrismaClient;
}

describe("getMembershipsByWallet — Redis caching (#178)", () => {
  const communityId = "comm-1";
  const walletLower = "0x00000000000000000000000000000000000000ab";
  const walletChecksum = "0x00000000000000000000000000000000000000AB";

  it("serves a repeated read from cache without hitting Postgres again", async () => {
    const prisma = buildMockPrisma();
    const svc = getMemberService(prisma, new InMemoryCacheService());

    const first = await svc.getMembershipsByWallet(walletLower, communityId);
    const second = await svc.getMembershipsByWallet(walletLower, communityId);

    expect(second).toEqual(first);
    // Only the first (cache-miss) read touches Postgres.
    expect((prisma as any).member.findMany).toHaveBeenCalledTimes(1);
    expect((prisma as any).wallet.findUnique).toHaveBeenCalledTimes(1);
  });

  it("re-reads from Postgres after the entry is invalidated", async () => {
    const prisma = buildMockPrisma();
    const svc = getMemberService(prisma, new InMemoryCacheService());

    await svc.getMembershipsByWallet(walletLower, communityId); // populate
    await svc.invalidateMembershipCache(communityId, walletLower); // clear
    await svc.getMembershipsByWallet(walletLower, communityId); // miss again

    expect((prisma as any).member.findMany).toHaveBeenCalledTimes(2);
  });

  it("never serves stale data to a mixed-case caller after invalidation", async () => {
    const prisma = buildMockPrisma();
    const svc = getMemberService(prisma, new InMemoryCacheService());

    // Checksummed caller populates the cache (viem/wagmi default spelling).
    await svc.getMembershipsByWallet(walletChecksum, communityId);
    // A repeat checksummed read is served from cache — same normalised key.
    await svc.getMembershipsByWallet(walletChecksum, communityId);
    expect((prisma as any).member.findMany).toHaveBeenCalledTimes(1);

    // Invalidation resolves from the DB's canonical lowercase form...
    await svc.invalidateMembershipCache(communityId, walletLower);

    // ...and the checksummed caller must NOT get the stale entry: it maps to
    // the same lowercased key that was just cleared, so this is a fresh read.
    await svc.getMembershipsByWallet(walletChecksum, communityId);
    expect((prisma as any).member.findMany).toHaveBeenCalledTimes(2);
  });
});
