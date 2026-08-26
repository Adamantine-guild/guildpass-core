import { createHmac, createSecretKey, timingSafeEqual } from 'node:crypto';
import { types as utilTypes } from 'node:util';

const HMAC_ALGORITHM = 'sha256';
const SHA256_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;
const UNIX_TIMESTAMP_PATTERN = /^(0|[1-9]\d*)$/;
const MAX_SAFE_INTEGER_DIGITS = String(Number.MAX_SAFE_INTEGER).length;

export type WebhookVerificationFailureCode =
  | 'MISSING_SIGNATURE'
  | 'INVALID_SIGNATURE_FORMAT'
  | 'MISSING_TIMESTAMP'
  | 'INVALID_TIMESTAMP_FORMAT'
  | 'SIGNATURE_MISMATCH'
  | 'TIMESTAMP_EXPIRED'
  | 'TIMESTAMP_IN_FUTURE';

export type WebhookVerificationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly code: WebhookVerificationFailureCode;
    };

export interface WebhookVerifierConfig {
  /** HMAC secret. String secrets are interpreted as UTF-8 bytes. */
  readonly secret: string;
  /** Maximum accepted age and future clock skew, in whole seconds. */
  readonly toleranceSeconds: number;
  /** Exact prefix to remove before decoding the 64-character hex signature. */
  readonly signaturePrefix?: string;
}

export interface VerifyWebhookInput {
  /** Original, unparsed request body. Strings are interpreted as UTF-8 bytes. */
  readonly rawBody: string | Uint8Array;
  readonly signature?: string | null;
  /** Canonical Unix timestamp in seconds, as signed by the sender. */
  readonly timestamp?: string | null;
}

export interface WebhookVerifier {
  verify(input: VerifyWebhookInput): WebhookVerificationResult;
}

function failure(code: WebhookVerificationFailureCode): WebhookVerificationResult {
  return { valid: false, code };
}

function assertConfig(config: WebhookVerifierConfig): void {
  if (typeof config !== 'object' || config === null) {
    throw new TypeError('Webhook verifier configuration must be an object');
  }

  if (typeof config.secret !== 'string' || config.secret.length === 0) {
    throw new TypeError('Webhook verification secret must be a non-empty string');
  }

  if (
    !Number.isSafeInteger(config.toleranceSeconds) ||
    config.toleranceSeconds < 0
  ) {
    throw new RangeError('toleranceSeconds must be a non-negative safe integer');
  }

  if (
    config.signaturePrefix !== undefined &&
    typeof config.signaturePrefix !== 'string'
  ) {
    throw new TypeError('signaturePrefix must be a string when provided');
  }
}

function parseTimestamp(timestamp: string): number | null {
  if (
    timestamp.length > MAX_SAFE_INTEGER_DIGITS ||
    !UNIX_TIMESTAMP_PATTERN.test(timestamp)
  ) {
    return null;
  }

  const parsed = Number(timestamp);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isRawBody(value: unknown): value is string | Uint8Array {
  return typeof value === 'string' || utilTypes.isUint8Array(value);
}

/**
 * Creates a provider-neutral verifier for the GuildPass webhook signing scheme.
 *
 * The authenticated message is the exact timestamp string, a full stop, and the
 * original request-body bytes. Request-controlled validation failures are
 * returned as typed results; invalid verifier configuration throws immediately.
 */
export function createWebhookVerifier(config: WebhookVerifierConfig): WebhookVerifier {
  assertConfig(config);

  const secretKey = createSecretKey(Buffer.from(config.secret, 'utf8'));
  const toleranceSeconds = config.toleranceSeconds;
  const signaturePrefix = config.signaturePrefix ?? '';

  const verify = (input: VerifyWebhookInput): WebhookVerificationResult => {
    if (typeof input !== 'object' || input === null) {
      throw new TypeError('Webhook verification input must be an object');
    }

    if (!isRawBody(input.rawBody)) {
      throw new TypeError('rawBody must be a string or Uint8Array');
    }

    if (input.signature === undefined || input.signature === null || input.signature === '') {
      return failure('MISSING_SIGNATURE');
    }

    if (typeof input.signature !== 'string' || !input.signature.startsWith(signaturePrefix)) {
      return failure('INVALID_SIGNATURE_FORMAT');
    }

    const encodedSignature = input.signature.slice(signaturePrefix.length);
    if (!SHA256_HEX_PATTERN.test(encodedSignature)) {
      return failure('INVALID_SIGNATURE_FORMAT');
    }

    if (input.timestamp === undefined || input.timestamp === null || input.timestamp === '') {
      return failure('MISSING_TIMESTAMP');
    }

    if (typeof input.timestamp !== 'string') {
      return failure('INVALID_TIMESTAMP_FORMAT');
    }

    const timestampSeconds = parseTimestamp(input.timestamp);
    if (timestampSeconds === null) {
      return failure('INVALID_TIMESTAMP_FORMAT');
    }

    const suppliedSignature = Buffer.from(encodedSignature, 'hex');
    const expectedSignature = createHmac(HMAC_ALGORITHM, secretKey)
      .update(input.timestamp, 'utf8')
      .update('.', 'utf8')
      .update(input.rawBody)
      .digest();

    if (!timingSafeEqual(expectedSignature, suppliedSignature)) {
      return failure('SIGNATURE_MISMATCH');
    }

    const nowSeconds = Math.floor(Date.now() / 1_000);
    const ageSeconds = nowSeconds - timestampSeconds;

    if (ageSeconds > toleranceSeconds) {
      return failure('TIMESTAMP_EXPIRED');
    }

    if (ageSeconds < -toleranceSeconds) {
      return failure('TIMESTAMP_IN_FUTURE');
    }

    return { valid: true };
  };

  return Object.freeze({ verify });
}
