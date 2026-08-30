/**
 * Capability Token Codec
 * 
 * A dependency-light capability token codec that signs constrained payloads
 * and verifies integrity, expiry, audience, and optional scope requirements.
 * 
 * This is NOT an authentication system and must not replace user sessions
 * or wallet authentication. Revocation is outside the scope of this primitive.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * The payload structure for capability tokens.
 */
export interface CapabilityPayload {
  /**
   * Token version for future compatibility.
   */
  version: 1;
  
  /**
   * Subject identifier (e.g., user ID, service ID).
   */
  subject: string;
  
  /**
   * Audience identifier (e.g., service name, API endpoint).
   */
  audience: string;
  
  /**
   * List of scopes/permissions granted by this token.
   */
  scopes: string[];
  
  /**
   * Unix timestamp when the token was issued.
   */
  issuedAt: number;
  
  /**
   * Unix timestamp when the token expires.
   */
  expiresAt: number;
  
  /**
   * Random nonce to prevent token replay.
   */
  nonce: string;
}

/**
 * Configuration for issuing capability tokens.
 */
export interface IssueOptions {
  /**
   * Secret key for signing (must be kept secure).
   */
  secret: string;
  
  /**
   * Token validity duration in seconds.
   * @default 3600 (1 hour)
   */
  ttl?: number;
  
  /**
   * Clock skew tolerance in seconds for future-dated tokens.
   * @default 60 (1 minute)
   */
  clockSkewTolerance?: number;
}

/**
 * Configuration for verifying capability tokens.
 */
export interface VerifyOptions {
  /**
   * Secret key for verifying signatures.
   */
  secret: string;
  
  /**
   * Expected audience. If provided, tokens with mismatched audience are rejected.
   */
  audience?: string;
  
  /**
   * Required scopes. If provided, tokens must contain all these scopes.
   */
  requiredScopes?: string[];
  
  /**
   * Clock skew tolerance in seconds for future-dated tokens.
   * @default 60 (1 minute)
   */
  clockSkewTolerance?: number;
  
  /**
   * Maximum allowed token size in bytes.
   * @default 4096
   */
  maxTokenSize?: number;
}

/**
 * Result of token verification.
 */
export interface VerifyResult {
  /**
   * The verified payload.
   */
  payload: CapabilityPayload;
  
  /**
   * Whether the token is valid.
   */
  valid: boolean;
  
  /**
   * Reason for invalidity (if invalid).
   */
  reason?: string;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error thrown when token verification fails.
 */
export class TokenVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenVerificationError";
  }
}

/**
 * Error thrown when token issuance fails.
 */
export class TokenIssuanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenIssuanceError";
  }
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_TTL = 3600; // 1 hour
const DEFAULT_CLOCK_SKEW_TOLERANCE = 60; // 1 minute
const DEFAULT_MAX_TOKEN_SIZE = 4096; // 4KB
const SUPPORTED_VERSIONS = [1];

// ============================================================================
// Cryptographic Operations
// ============================================================================

/**
 * Generates a cryptographically secure random nonce.
 */
function generateNonce(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Signs data using HMAC-SHA256.
 */
function sign(data: string, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(data);
  return hmac.digest("base64url");
}

/**
 * Verifies signature using timing-safe comparison.
 */
function verifySignature(data: string, signature: string, secret: string): boolean {
  const expectedSignature = sign(data, secret);
  
  // Timing-safe comparison
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSignature);
  
  if (a.length !== b.length) {
    return false;
  }
  
  return timingSafeEqual(a, b);
}

// ============================================================================
// Encoding/Decoding
// ============================================================================

/**
 * Encodes a payload to a URL-safe base64 string.
 */
function encodePayload(payload: CapabilityPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json).toString("base64url");
}

/**
 * Decodes a URL-safe base64 string to a payload.
 */
function decodePayload(encoded: string): CapabilityPayload {
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf-8");
    return JSON.parse(json);
  } catch {
    throw new TokenVerificationError("Invalid payload encoding");
  }
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validates the shape of a capability payload.
 */
