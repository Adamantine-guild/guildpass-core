import type { FastifyRequest } from 'fastify';

export const REQUESTER_WALLET_HEADER = 'x-wallet' as const;

export const REQUESTER_WALLET_HEADER_PRECEDENCE = [
  REQUESTER_WALLET_HEADER,
  'x-user-wallet',
  'x-requester-wallet',
] as const;

/**
 * Resolve the wallet address identifying the requester.
 *
 * Header precedence is intentionally centralized here and documented for API
 * consumers: prefer `x-wallet`, then fall back to `x-user-wallet`, then
 * `x-requester-wallet`. Legacy bearer-token fallback is kept for backwards
 * compatibility when none of the requester headers are present.
 */
export function resolveRequesterWallet(request: Pick<FastifyRequest, 'headers'>): string {
  for (const headerName of REQUESTER_WALLET_HEADER_PRECEDENCE) {
    const header = request.headers[headerName];
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice(7).trim();
  }

  return '';
}
