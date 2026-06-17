import type { FastifyReply } from 'fastify';
import { parseBody, parseParams, parseQuery, accessCheckBodySchema, walletParamSchema } from '../src/validators';

const VALID_WALLET = 'A'.repeat(56);

function makeReply() {
  const sent: { code: number; body: any } = { code: 200, body: undefined };
  const reply = {
    code: (c: number) => {
      sent.code = c;
      return reply;
    },
    send: (b: any) => {
      sent.body = b;
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, sent };
}

describe('parseParams', () => {
  test('returns parsed params and does not call reply.send on success', () => {
    const { reply, sent } = makeReply();
    const req = { params: { wallet: VALID_WALLET } } as any;
    const out = parseParams(req, reply, walletParamSchema);
    expect(out).not.toBeNull();
    expect(sent.code).toBe(200);
  });

  test('sends 400 with structured errors on failure', () => {
    const { reply, sent } = makeReply();
    const req = { params: { wallet: 'too-short' } } as any;
    const out = parseParams(req, reply, walletParamSchema);
    expect(out).toBeNull();
    expect(sent.code).toBe(400);
    expect(sent.body.message).toBe('Validation failed');
    expect(Array.isArray(sent.body.errors)).toBe(true);
  });
});

describe('parseQuery', () => {
  test('parses valid query', () => {
    const { reply, sent } = makeReply();
    const req = { query: { role: 'admin' } } as any;
    const out = parseQuery(req, reply, require('../src/validators').roleQuerySchema);
    expect(out).not.toBeNull();
    expect(sent.code).toBe(200);
  });
});

describe('parseBody', () => {
  test('parses valid body', () => {
    const { reply, sent } = makeReply();
    const req = {
      body: { wallet: VALID_WALLET, communityId: 'c1', resource: 'docs' },
    } as any;
    const out = parseBody(req, reply, accessCheckBodySchema);
    expect(out).not.toBeNull();
    expect(sent.code).toBe(200);
  });

  test('rejects body with empty resource', () => {
    const { reply, sent } = makeReply();
    const req = {
      body: { wallet: VALID_WALLET, communityId: 'c1', resource: '' },
    } as any;
    const out = parseBody(req, reply, accessCheckBodySchema);
    expect(out).toBeNull();
    expect(sent.code).toBe(400);
  });
});
