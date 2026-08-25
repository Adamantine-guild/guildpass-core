import { describe, it, expect } from 'vitest';
import { redact, DEFAULT_MASK } from './index';

describe('Secret Redaction Engine', () => {
  it('redacts sensitive top-level properties', () => {
    const input = {
      user: 'alice',
      password: 'supersecretpassword',
      token: 'jwt-12345',
      apiKey: 'api-xyz-987',
      status: 'active',
    };

    const result = redact(input);

    expect(result).toEqual({
      user: 'alice',
      password: DEFAULT_MASK,
      token: DEFAULT_MASK,
      apiKey: DEFAULT_MASK,
      status: 'active',
    });
  });

  it('redacts case-insensitively and handles camelCase / snake_case', () => {
    const input = {
      Authorization: 'Bearer xyz',
      PRIVATE_KEY: '0x123abc',
      seedPhrase: 'apple banana cherry',
      secretKey: 'top-secret',
    };

    const result = redact(input);

    expect(result.Authorization).toBe(DEFAULT_MASK);
    expect(result.PRIVATE_KEY).toBe(DEFAULT_MASK);
    expect(result.seedPhrase).toBe(DEFAULT_MASK);
    expect(result.secretKey).toBe(DEFAULT_MASK);
  });

  it('recursively redacts nested objects', () => {
    const input = {
      meta: {
        traceId: '100',
        auth: {
          token: 'token-abc',
          details: {
            password: 'pwd',
          },
        },
      },
    };

    const result = redact(input);

    expect(result.meta.auth.token).toBe(DEFAULT_MASK);
    expect(result.meta.auth.details.password).toBe(DEFAULT_MASK);
    expect(result.meta.traceId).toBe('100');
  });

  it('redacts sensitive fields inside arrays', () => {
    const input = {
      sessions: [
        { sessionId: 1, token: 'secret-1' },
        { sessionId: 2, token: 'secret-2', privateKey: 'pk-2' },
      ],
    };

    const result = redact(input);

    expect(result.sessions[0].token).toBe(DEFAULT_MASK);
    expect(result.sessions[1].token).toBe(DEFAULT_MASK);
    expect(result.sessions[1].privateKey).toBe(DEFAULT_MASK);
    expect(result.sessions[0].sessionId).toBe(1);
  });

  it('does not mutate the original input object', () => {
    const original = {
      password: 'mypassword',
      nested: { token: 'mytoken' },
    };
    const clone = JSON.parse(JSON.stringify(original));

    redact(original);

    expect(original).toEqual(clone);
  });

  it('safely handles circular references without infinite recursion', () => {
    const circularObj: any = { name: 'guild-node', token: 'secret-token' };
    circularObj.self = circularObj;

    const result = redact(circularObj);

    expect(result.token).toBe(DEFAULT_MASK);
    expect(result.self).toBe('[CIRCULAR]');
  });

  it('enforces maximum traversal depth', () => {
    const deepObj: any = { level: 0 };
    let current = deepObj;
    for (let i = 1; i <= 10; i++) {
      current.next = { level: i };
      current = current.next;
    }

    const result = redact(deepObj, { maxDepth: 3 });

    expect(result.next.next.next).toBe('[MAX_DEPTH_EXCEEDED]');
  });

  it('supports custom additional redaction keys and custom mask', () => {
    const input = {
      ssn: '123-45-6789',
      customSecret: 'confidential',
      normalField: 'ok',
    };

    const result = redact(input, {
      redactKeys: ['ssn', 'customSecret'],
      mask: '***HIDDEN***',
    });

    expect(result.ssn).toBe('***HIDDEN***');
    expect(result.customSecret).toBe('***HIDDEN***');
    expect(result.normalField).toBe('ok');
  });

  it('preserves Date, Error, and primitive types properly', () => {
    const now = new Date();
    const error = new Error('Test Failure');
    const input = {
      timestamp: now,
      error,
      count: 42,
      active: true,
      empty: null,
      secret: 'masked',
    };

    const result = redact(input);

    expect(result.timestamp).toEqual(now);
    expect(result.error.message).toBe('Test Failure');
    expect(result.count).toBe(42);
    expect(result.active).toBe(true);
    expect(result.empty).toBeNull();
    expect(result.secret).toBe(DEFAULT_MASK);
  });
});
