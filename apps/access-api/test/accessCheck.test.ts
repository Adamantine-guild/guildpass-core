process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/guildpass";
process.env.RATE_LIMIT_ENABLED = "false";
delete process.env.REDIS_URL;

const checkAccess = jest.fn();

jest.mock("../src/services/memberService", () => ({
  getMemberService: jest.fn().mockReturnValue({
    checkAccess,
    isCommunityAdmin: jest.fn().mockResolvedValue(true),
  }),
  MemberServiceError: class MemberServiceError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 400) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

jest.mock("../src/services/prisma", () => ({
  getPrisma: jest.fn().mockReturnValue({
    $queryRaw: jest.fn(),
    community: { findUnique: jest.fn() },
    siweNonce: { create: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
    session: { create: jest.fn() },
  }),
  disconnectPrisma: jest.fn(),
}));

import { buildApp } from "../src/app";

describe("POST /v1/access/check", () => {
  let app: any;

  const validCommunityId = "community-1";
  const lowerWallet = "0x1234567890abcdef1234567890abcdef12345678";
  const checksummedWallet = "0x1234567890aBcDeF1234567890AbCdEf12345678";
  const validResource = "document:read";

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    checkAccess.mockReset();
    checkAccess.mockResolvedValue({ allowed: true, code: "ALLOW", reasons: [] });
  });

  describe("Happy Path & Normalization", () => {
    it("should allow access for valid request with a lowercased wallet", async () => {
      const mockResult = { allowed: true, code: "ALLOW", reasons: [] };
      checkAccess.mockResolvedValueOnce(mockResult);

      const response = await app.inject({
        method: "POST",
        url: "/v1/access/check",
        payload: {
          wallet: lowerWallet,
          communityId: validCommunityId,
          resource: validResource,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual(mockResult);
      expect(checkAccess).toHaveBeenCalledWith({
        wallet: lowerWallet,
        communityId: validCommunityId,
        resource: validResource,
      });
    });

    it("should normalize checksummed/mixed-case EVM addresses to lowercase before calling memberService", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/access/check",
        payload: {
          wallet: checksummedWallet,
          communityId: validCommunityId,
          resource: validResource,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(checkAccess).toHaveBeenCalledWith({
        wallet: lowerWallet,
        communityId: validCommunityId,
        resource: validResource,
      });
    });
  });

  describe("Schema Validation — Missing Required Fields", () => {
    it("should return 400 if payload is completely empty", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/access/check",
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(checkAccess).not.toHaveBeenCalled();
    });

    it("should return 400 if wallet is missing", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/access/check",
        payload: {
          communityId: validCommunityId,
          resource: validResource,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.stringify(JSON.parse(response.payload))).toMatch(/wallet/i);
      expect(checkAccess).not.toHaveBeenCalled();
    });

    it("should return 400 if communityId is missing", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/access/check",
        payload: {
          wallet: lowerWallet,
          resource: validResource,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.stringify(JSON.parse(response.payload))).toMatch(/communityId/i);
      expect(checkAccess).not.toHaveBeenCalled();
    });

    it("should return 400 if resource is missing", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/access/check",
        payload: {
          wallet: lowerWallet,
          communityId: validCommunityId,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.stringify(JSON.parse(response.payload))).toMatch(/resource/i);
      expect(checkAccess).not.toHaveBeenCalled();
    });
  });

  describe("Schema Validation — Malformed Wallet Address", () => {
    it.each([
      ["missing 0x prefix", "1234567890abcdef1234567890abcdef12345678"],
      ["too short", "0x12345"],
      ["too long", "0x1234567890abcdef1234567890abcdef123456789999"],
      ["invalid hex characters", "0xZZZZ567890abcdef1234567890abcdef12345678"],
      ["plain non-hex string", "invalid-wallet-format"],
      ["number type instead of string", 1234567890123456789012345678901234567890],
    ])("should return 400 when wallet is %s", async (_, invalidWallet) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/access/check",
        payload: {
          wallet: invalidWallet,
          communityId: validCommunityId,
          resource: validResource,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(checkAccess).not.toHaveBeenCalled();
    });
  });

  describe("Schema Validation — Invalid Community ID and Resource", () => {
    it("should return 400 when communityId is an empty string", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/access/check",
        payload: {
          wallet: lowerWallet,
          communityId: "",
          resource: validResource,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(checkAccess).not.toHaveBeenCalled();
    });

    it("should return 400 when resource is an empty string", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/access/check",
        payload: {
          wallet: lowerWallet,
          communityId: validCommunityId,
          resource: "",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(checkAccess).not.toHaveBeenCalled();
    });
  });

  describe("Schema Validation — Strict Field Enforcement", () => {
    it("strips unexpected additional fields rather than rejecting the request", async () => {
      // Fastify's default AJV config removes additional properties when
      // additionalProperties: false is set, so the request still succeeds.
      const response = await app.inject({
        method: "POST",
        url: "/v1/access/check",
        payload: {
          wallet: lowerWallet,
          communityId: validCommunityId,
          resource: validResource,
          unexpectedRole: "admin",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(checkAccess).toHaveBeenCalledWith({
        wallet: lowerWallet,
        communityId: validCommunityId,
        resource: validResource,
      });
    });
  });
});
