import { buildApp } from "../src/app";
import { memberService } from "../src/services/memberService";

describe("POST /v1/access/check", () => {
  let app: any;

  // Valid fixture data
  const validUUID = "123e4567-e89b-12d3-a456-426614174000";
  const lowerWallet = "0x1234567890abcdef1234567890abcdef12345678";
  const checksummedWallet = "0x1234567890aBcDeF1234567890AbCdEf12345678";
  const validResource = "document:read";

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  beforeEach(() => {
    // Fixed: vi -> jest
    jest.clearAllMocks();
  });

  // ==========================================
  // 1. HAPPY PATH & NORMALIZATION TESTS
  // ==========================================
  describe("Happy Path & Normalization", () => {
    it("should allow access for valid request with a lowercased wallet", async () => {
      // Mock the service response
      const mockResult = { allowed: true, code: "ALLOW", reasons: [] };

      // Fixed: mockResolvedValueOnce added to match the signature
      const checkAccessSpy = jest
        .spyOn(memberService, "checkAccess")
        .mockResolvedValueOnce(mockResult as any);

      const response = await app.inject({
        method: "POST",
        url: "/v1/access/check",
        payload: {
          wallet: lowerWallet,
          communityId: validUUID,
          resource: validResource,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual(mockResult);

      // Verify service was called with correct arguments
      expect(checkAccessSpy).toHaveBeenCalledWith({
        wallet: lowerWallet,
        communityId: validUUID,
        resource: validResource,
      });
    });

    it("should normalize checksummed/mixed-case EVM addresses to lowercase before calling memberService", async () => {
      const mockResult = { allowed: true, code: "ALLOW", reasons: [] };

      // Fixed: vi -> jest
      const checkAccessSpy = jest
        .spyOn(memberService, "checkAccess")
        .mockResolvedValueOnce(mockResult as any);

      const response = await app.inject({
        method: "POST",
        url: "/v1/access/check",
        payload: {
          wallet: checksummedWallet,
          communityId: validUUID,
          resource: validResource,
        },
      });

      expect(response.statusCode).toBe(200);

      // Verify the wallet passed to the service is lowercased
      expect(checkAccessSpy).toHaveBeenCalledWith({
        wallet: lowerWallet, // Expected to be converted to lowercase
        communityId: validUUID,
        resource: validResource,
      });
    });
  });

  // ==========================================
  // 2. SCHEMA VALIDATION: MISSING FIELDS
  // ==========================================
  describe("Schema Validation — Missing Required Fields", () => {
    it("should return 400 if payload is completely empty", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/access/check",
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it("should return 400 if wallet is missing", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/access/check",
        payload: {
          communityId: validUUID,
          resource: validResource,
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.message || JSON.stringify(body)).toMatch(/wallet/i);
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
      const body = JSON.parse(response.payload);
      expect(body.message || JSON.stringify(body)).toMatch(/communityId/i);
    });

    it("should return 400 if resource is missing", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/access/check",
        payload: {
          wallet: lowerWallet,
          communityId: validUUID,
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.message || JSON.stringify(body)).toMatch(/resource/i);
    });
  });

  // ==========================================
  // 3. SCHEMA VALIDATION: MALFORMED WALLET
  // ==========================================
  describe("Schema Validation — Malformed Wallet Address", () => {
    it.each([
      ["missing 0x prefix", "1234567890abcdef1234567890abcdef12345678"],
      ["too short", "0x12345"],
      ["too long", "0x1234567890abcdef1234567890abcdef123456789999"],
      ["invalid hex characters", "0xZZZZ567890abcdef1234567890abcdef12345678"],
      ["plain non-hex string", "invalid-wallet-format"],
      ["number type instead of string", 1234567890123456789012345678901234567890],
    ])("should return 400 when wallet is %s", async (_, invalidWallet) => {
      // Fixed: vi -> jest
      const checkAccessSpy = jest.spyOn(memberService, "checkAccess");

      const response = await app.inject({
        method: "POST",
        url: "/v1/access/check",
        payload: {
          wallet: invalidWallet,
          communityId: validUUID,
          resource: validResource,
        },
      });

      expect(response.statusCode).toBe(400);

      // Verify policy engine was NOT called
      expect(checkAccessSpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================
  // 4. SCHEMA VALIDATION: MALFORMED COMMUNITY ID & RESOURCE
  // ==========================================
  describe("Schema Validation — Invalid Community ID and Resource", () => {
    it("should return 400 when communityId is not a valid UUID", async () => {
      // Fixed: vi -> jest
      const checkAccessSpy = jest.spyOn(memberService, "checkAccess");

      const response = await app.inject({
        method: "POST",
        url: "/v1/access/check",
        payload: {
          wallet: lowerWallet,
          communityId: "not-a-uuid-format",
          resource: validResource,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(checkAccessSpy).not.toHaveBeenCalled();
    });

    it("should return 400 when resource is an empty string", async () => {
      // Fixed: vi -> jest
      const checkAccessSpy = jest.spyOn(memberService, "checkAccess");

      const response = await app.inject({
        method: "POST",
        url: "/v1/access/check",
        payload: {
          wallet: lowerWallet,
          communityId: validUUID,
          resource: "", // Restricted by minLength: 1
        },
      });

      expect(response.statusCode).toBe(400);
      expect(checkAccessSpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================
  // 5. STRICT SCHEMA: ADDITIONAL PROPERTIES
  // ==========================================
  describe("Schema Validation — Strict Field Enforcement", () => {
    it("should return 400 when unexpected additional fields are provided", async () => {
      // Fixed: vi -> jest
      const checkAccessSpy = jest.spyOn(memberService, "checkAccess");

      const response = await app.inject({
        method: "POST",
        url: "/v1/access/check",
        payload: {
          wallet: lowerWallet,
          communityId: validUUID,
          resource: validResource,
          unexpectedRole: "admin", // additionalProperties: false should reject this
        },
      });

      expect(response.statusCode).toBe(400);
      expect(checkAccessSpy).not.toHaveBeenCalled();
    });
  });
});