function validatePayloadShape(payload: unknown): payload is CapabilityPayload {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  
  const p = payload as Record<string, unknown>;
  
  return (
    typeof p.version === "number" &&
    p.version === 1 &&
    typeof p.subject === "string" &&
    typeof p.audience === "string" &&
    Array.isArray(p.scopes) &&
    p.scopes.every((s: unknown) => typeof s === "string") &&
    typeof p.issuedAt === "number" &&
    typeof p.expiresAt === "number" &&
    typeof p.nonce === "string"
  );
}

/**
 * Validates token version support.
 */
function validateVersion(version: number): boolean {
  return SUPPORTED_VERSIONS.includes(version);
}

/**
 * Validates token expiry.
 */
function validateExpiry(expiresAt: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  return expiresAt > now;
}

/**
 * Validates issuedAt is not unreasonably far in the future.
 */
function validateIssuedAt(issuedAt: number, clockSkewTolerance: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  const maxFuture = now + clockSkewTolerance;
  return issuedAt <= maxFuture;
}

/**
 * Validates audience match.
 */
function validateAudience(payloadAudience: string, expectedAudience?: string): boolean {
  if (!expectedAudience) {
    return true;
  }
  return payloadAudience === expectedAudience;
}

/**
 * Validates required scopes.
 */
function validateScopes(payloadScopes: string[], requiredScopes?: string[]): boolean {
  if (!requiredScopes || requiredScopes.length === 0) {
    return true;
  }
  
  return requiredScopes.every((required) => payloadScopes.includes(required));
}

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Issues a new capability token.
 * 
 * @param payload - The token payload (without version, issuedAt, expiresAt, nonce)
 * @param options - Issuance configuration
 * @returns URL-safe token string
 * 
 * @example
 * ```ts
 * const token = issueToken(
 *   { subject: "user123", audience: "api", scopes: ["read"] },
 *   { secret: "my-secret-key" }
 * );
 * ```
 */
export function issueToken(
  partialPayload: Omit<CapabilityPayload, "version" | "issuedAt" | "expiresAt" | "nonce">,
  options: IssueOptions
): string {
  const { secret, ttl = DEFAULT_TTL, clockSkewTolerance = DEFAULT_CLOCK_SKEW_TOLERANCE } = options;
  
  if (!secret || secret.length === 0) {
    throw new TokenIssuanceError("Secret is required");
  }
  
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttl;
  
  // Validate that expiresAt is not unreasonably far in the future
  if (!validateIssuedAt(now, clockSkewTolerance)) {
    throw new TokenIssuanceError("System clock is too far in the future");
  }
  
  const payload: CapabilityPayload = {
    version: 1,
    ...partialPayload,
    issuedAt: now,
    expiresAt,
    nonce: generateNonce()
  };
  
  const encodedPayload = encodePayload(payload);
  const signature = sign(encodedPayload, secret);
  
  // Format: payload.signature
  return `${encodedPayload}.${signature}`;
}

/**
 * Verifies a capability token.
 * 
 * @param token - The token string to verify
 * @param options - Verification configuration
 * @returns Verification result with payload if valid
 * 
 * @example
 * ```ts
 * const result = verifyToken(token, { secret: "my-secret-key", audience: "api" });
 * if (result.valid) {
 *   console.log(result.payload);
 * }
 * ```
 */
