import { createHmac } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebhookVerifier } from './index.js';

const SECRET = 'whsec_test_vector_secret';
const NOW_SECONDS = 1_700_000_000;
const TIMESTAMP = String(NOW_SECONDS);
const RAW_BODY = '{"id":"evt_test","eventType":"MEMBERSHIP_CREATED"}';
const EXPECTED_SIGNATURE =
  '31e6b874929fbc99382137fe6a682142bdb23f52ada975a972a69a8f586cf4a1';

function sign(
  timestamp: string,
  rawBody: string | Uint8Array,
  secret = SECRET,
): string {
  return createHmac('sha256', secret)
    .update(timestamp, 'utf8')
    .update('.', 'utf8')
    .update(rawBody)
    .digest('hex');
}

describe('createWebhookVerifier', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SECONDS * 1_000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts a deterministic HMAC-SHA256 signing vector', () => {
    const verifier = createWebhookVerifier({ secret: SECRET, toleranceSeconds: 300 });

    expect(
      verifier.verify({
        rawBody: RAW_BODY,
        signature: EXPECTED_SIGNATURE,
        timestamp: TIMESTAMP,
      }),
    ).toEqual({ valid: true });
  });

  it('accepts the original binary payload without UTF-8 conversion', () => {
    const verifier = createWebhookVerifier({ secret: SECRET, toleranceSeconds: 300 });
    const rawBody = Uint8Array.from([0xff, 0xfe, 0x00, 0x7b, 0x22, 0x78, 0x22, 0x3a, 0x31, 0x7d]);
    const expectedBinarySignature =
      '9726926a7193d756a01527089a4e66b38250ccf7ea75261f32087cc92ba4dac5';

    expect(
      verifier.verify({ rawBody, signature: expectedBinarySignature, timestamp: TIMESTAMP }),
    ).toEqual({ valid: true });
  });

  it('accepts a Uint8Array created in another JavaScript realm', () => {
    const verifier = createWebhookVerifier({ secret: SECRET, toleranceSeconds: 300 });
    const rawBody = runInNewContext('new Uint8Array([1, 2, 3])') as Uint8Array;

    expect(
      verifier.verify({
        rawBody,
        signature: sign(TIMESTAMP, rawBody),
        timestamp: TIMESTAMP,
      }),
    ).toEqual({ valid: true });
  });

  it('rejects payload tampering and JSON reserialization', () => {
    const verifier = createWebhookVerifier({ secret: SECRET, toleranceSeconds: 300 });

    expect(
      verifier.verify({
        rawBody: RAW_BODY.replace('MEMBERSHIP_CREATED', 'MEMBERSHIP_DELETED'),
        signature: EXPECTED_SIGNATURE,
        timestamp: TIMESTAMP,
      }),
    ).toEqual({ valid: false, code: 'SIGNATURE_MISMATCH' });

    expect(
      verifier.verify({
        rawBody: JSON.stringify(JSON.parse(RAW_BODY), null, 2),
        signature: EXPECTED_SIGNATURE,
        timestamp: TIMESTAMP,
      }),
    ).toEqual({ valid: false, code: 'SIGNATURE_MISMATCH' });
  });

  it('rejects signature and timestamp tampering', () => {
    const verifier = createWebhookVerifier({ secret: SECRET, toleranceSeconds: 300 });
    const tamperedSignature = `${EXPECTED_SIGNATURE.slice(0, -1)}0`;

    expect(
      verifier.verify({
        rawBody: RAW_BODY,
        signature: tamperedSignature,
        timestamp: TIMESTAMP,
      }),
    ).toEqual({ valid: false, code: 'SIGNATURE_MISMATCH' });

    expect(
      verifier.verify({
        rawBody: RAW_BODY,
        signature: EXPECTED_SIGNATURE,
        timestamp: String(NOW_SECONDS + 1),
      }),
    ).toEqual({ valid: false, code: 'SIGNATURE_MISMATCH' });
  });

  it('rejects a valid signature produced with a different secret', () => {
    const verifier = createWebhookVerifier({ secret: 'different-secret', toleranceSeconds: 300 });

    expect(
      verifier.verify({
        rawBody: RAW_BODY,
        signature: EXPECTED_SIGNATURE,
        timestamp: TIMESTAMP,
      }),
    ).toEqual({ valid: false, code: 'SIGNATURE_MISMATCH' });
  });

  it.each([undefined, null, ''])('reports a missing signature for %s', (signature) => {
    const verifier = createWebhookVerifier({ secret: SECRET, toleranceSeconds: 300 });

    expect(verifier.verify({ rawBody: RAW_BODY, signature, timestamp: TIMESTAMP })).toEqual({
      valid: false,
      code: 'MISSING_SIGNATURE',
    });
  });

  it.each([
    '0',
    'a'.repeat(63),
    'a'.repeat(65),
    'g'.repeat(64),
    `${'a'.repeat(62)}zz`,
    `${EXPECTED_SIGNATURE} `,
    `sha256=${EXPECTED_SIGNATURE}`,
  ])('safely rejects malformed signature encoding: %s', (signature) => {
    const verifier = createWebhookVerifier({ secret: SECRET, toleranceSeconds: 300 });

    expect(() =>
      verifier.verify({ rawBody: RAW_BODY, signature, timestamp: TIMESTAMP }),
    ).not.toThrow();
    expect(verifier.verify({ rawBody: RAW_BODY, signature, timestamp: TIMESTAMP })).toEqual({
      valid: false,
      code: 'INVALID_SIGNATURE_FORMAT',
    });
  });

  it('supports an exact configurable signature prefix', () => {
    const verifier = createWebhookVerifier({
      secret: SECRET,
      toleranceSeconds: 300,
      signaturePrefix: 'sha256=',
    });

    expect(
      verifier.verify({
        rawBody: RAW_BODY,
        signature: `sha256=${EXPECTED_SIGNATURE.toUpperCase()}`,
        timestamp: TIMESTAMP,
      }),
    ).toEqual({ valid: true });

    expect(
      verifier.verify({
        rawBody: RAW_BODY,
        signature: EXPECTED_SIGNATURE,
        timestamp: TIMESTAMP,
      }),
    ).toEqual({ valid: false, code: 'INVALID_SIGNATURE_FORMAT' });
  });

  it.each([undefined, null, ''])('reports a missing timestamp for %s', (timestamp) => {
    const verifier = createWebhookVerifier({ secret: SECRET, toleranceSeconds: 300 });

    expect(
      verifier.verify({ rawBody: RAW_BODY, signature: EXPECTED_SIGNATURE, timestamp }),
    ).toEqual({ valid: false, code: 'MISSING_TIMESTAMP' });
  });

  it.each([
    ' 1700000000',
    '1700000000 ',
    '+1700000000',
    '-1',
    '1.7',
    '1e9',
    '01700000000',
    'not-a-timestamp',
    '9007199254740992',
    '9'.repeat(100),
  ])('safely rejects a malformed timestamp: %s', (timestamp) => {
    const verifier = createWebhookVerifier({ secret: SECRET, toleranceSeconds: 300 });

    expect(
      verifier.verify({ rawBody: RAW_BODY, signature: EXPECTED_SIGNATURE, timestamp }),
    ).toEqual({ valid: false, code: 'INVALID_TIMESTAMP_FORMAT' });
  });

  it('enforces the past replay-window boundary', () => {
    const verifier = createWebhookVerifier({ secret: SECRET, toleranceSeconds: 300 });
    const atBoundary = String(NOW_SECONDS - 300);
    const expired = String(NOW_SECONDS - 301);

    expect(
      verifier.verify({ rawBody: RAW_BODY, signature: sign(atBoundary, RAW_BODY), timestamp: atBoundary }),
    ).toEqual({ valid: true });
    expect(
      verifier.verify({ rawBody: RAW_BODY, signature: sign(expired, RAW_BODY), timestamp: expired }),
    ).toEqual({ valid: false, code: 'TIMESTAMP_EXPIRED' });
  });

  it('enforces the future clock-skew boundary', () => {
    const verifier = createWebhookVerifier({ secret: SECRET, toleranceSeconds: 300 });
    const atBoundary = String(NOW_SECONDS + 300);
    const tooFarInFuture = String(NOW_SECONDS + 301);

    expect(
      verifier.verify({ rawBody: RAW_BODY, signature: sign(atBoundary, RAW_BODY), timestamp: atBoundary }),
    ).toEqual({ valid: true });
    expect(
      verifier.verify({
        rawBody: RAW_BODY,
        signature: sign(tooFarInFuture, RAW_BODY),
        timestamp: tooFarInFuture,
      }),
    ).toEqual({ valid: false, code: 'TIMESTAMP_IN_FUTURE' });
  });

  it('reports signature mismatch before exposing timestamp freshness', () => {
    const verifier = createWebhookVerifier({ secret: SECRET, toleranceSeconds: 300 });
    const expired = String(NOW_SECONDS - 301);

    expect(
      verifier.verify({ rawBody: RAW_BODY, signature: '0'.repeat(64), timestamp: expired }),
    ).toEqual({ valid: false, code: 'SIGNATURE_MISMATCH' });
  });

  it('rejects invalid verifier configuration at creation time', () => {
    // @ts-expect-error exercising the runtime boundary
    expect(() => createWebhookVerifier(null)).toThrow(TypeError);
    expect(() => createWebhookVerifier({ secret: '', toleranceSeconds: 300 })).toThrow(TypeError);
    expect(() => createWebhookVerifier({ secret: SECRET, toleranceSeconds: -1 })).toThrow(RangeError);
    expect(() => createWebhookVerifier({ secret: SECRET, toleranceSeconds: 1.5 })).toThrow(RangeError);
    expect(() =>
      createWebhookVerifier({ secret: SECRET, toleranceSeconds: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow(RangeError);
    expect(() =>
      createWebhookVerifier({
        secret: SECRET,
        toleranceSeconds: 300,
        // @ts-expect-error exercising the runtime boundary
        signaturePrefix: 123,
      }),
    ).toThrow(TypeError);
  });

  it('rejects invalid raw-body input as a caller programming error', () => {
    const verifier = createWebhookVerifier({ secret: SECRET, toleranceSeconds: 300 });

    expect(() =>
      verifier.verify({
        // @ts-expect-error exercising the runtime boundary
        rawBody: { parsed: true },
        signature: EXPECTED_SIGNATURE,
        timestamp: TIMESTAMP,
      }),
    ).toThrow(TypeError);
  });
});
