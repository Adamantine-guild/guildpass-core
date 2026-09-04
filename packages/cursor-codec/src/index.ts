import { createHmac, createSecretKey, timingSafeEqual } from 'node:crypto';
import { types as utilTypes } from 'node:util';

const CURSOR_VERSION = 1;
const DEFAULT_MAX_CURSOR_LENGTH = 1024;
const HMAC_ALGORITHM = 'sha256';
const HMAC_SHA256_BYTES = 32;
const TOKEN_SEPARATOR = '.';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface CursorPayload {
  readonly version: 1;
  readonly sortValue: string;
  readonly id: string;
}

export type CursorDecodeFailureCode =
  | 'CURSOR_TOO_LONG'
  | 'MALFORMED_CURSOR'
  | 'SIGNATURE_MISMATCH'
  | 'UNSUPPORTED_VERSION'
  | 'INVALID_PAYLOAD';

export type CursorDecodeResult =
  | { readonly valid: true; readonly payload: CursorPayload }
  | {
      readonly valid: false;
      readonly code: CursorDecodeFailureCode;
    };

export interface CursorCodecConfig {
  /** HMAC secret. String secrets are interpreted as UTF-8 bytes. */
  readonly secret: string | Uint8Array;
  /** Maximum accepted encoded cursor length. Defaults to 1024 characters. */
  readonly maxCursorLength?: number;
}

export interface CursorCodec {
  encode(payload: CursorPayload): string;
  decode(cursor: string): CursorDecodeResult;
}

function failure(code: CursorDecodeFailureCode): CursorDecodeResult {
  return { valid: false, code };
}

function isByteArray(value: unknown): value is Uint8Array {
  return utilTypes.isUint8Array(value);
}

function assertConfig(config: CursorCodecConfig): void {
  if (typeof config !== 'object' || config === null) {
    throw new TypeError('Cursor codec configuration must be an object');
  }

  if (typeof config.secret === 'string') {
    if (config.secret.length === 0) {
      throw new TypeError('Cursor codec secret must be non-empty');
    }
  } else if (isByteArray(config.secret)) {
    if (config.secret.byteLength === 0) {
      throw new TypeError('Cursor codec secret must be non-empty');
    }
  } else {
    throw new TypeError('Cursor codec secret must be a string or Uint8Array');
  }

  if (
    config.maxCursorLength !== undefined &&
    (!Number.isSafeInteger(config.maxCursorLength) || config.maxCursorLength <= 0)
  ) {
    throw new RangeError('maxCursorLength must be a positive safe integer when provided');
  }
}

function assertPayload(payload: CursorPayload): void {
  if (typeof payload !== 'object' || payload === null) {
    throw new TypeError('Cursor payload must be an object');
  }

  if (payload.version !== CURSOR_VERSION) {
    throw new TypeError('Cursor payload version must be 1');
  }

  if (typeof payload.sortValue !== 'string' || payload.sortValue.length === 0) {
    throw new TypeError('Cursor payload sortValue must be a non-empty string');
  }

  if (typeof payload.id !== 'string' || payload.id.length === 0) {
    throw new TypeError('Cursor payload id must be a non-empty string');
  }
}

function serializePayload(payload: CursorPayload): string {
  return JSON.stringify({
    version: payload.version,
    sortValue: payload.sortValue,
    id: payload.id,
  });
}

function encodeBase64Url(input: string | Uint8Array): string {
  return Buffer.from(input).toString('base64url');
}

function decodeBase64Url(input: string): Buffer | null {
  if (
    input.length === 0 ||
    input.length % 4 === 1 ||
    !BASE64URL_PATTERN.test(input)
  ) {
    return null;
  }

  try {
    return Buffer.from(input, 'base64url');
  } catch {
    return null;
  }
}

function parsePayload(payloadBytes: Buffer): CursorDecodeResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    return failure('MALFORMED_CURSOR');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return failure('INVALID_PAYLOAD');
  }

  const record = parsed as Record<string, unknown>;
  if (record.version !== CURSOR_VERSION) {
    return failure('UNSUPPORTED_VERSION');
  }

  if (
    Object.keys(record).length !== 3 ||
    typeof record.sortValue !== 'string' ||
    record.sortValue.length === 0 ||
    typeof record.id !== 'string' ||
    record.id.length === 0
  ) {
    return failure('INVALID_PAYLOAD');
  }

  return {
    valid: true,
    payload: {
      version: CURSOR_VERSION,
      sortValue: record.sortValue,
      id: record.id,
    },
  };
}

export function createCursorCodec(config: CursorCodecConfig): CursorCodec {
  assertConfig(config);

  const secretBytes =
    typeof config.secret === 'string'
      ? Buffer.from(config.secret, 'utf8')
      : Buffer.from(config.secret);
  const secretKey = createSecretKey(secretBytes);
  const maxCursorLength = config.maxCursorLength ?? DEFAULT_MAX_CURSOR_LENGTH;

  const sign = (encodedPayload: string): Buffer =>
    createHmac(HMAC_ALGORITHM, secretKey).update(encodedPayload, 'utf8').digest();

  const encode = (payload: CursorPayload): string => {
    assertPayload(payload);

    const encodedPayload = encodeBase64Url(serializePayload(payload));
    const encodedSignature = encodeBase64Url(sign(encodedPayload));
    const cursor = `${encodedPayload}${TOKEN_SEPARATOR}${encodedSignature}`;

    if (cursor.length > maxCursorLength) {
      throw new RangeError('Encoded cursor exceeds maxCursorLength');
    }

    return cursor;
  };

  const decode = (cursor: string): CursorDecodeResult => {
    if (typeof cursor !== 'string' || cursor.length === 0) {
      return failure('MALFORMED_CURSOR');
    }

    if (cursor.length > maxCursorLength) {
      return failure('CURSOR_TOO_LONG');
    }

    const parts = cursor.split(TOKEN_SEPARATOR);
    if (parts.length !== 2) {
      return failure('MALFORMED_CURSOR');
    }

    const [encodedPayload, encodedSignature] = parts;
    if (encodedPayload === undefined || encodedSignature === undefined) {
      return failure('MALFORMED_CURSOR');
    }

    const payloadBytes = decodeBase64Url(encodedPayload);
    const suppliedSignature = decodeBase64Url(encodedSignature);
    if (payloadBytes === null || suppliedSignature === null) {
      return failure('MALFORMED_CURSOR');
    }

    if (suppliedSignature.byteLength !== HMAC_SHA256_BYTES) {
      return failure('SIGNATURE_MISMATCH');
    }

    const expectedSignature = sign(encodedPayload);
    if (!timingSafeEqual(expectedSignature, suppliedSignature)) {
      return failure('SIGNATURE_MISMATCH');
    }

    return parsePayload(payloadBytes);
  };

  return Object.freeze({ encode, decode });
}
