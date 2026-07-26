import { Wallet } from 'ethers';
import Fastify from 'fastify';
import { getAuthenticatedWallet, registerAuthRoutes } from './auth';

function buildSiweMessage(address: string, nonce: string): string {
  return [
    'localhost wants you to sign in with your Ethereum account:',
    address,
    '',
    'Sign in to GuildPass.',
    '',
    'URI: http://localhost:3000',
    'Version: 1',
    'Chain ID: 1',
    `Nonce: ${nonce}`,
    'Issued At: 2026-07-26T00:00:00.000Z',
  ].join('\n');
}

describe('SIWE auth plugin', () => {
  const oldSecret = process.env.SIWE_SESSION_SECRET;
  const oldLegacy = process.env.GUILDPASS_ALLOW_UNSIGNED_WALLET_HEADERS;

  beforeEach(() => {
    process.env.SIWE_SESSION_SECRET = 'test-secret';
    delete process.env.GUILDPASS_ALLOW_UNSIGNED_WALLET_HEADERS;
  });

  afterAll(() => {
    if (oldSecret === undefined) delete process.env.SIWE_SESSION_SECRET;
    else process.env.SIWE_SESSION_SECRET = oldSecret;
    if (oldLegacy === undefined) delete process.env.GUILDPASS_ALLOW_UNSIGNED_WALLET_HEADERS;
    else process.env.GUILDPASS_ALLOW_UNSIGNED_WALLET_HEADERS = oldLegacy;
  });

  test('verifies a signed SIWE message and authenticates bearer session wallet', async () => {
    const app = Fastify();
    await registerAuthRoutes(app);

    const wallet = Wallet.createRandom();
    const nonceResponse = await app.inject({ method: 'GET', url: '/v1/auth/siwe/nonce' });
    const { nonce } = JSON.parse(nonceResponse.body);
    const message = buildSiweMessage(wallet.address, nonce);
    const signature = await wallet.signMessage(message);

    const verifyResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/siwe/verify',
      payload: { message, signature },
    });

    expect(verifyResponse.statusCode).toBe(200);
    const session = JSON.parse(verifyResponse.body);
    expect(session.wallet).toBe(wallet.address.toLowerCase());

    const request = { headers: { authorization: `Bearer ${session.token}` } } as any;
    expect(getAuthenticatedWallet(request)).toBe(wallet.address.toLowerCase());

    await app.close();
  });

  test('ignores unsigned wallet headers unless migration flag is enabled', () => {
    const request = { headers: { 'x-wallet': '0x1111111111111111111111111111111111111111' } } as any;
    expect(getAuthenticatedWallet(request)).toBe('');

    process.env.GUILDPASS_ALLOW_UNSIGNED_WALLET_HEADERS = 'true';
    expect(getAuthenticatedWallet(request)).toBe('0x1111111111111111111111111111111111111111');
  });
});
