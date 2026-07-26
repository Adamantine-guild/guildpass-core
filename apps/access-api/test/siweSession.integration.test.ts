import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { ethers } from "ethers";
import { registerRoutes } from "../src/routes";
import { config } from "../src/config";

// ---------------------------------------------------------------------------
// Mock Prisma (same shape/pattern as test/auth.test.ts)
// ---------------------------------------------------------------------------
const mockPrisma = {
  session: {
    create: jest.fn(),
    findUnique: jest.fn(),
    delete: jest.fn(),
  },
  siweNonce: {
    create: jest.fn(),
    findUnique: jest.fn(),
    delete: jest.fn(),
  },
  community: {
    findUnique: jest.fn(),
  },
  member: {
    findFirst: jest.fn(),
  },
  $transaction: jest.fn().mockImplementation((cb) => cb(mockPrisma)),
};

jest.mock("../src/services/prisma", () => ({
  getPrisma: () => mockPrisma,
}));

jest.mock("../src/services/auditChainHasher", () => ({
  writeChainedAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

// A representative admin-gated mutation route (roles assignment).
const ADMIN_ROUTE =
  "/v1/communities/community-1/members/0x1111111111111111111111111111111111111111/roles";
const API_KEY = "test-api-key"; // default configured key

describe("#240 SIWE session enforcement on admin/mutation routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await registerRoutes(app);
    await app.ready();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (config as any).siweEnforced = false; // reset per test; each block sets it
  });

  // -------------------------------------------------------------------------
  // SIWE nonce / verify endpoint semantics (AC: endpoints exist & are tested)
  // -------------------------------------------------------------------------
  describe("/v1/auth/verify", () => {
    function buildSiweMessage(address: string, nonce: string): string {
      return (
        `localhost:3000 wants you to sign in with your Ethereum account:\n` +
        `${address}\n\n` +
        `URI: http://localhost:3000\n` +
        `Version: 1\n` +
        `Chain ID: 1\n` +
        `Nonce: ${nonce}\n` +
        `Issued At: ${new Date().toISOString()}`
      );
    }

    test("valid SIWE signature mints a session token (200)", async () => {
      const user = ethers.Wallet.createRandom();
      const nonce = "validnonce001";
      const message = buildSiweMessage(user.address, nonce);
      const signature = await user.signMessage(message);

      (mockPrisma.siweNonce.findUnique as jest.Mock).mockResolvedValue({
        id: "nonce-id",
        nonce,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      });
      (mockPrisma.session.create as jest.Mock).mockResolvedValue({
        token: "sess-token-1",
        walletAddress: user.address.toLowerCase(),
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      });

      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/verify",
        payload: { message, signature },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).token).toBe("sess-token-1");
      expect(mockPrisma.siweNonce.delete).toHaveBeenCalled(); // one-time use
    });

    test("rejects an expired nonce (400)", async () => {
      const user = ethers.Wallet.createRandom();
      const nonce = "expirednonce002";
      const message = buildSiweMessage(user.address, nonce);
      const signature = await user.signMessage(message);

      (mockPrisma.siweNonce.findUnique as jest.Mock).mockResolvedValue({
        id: "nonce-id",
        nonce,
        expiresAt: new Date(Date.now() - 1000), // already expired
      });

      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/verify",
        payload: { message, signature },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/expired/i);
    });

    test("rejects a reused/unknown nonce (400)", async () => {
      const user = ethers.Wallet.createRandom();
      const nonce = "reusednonce003";
      const message = buildSiweMessage(user.address, nonce);
      const signature = await user.signMessage(message);

      // Nonce already consumed -> no longer in the table.
      (mockPrisma.siweNonce.findUnique as jest.Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/verify",
        payload: { message, signature },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/nonce/i);
    });

    test("rejects a signature that does not match the message address (400)", async () => {
      const user = ethers.Wallet.createRandom();
      const attacker = ethers.Wallet.createRandom();
      const nonce = "badsignonce004";
      const message = buildSiweMessage(user.address, nonce); // claims `user`
      const signature = await attacker.signMessage(message); // signed by attacker

      (mockPrisma.siweNonce.findUnique as jest.Mock).mockResolvedValue({
        id: "nonce-id",
        nonce,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      });

      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/verify",
        payload: { message, signature },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Enforcement ON (AC: spoofed headers rejected; sessions expire; no replay)
  // -------------------------------------------------------------------------
  describe("with SIWE_ENFORCED = true", () => {
    beforeEach(() => {
      (config as any).siweEnforced = true;
    });

    test("rejects a spoofed x-wallet header with no session (401)", async () => {
      const res = await app.inject({
        method: "POST",
        url: ADMIN_ROUTE,
        headers: {
          "x-api-key": API_KEY,
          // Attacker asserts an admin identity purely via header — must fail.
          "x-wallet": "0x2222222222222222222222222222222222222222",
        },
        payload: { role: "admin" },
      });

      expect(res.statusCode).toBe(401);
      expect(mockPrisma.session.findUnique).not.toHaveBeenCalled();
    });

    test("rejects an expired session and cannot be replayed (401)", async () => {
      (mockPrisma.session.findUnique as jest.Mock).mockResolvedValue({
        id: "sess-id",
        token: "expired-token",
        walletAddress: "0x3333333333333333333333333333333333333333",
        expiresAt: new Date(Date.now() - 1000), // expired
      });
      // The expired session is best-effort pruned via .delete(...).catch(...);
      // the mock must return a promise so the .catch chain resolves.
      (mockPrisma.session.delete as jest.Mock).mockResolvedValue({});

      const res = await app.inject({
        method: "POST",
        url: ADMIN_ROUTE,
        headers: {
          "x-api-key": API_KEY,
          authorization: "Bearer expired-token",
        },
        payload: { role: "admin" },
      });

      expect(res.statusCode).toBe(401);
      expect(mockPrisma.session.delete).toHaveBeenCalled(); // pruned, not replayable
    });

    test("accepts a request carrying a valid verified session (not 401)", async () => {
      const admin = ethers.Wallet.createRandom();
      (mockPrisma.session.findUnique as jest.Mock).mockResolvedValue({
        id: "sess-id",
        token: "good-token",
        walletAddress: admin.address.toLowerCase(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      (mockPrisma.community.findUnique as jest.Mock).mockResolvedValue({
        id: "community-1",
      });

      const res = await app.inject({
        method: "POST",
        url: ADMIN_ROUTE,
        headers: {
          "x-api-key": API_KEY,
          authorization: "Bearer good-token",
        },
        payload: { role: "admin" },
      });

      // The session preHandler passed; downstream authz/service logic may still
      // reject (403/400), but never with 401 from the auth layer.
      expect(res.statusCode).not.toBe(401);
      expect(mockPrisma.session.findUnique).toHaveBeenCalledWith({
        where: { token: "good-token" },
      });
    });
  });

  // -------------------------------------------------------------------------
  // Legacy mode OFF (AC: migration path — no breaking change by default)
  // -------------------------------------------------------------------------
  describe("with SIWE_ENFORCED = false (legacy, default)", () => {
    test("preserves header-based identity so existing clients are not broken", async () => {
      (mockPrisma.community.findUnique as jest.Mock).mockResolvedValue({
        id: "community-1",
      });

      const res = await app.inject({
        method: "POST",
        url: ADMIN_ROUTE,
        headers: {
          "x-api-key": API_KEY,
          "x-wallet": "0x4444444444444444444444444444444444444444",
        },
        payload: { role: "admin" },
      });

      // Legacy behaviour intact: request proceeds past auth (no forced 401).
      expect(res.statusCode).not.toBe(401);
    });
  });
});
