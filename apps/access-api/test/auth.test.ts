import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { registerRoutes } from '../src/routes';
import { ethers } from 'ethers';

// ---------------------------------------------------------------------------
// Mock Prisma Client
// ---------------------------------------------------------------------------

const mockPrisma = {
  challenge: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  linkedWallet: {
    create: jest.fn(),
    findFirst: jest.fn(),
  },
  wallet: {
    upsert: jest.fn(),
    findUnique: jest.fn(),
  },
  session: {
    create: jest.fn(),
    findUnique: jest.fn(),
    delete: jest.fn(),
  },
  siweNonce: {
    create: jest.fn(),
    findUnique: jest.fn(),
    delete: jest.fn(),
  },
  community: {
    findUnique: jest.fn(),
  },
  $transaction: jest.fn().mockImplementation((cb) => cb(mockPrisma)),
};

// Mock the prisma service
jest.mock('../src/services/prisma', () => ({
  getPrisma: () => mockPrisma,
}));

// Mock the audit chain service
jest.mock('../src/services/auditChainHasher', () => ({
  writeChainedAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

describe('Authentication & Security Integration Tests', () => {
  let app: FastifyInstance;
  const primaryWallet = ethers.Wallet.createRandom();
  const secondaryWallet = ethers.Wallet.createRandom();

  beforeAll(async () => {
    app = Fastify();
    await registerRoutes(app);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Wallet Link Signature Verification', () => {
    test('should fail if signature is invalid or mismatched', async () => {
      const challengeObj = {
        nonce: 'link-nonce-123',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        primaryWallet: primaryWallet.address as any,
        secondaryWallet: secondaryWallet.address as any,
      };

      // Mock database lookup for challenge
      (mockPrisma.challenge.findUnique as jest.Mock).mockResolvedValue({
        id: 'challenge-id',
        nonce: challengeObj.nonce,
        primaryWalletId: 'p-1',
        secondaryWalletId: 's-1',
        primaryWallet: { address: primaryWallet.address.toLowerCase() },
        secondaryWallet: { address: secondaryWallet.address.toLowerCase() },
        used: false,
        expiresAt: new Date(challengeObj.expiresAt),
      });

      // Send arbitrary invalid signature
      const response = await app.inject({
        method: 'POST',
        url: `/v1/wallets/${primaryWallet.address}/link`,
        payload: {
          challenge: challengeObj,
          signature: '0xinvalidsignature',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain('Invalid signature');
    });

    test('should succeed if challenge signature is valid from secondary wallet', async () => {
      const challengeObj = {
        nonce: 'link-nonce-456',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        primaryWallet: primaryWallet.address as any,
        secondaryWallet: secondaryWallet.address as any,
      };

      const message = `GuildPass Link Wallet Request\n` +
        `Primary Wallet: ${primaryWallet.address.toLowerCase()}\n` +
        `Secondary Wallet: ${secondaryWallet.address.toLowerCase()}\n` +
        `Nonce: ${challengeObj.nonce}\n` +
        `Issued At: ${challengeObj.issuedAt}\n` +
        `Expires At: ${challengeObj.expiresAt}`;

      const signature = await secondaryWallet.signMessage(message);

      (mockPrisma.challenge.findUnique as jest.Mock).mockResolvedValue({
        id: 'challenge-id',
        nonce: challengeObj.nonce,
        primaryWalletId: 'p-1',
        secondaryWalletId: 's-1',
        primaryWallet: { address: primaryWallet.address.toLowerCase() },
        secondaryWallet: { address: secondaryWallet.address.toLowerCase() },
        used: false,
        expiresAt: new Date(challengeObj.expiresAt),
      });

      // Mock linking transaction
      (mockPrisma.linkedWallet.create as jest.Mock).mockResolvedValue({
        id: 'link-id',
        primaryWalletId: 'p-1',
        secondaryWalletId: 's-1',
        primaryWalletAddress: primaryWallet.address.toLowerCase(),
        secondaryWalletAddress: secondaryWallet.address.toLowerCase(),
        linkedAt: new Date(),
      });

      const response = await app.inject({
        method: 'POST',
        url: `/v1/wallets/${primaryWallet.address}/link`,
        payload: {
          challenge: challengeObj,
          signature,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.primaryWalletAddress.toLowerCase()).toBe(primaryWallet.address.toLowerCase());
      expect(body.secondaryWalletAddress.toLowerCase()).toBe(secondaryWallet.address.toLowerCase());
    });
  });

  describe('SIWE Challenge / Verify Session Flow', () => {
    test('POST /v1/auth/nonce should return a nonce', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/nonce',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.nonce).toBeDefined();
      expect(mockPrisma.siweNonce.create).toHaveBeenCalled();
    });

    test('POST /v1/auth/verify should verify SIWE signature and issue token', async () => {
      const user = ethers.Wallet.createRandom();
      const nonce = 'siwenonce789';
      
      const domain = 'localhost:3000';
      const address = user.address;
      const uri = 'http://localhost:3000';
      const version = '1';
      const chainId = 1;
      const issuedAt = new Date().toISOString();

      const message = `${domain} wants you to sign in with your Ethereum account:\n` +
        `${address}\n\n` +
        `URI: ${uri}\n` +
        `Version: ${version}\n` +
        `Chain ID: ${chainId}\n` +
        `Nonce: ${nonce}\n` +
        `Issued At: ${issuedAt}`;

      const signature = await user.signMessage(message);

      // Mock nonce validation
      (mockPrisma.siweNonce.findUnique as jest.Mock).mockResolvedValue({
        id: 'nonce-id',
        nonce,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      });

      // Mock session creation
      (mockPrisma.session.create as jest.Mock).mockResolvedValue({
        token: 'session-token-xyz',
        walletAddress: user.address.toLowerCase(),
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/verify',
        payload: {
          message,
          signature,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.token).toBe('session-token-xyz');
      expect(body.walletAddress).toBe(user.address.toLowerCase());
    });
  });

  describe('Admin Gating via API Key', () => {
    test('should reject admin request if API key is missing or invalid', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/communities/community-1/members/0x1111111111111111111111111111111111111111/roles',
        payload: {
          role: 'admin',
        },
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body).error).toContain('Unauthorized');
    });

    test('should allow admin request if API key is valid', async () => {
      (mockPrisma.community.findUnique as jest.Mock).mockResolvedValue({ id: 'community-1' });
      
      const response = await app.inject({
        method: 'POST',
        url: '/v1/communities/community-1/members/0x1111111111111111111111111111111111111111/roles',
        headers: {
          'x-api-key': 'test-api-key', // default key configured in test config
        },
        payload: {
          role: 'admin',
        },
      });

      // Since the request proceeds past authentication to service logic,
      // and we have mocked Prisma, it might return validation error on roles (e.g. unknown requester since we didn't mock listMembersForAdmin),
      // but it will NOT return 401 Unauthorized.
      expect(response.statusCode).not.toBe(401);
    });
  });
});