export function verifyToken(
  token: string,
  options: VerifyOptions
): VerifyResult {
  const { 
    secret, 
    audience, 
    requiredScopes, 
    clockSkewTolerance = DEFAULT_CLOCK_SKEW_TOLERANCE,
    maxTokenSize = DEFAULT_MAX_TOKEN_SIZE
  } = options;
  
  if (!secret || secret.length === 0) {
    return {
      valid: false,
      reason: "Secret is required",
      payload: {} as CapabilityPayload
    };
  }
  
  // Validate token size
  if (token.length > maxTokenSize) {
    return {
      valid: false,
      reason: "Token exceeds maximum size",
      payload: {} as CapabilityPayload
    };
  }
  
  // Parse token format: payload.signature
  const parts = token.split(".");
  if (parts.length !== 2) {
    return {
      valid: false,
      reason: "Invalid token format",
      payload: {} as CapabilityPayload
    };
  }
  
  const [encodedPayload, signature] = parts;
  
  // Verify signature first (timing-safe)
  if (!verifySignature(encodedPayload, signature, secret)) {
    return {
      valid: false,
      reason: "Invalid signature",
      payload: {} as CapabilityPayload
    };
  }
  
  // Decode payload
  let payload: CapabilityPayload;
  try {
    payload = decodePayload(encodedPayload);
  } catch (error) {
    return {
      valid: false,
      reason: "Invalid payload encoding",
      payload: {} as CapabilityPayload
    };
  }
  
  // Validate payload shape
  if (!validatePayloadShape(payload)) {
    return {
      valid: false,
      reason: "Invalid payload shape",
      payload: {} as CapabilityPayload
    };
  }
  
  // Validate version
  if (!validateVersion(payload.version)) {
    return {
      valid: false,
      reason: "Unsupported token version",
      payload: {} as CapabilityPayload
    };
  }
  
  // Validate issuedAt is not unreasonably far in the future
  if (!validateIssuedAt(payload.issuedAt, clockSkewTolerance)) {
    return {
      valid: false,
      reason: "Token issued too far in the future",
      payload: {} as CapabilityPayload
    };
  }
  
  // Validate expiry
  if (!validateExpiry(payload.expiresAt)) {
    return {
      valid: false,
      reason: "Token has expired",
      payload: {} as CapabilityPayload
    };
  }
  
  // Validate audience
  if (!validateAudience(payload.audience, audience)) {
    return {
      valid: false,
      reason: "Audience mismatch",
      payload: {} as CapabilityPayload
    };
  }
  
  // Validate required scopes
  if (!validateScopes(payload.scopes, requiredScopes)) {
    return {
      valid: false,
      reason: "Missing required scopes",
      payload: {} as CapabilityPayload
    };
  }
  
  return {
    valid: true,
    payload
  };
}

/**
 * Convenience function to verify a token and throw on failure.
 * 
 * @param token - The token string to verify
 * @param options - Verification configuration
 * @returns The verified payload
 * @throws TokenVerificationError if verification fails
 */
export function verifyTokenOrThrow(
  token: string,
  options: VerifyOptions
): CapabilityPayload {
  const result = verifyToken(token, options);
  
  if (!result.valid) {
    throw new TokenVerificationError(result.reason || "Token verification failed");
  }
  
  return result.payload;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Checks if a token has a specific scope.
 * 
 * @param token - The token string
 * @param scope - The scope to check for
 * @param options - Verification configuration
 * @returns true if the token is valid and has the scope
 */
export function hasScope(
  token: string,
  scope: string,
  options: VerifyOptions
): boolean {
  const result = verifyToken(token, options);
  
  if (!result.valid) {
    return false;
  }
  
  return result.payload.scopes.includes(scope);
}

/**
 * Checks if a token has all specified scopes.
 * 
 * @param token - The token string
 * @param scopes - The scopes to check for
 * @param options - Verification configuration
 * @returns true if the token is valid and has all scopes
 */
export function hasAllScopes(
  token: string,
  scopes: string[],
  options: VerifyOptions
): boolean {
  const result = verifyToken(token, options);
  
  if (!result.valid) {
    return false;
  }
  
  return scopes.every((scope) => result.payload.scopes.includes(scope));
}

/**
 * Checks if a token has any of the specified scopes.
 * 
 * @param token - The token string
 * @param scopes - The scopes to check for
 * @param options - Verification configuration
 * @returns true if the token is valid and has at least one scope
 */
export function hasAnyScope(
  token: string,
  scopes: string[],
  options: VerifyOptions
): boolean {
  const result = verifyToken(token, options);
  
  if (!result.valid) {
    return false;
  }
  
  return scopes.some((scope) => result.payload.scopes.includes(scope));
}
