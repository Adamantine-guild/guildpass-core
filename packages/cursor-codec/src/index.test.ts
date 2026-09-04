import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCursorCodec, type CursorPayload } from './index.js';

const SECRET = 'cursor-codec-test-secret';
const PAYLOAD: CursorPayload = {
  version: 1,
  sortValue: '2026-09-04T12:00:00.000Z',
  id: 'community_01J6Y9QJQY1T9Z4F4Q5SVD4Y9A',
};

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign(encodedPayload: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(encodedPayload, 'utf8').digest('base64url');
}

function signedCursor(payload: unknown, secret = SECRET): string {
  const encodedPayload = base64UrlJson(payload);
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

describe('createCursorCodec', () => {
  it('encodes and decodes valid payloads losslessly', () => {
    const codec = createCursorCodec({ secret: SECRET });
    const cursor = codec.encode(PAYLOAD);

    expect(codec.decode(cursor)).toEqual({ valid: true, payload: PAYLOAD });
  });

  it('serializes payloads deterministically', () => {
    const codec = createCursorCodec({ secret: SECRET });

    expect(codec.encode(PAYLOAD)).toBe(codec.encode({ ...PAYLOAD }));
  });

  it('encodes cursors using a URL-safe representation', () => {
    const codec = createCursorCodec({ secret: SECRET });
    const cursor = codec.encode(PAYLOAD);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain('=');
    expect(cursor).not.toContain('+');
    expect(cursor).not.toContain('/');
  });

  it('rejects client modification of the payload', () => {
    const codec = createCursorCodec({ secret: SECRET });
    const cursor = codec.encode(PAYLOAD);
    const [, signature] = cursor.split('.');
    const tamperedPayload = base64UrlJson({ ...PAYLOAD, id: 'community_tampered' });

    expect(codec.decode(`${tamperedPayload}.${signature}`)).toEqual({
      valid: false,
      code: 'SIGNATURE_MISMATCH',
    });
  });

  it('rejects client modification of the signature', () => {
    const codec = createCursorCodec({ secret: SECRET });
    const cursor = codec.encode(PAYLOAD);
    const [payload, signature] = cursor.split('.');
    const tamperedSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;

    expect(codec.decode(`${payload}.${tamperedSignature}`)).toEqual({
      valid: false,
      code: 'SIGNATURE_MISMATCH',
    });
  });

  it('rejects unsupported cursor versions after signature validation', () => {
    const codec = createCursorCodec({ secret: SECRET });

    expect(codec.decode(signedCursor({ ...PAYLOAD, version: 2 }))).toEqual({
      valid: false,
      code: 'UNSUPPORTED_VERSION',
    });
  });

  it.each([
    '',
    'not-a-token',
    'too.many.parts',
    'bad+base64url.signature',
    'abcd.signature',
    `${base64UrlJson(PAYLOAD)}.bad+signature`,
    `${base64UrlJson(PAYLOAD)}.abcde`,
  ])('handles malformed cursor input safely: %s', (cursor) => {
    const codec = createCursorCodec({ secret: SECRET });

    expect(() => codec.decode(cursor)).not.toThrow();
    expect(codec.decode(cursor).valid).toBe(false);
  });

  it('rejects malformed JSON payload encoding', () => {
    const codec = createCursorCodec({ secret: SECRET });
    const encodedPayload = Buffer.from('{').toString('base64url');

    expect(codec.decode(`${encodedPayload}.${sign(encodedPayload)}`)).toEqual({
      valid: false,
      code: 'MALFORMED_CURSOR',
    });
  });

  it.each([
    { version: 1, sortValue: '', id: PAYLOAD.id },
    { version: 1, sortValue: PAYLOAD.sortValue, id: '' },
    { version: 1, sortValue: PAYLOAD.sortValue, id: PAYLOAD.id, extra: true },
    { version: 1, sortValue: 123, id: PAYLOAD.id },
    { version: 1, sortValue: PAYLOAD.sortValue, id: null },
  ])('rejects invalid signed payload shapes: %o', (payload) => {
    const codec = createCursorCodec({ secret: SECRET });

    expect(codec.decode(signedCursor(payload))).toEqual({
      valid: false,
      code: 'INVALID_PAYLOAD',
    });
  });

  it('rejects oversized cursor input before decoding', () => {
    const codec = createCursorCodec({ secret: SECRET, maxCursorLength: 20 });

    expect(codec.decode('a'.repeat(21))).toEqual({
      valid: false,
      code: 'CURSOR_TOO_LONG',
    });
  });

  it('enforces max cursor length while encoding', () => {
    const codec = createCursorCodec({ secret: SECRET, maxCursorLength: 20 });

    expect(() => codec.encode(PAYLOAD)).toThrow(RangeError);
  });

  it('requires secrets to be supplied externally', () => {
    expect(() => createCursorCodec({ secret: '' })).toThrow(TypeError);
    expect(() => createCursorCodec({ secret: new Uint8Array() })).toThrow(TypeError);
    // @ts-expect-error exercising the runtime boundary
    expect(() => createCursorCodec({ secret: undefined })).toThrow(TypeError);
  });

  it('supports Uint8Array secrets without embedding them in the cursor', () => {
    const secret = Buffer.from(SECRET, 'utf8');
    const codec = createCursorCodec({ secret });
    const cursor = codec.encode(PAYLOAD);

    expect(codec.decode(cursor)).toEqual({ valid: true, payload: PAYLOAD });
    expect(cursor).not.toContain(SECRET);
    expect(Buffer.from(cursor, 'base64url').toString('utf8')).not.toContain(SECRET);
  });

  it('rejects invalid caller-provided payloads at encode time', () => {
    const codec = createCursorCodec({ secret: SECRET });

    expect(() => codec.encode({ ...PAYLOAD, version: 2 as 1 })).toThrow(TypeError);
    expect(() => codec.encode({ ...PAYLOAD, sortValue: '' })).toThrow(TypeError);
    expect(() => codec.encode({ ...PAYLOAD, id: '' })).toThrow(TypeError);
    // @ts-expect-error exercising the runtime boundary
    expect(() => codec.encode(null)).toThrow(TypeError);
  });

  it('rejects invalid codec configuration', () => {
    // @ts-expect-error exercising the runtime boundary
    expect(() => createCursorCodec(null)).toThrow(TypeError);
    expect(() => createCursorCodec({ secret: SECRET, maxCursorLength: 0 })).toThrow(RangeError);
    expect(() => createCursorCodec({ secret: SECRET, maxCursorLength: 1.5 })).toThrow(RangeError);
    expect(() =>
      createCursorCodec({ secret: SECRET, maxCursorLength: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow(RangeError);
  });
});
