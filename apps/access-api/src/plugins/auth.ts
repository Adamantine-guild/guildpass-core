import crypto from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyMessage } from 'ethers';

const NONCE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_SECONDS = Number(process.env.SIWE_SESSION_TTL_SECONDS ?? 15 * 60);
const LEGACY_HEADER_FLAG = 'GUILDPASS_ALLOW_UNSIGNED_WALLET_HEADERS';

const nonces = new Map<string, number>();

interface SessionPayload {
  wallet: string;
  iat: number;
  exp: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sessionSecret(): string {
  return process.env.SIWE_SESSION_SECRET ?? process.env.JWT_SECRET ?? 'guildpass-dev-siwe-session-secret';
}

function sign(data: string): string {
  return crypto.createHmac('sha256', sessionSecret()).update(data).digest('base64url');
}

function issueSessionToken(wallet: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { wallet: wallet.toLowerCase(), iat: now, exp: now + SESSION_TTL_SECONDS };
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

function verifySessionToken(token: string): SessionPayload | null {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature || sign(encoded) !== signature) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
    if (!payload.wallet || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function getBearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  return typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : '';
}

function legacyHeaderWallet(request: FastifyRequest): string {
  const header = request.headers['x-wallet'] ?? request.headers['x-user-wallet'] ?? request.headers['x-requester-wallet'];
  if (Array.isArray(header)) return header[0] ?? '';
  return header ?? '';
}

function legacyHeadersEnabled(): boolean {
  return process.env[LEGACY_HEADER_FLAG] === 'true';
}

function parseSiweMessage(message: string): { address?: string; nonce?: string } {
  const lines = message.split(/\r?\n/);
  const address = lines.find((line) => /^0x[a-fA-F0-9]{40}$/.test(line.trim()))?.trim();
  const nonceLine = lines.find((line) => line.toLowerCase().startsWith('nonce:'));
  return { address, nonce: nonceLine?.slice(nonceLine.indexOf(':') + 1).trim() };
}

function pruneNonces() {
  const now = Date.now();
  for (const [nonce, expiresAt] of nonces.entries()) {
    if (expiresAt <= now) nonces.delete(nonce);
  }
}

export function getAuthenticatedWallet(request: FastifyRequest): string {
  const token = getBearerToken(request);
  if (token) {
    const session = verifySessionToken(token);
    if (session) return session.wallet;
  }

  if (legacyHeadersEnabled()) {
    return legacyHeaderWallet(request);
  }

  return '';
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/auth/siwe/nonce', async () => {
    pruneNonces();
    const nonce = crypto.randomBytes(16).toString('hex');
    nonces.set(nonce, Date.now() + NONCE_TTL_MS);
    return { nonce, expiresInSeconds: NONCE_TTL_MS / 1000 };
  });

  app.post('/v1/auth/siwe/verify', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { message?: string; signature?: string };
    if (!body?.message || !body?.signature) {
      return reply.status(400).send({ error: 'Missing required fields: message, signature' });
    }

    const parsed = parseSiweMessage(body.message);
    if (!parsed.address || !parsed.nonce) {
      return reply.status(400).send({ error: 'Invalid SIWE message' });
    }

    const expiresAt = nonces.get(parsed.nonce);
    if (!expiresAt || expiresAt <= Date.now()) {
      nonces.delete(parsed.nonce);
      return reply.status(401).send({ error: 'Invalid or expired nonce' });
    }

    let recovered: string;
    try {
      recovered = verifyMessage(body.message, body.signature);
    } catch {
      return reply.status(401).send({ error: 'Invalid signature' });
    }

    if (recovered.toLowerCase() !== parsed.address.toLowerCase()) {
      return reply.status(401).send({ error: 'Signature does not match SIWE address' });
    }

    nonces.delete(parsed.nonce);
    return reply.status(200).send({ token: issueSessionToken(parsed.address), wallet: parsed.address.toLowerCase(), tokenType: 'Bearer', expiresInSeconds: SESSION_TTL_SECONDS });
  });
}
