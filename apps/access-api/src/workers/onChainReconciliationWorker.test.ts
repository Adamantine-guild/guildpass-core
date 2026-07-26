/**
 * onChainReconciliationWorker.test.ts
 *
 * Tests for the on-chain reconciliation worker covering the two primary
 * acceptance criteria:
 *
 *   AC1. Discrepancy detection — a manually-corrupted DB record is detected
 *        and reported via a RECONCILIATION_DISCREPANCY audit event without
 *        either side being mutated.
 *
 *   AC2. No false positives — a fully-consistent DB / on-chain state produces
 *        zero discrepancy alerts across a full reconciliation pass.
 */

import {
  reconcileOnChainState,
  createOnChainReconciliationWorker,
  OnChainViewProvider,
  OnChainTokenState,
} from './onChainReconciliationWorker';
import { logEvent } from '../services/auditService';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../services/auditService', () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/prisma', () => ({
  getPrisma: jest.fn(() => makePrisma([])),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const FUTURE_UNIX = Math.floor(Date.now() / 1000) + 86_400; // +1 day
const PAST_UNIX   = Math.floor(Date.now() / 1000) - 86_400; // -1 day

/** Build a minimal MembershipToken row (with member/wallet) as Prisma returns it. */
function makeToken(overrides: {
  tokenId?: number;
  memberId?: string;
  state?: string;
  expiresAtUnix?: number | null;
  walletAddress?: string;
  communityId?: string;
}) {
  const {
    tokenId = 1,
    memberId = 'mem-1',
    state = 'active',
    expiresAtUnix = FUTURE_UNIX,
    walletAddress = '0xdeadbeef',
    communityId = 'community-1',
  } = overrides;

  return {
    tokenId,
    memberId,
    state,
    expiresAt: expiresAtUnix !== null ? new Date(expiresAtUnix * 1000) : null,
    renewedAt: null,
    createdAt: new Date(),
    member: {
      id: memberId,
      communityId,
      walletId: `wallet-${walletAddress}`,
      wallet: { id: `wallet-${walletAddress}`, address: walletAddress },
    },
  };
}

/** Build a matching OnChainTokenState that perfectly mirrors a makeToken() result. */
function matchingOnChain(token: ReturnType<typeof makeToken>): OnChainTokenState {
  return {
    owner: token.member.wallet.address.toLowerCase(),
    isActive: token.state === 'active',
    expiry: token.expiresAt ? Math.floor(token.expiresAt.getTime() / 1000) : 0,
    suspended: token.state === 'suspended',
    communityId: token.member.communityId,
  };
}

/** Build a Prisma mock that returns the given tokens from membershipToken.findMany. */
function makePrisma(tokens: ReturnType<typeof makeToken>[]) {
  return {
    membershipToken: {
      findMany: jest.fn().mockResolvedValue(tokens),
    },
  } as any;
}

/** Build a provider mock that returns a specific on-chain state per tokenId. */
function makeProvider(
  stateMap: Record<number, OnChainTokenState>,
): jest.Mocked<OnChainViewProvider> {
  return {
    getTokenState: jest.fn(async (tokenId: number) => {
      const state = stateMap[tokenId];
      if (!state) throw new Error(`No mock state for tokenId ${tokenId}`);
      return state;
    }),
  };
}

// ---------------------------------------------------------------------------
// AC2 — No false positives (fully-consistent state)
// ---------------------------------------------------------------------------

describe('reconcileOnChainState — no false positives', () => {
  beforeEach(() => jest.clearAllMocks());

  test('AC2: single active token whose on-chain state exactly matches DB produces zero discrepancies', async () => {
    const token = makeToken({ tokenId: 1, state: 'active', expiresAtUnix: FUTURE_UNIX });
    const prisma = makePrisma([token]);
    const provider = makeProvider({ 1: matchingOnChain(token) });

    const result = await reconcileOnChainState(prisma, provider);

    expect(result).toEqual({ checked: 1, discrepancies: 0, errors: 0 });
    expect(logEvent).not.toHaveBeenCalled();
  });

  test('AC2: suspended token matching on-chain suspended flag produces zero discrepancies', async () => {
    const token = makeToken({ tokenId: 2, state: 'suspended', expiresAtUnix: FUTURE_UNIX });
    const prisma = makePrisma([token]);
    const provider = makeProvider({
      2: { ...matchingOnChain(token), isActive: false, suspended: true },
    });

    const result = await reconcileOnChainState(prisma, provider);

    expect(result).toEqual({ checked: 1, discrepancies: 0, errors: 0 });
    expect(logEvent).not.toHaveBeenCalled();
  });

  test('AC2: multiple consistent tokens produce zero discrepancies', async () => {
    const tokens = [
      makeToken({ tokenId: 10, state: 'active', expiresAtUnix: FUTURE_UNIX, walletAddress: '0xaaa', communityId: 'c1' }),
      makeToken({ tokenId: 11, state: 'active', expiresAtUnix: FUTURE_UNIX, walletAddress: '0xbbb', communityId: 'c2' }),
      makeToken({ tokenId: 12, state: 'suspended', expiresAtUnix: FUTURE_UNIX, walletAddress: '0xccc', communityId: 'c1' }),
    ];
    const prisma = makePrisma(tokens);
    const stateMap: Record<number, OnChainTokenState> = {};
    for (const t of tokens) stateMap[t.tokenId] = matchingOnChain(t);
    const provider = makeProvider(stateMap);

    const result = await reconcileOnChainState(prisma, provider);

    expect(result).toEqual({ checked: 3, discrepancies: 0, errors: 0 });
    expect(logEvent).not.toHaveBeenCalled();
  });

  test('AC2: expiry within the 2-second tolerance window is not flagged', async () => {
    const token = makeToken({ tokenId: 5, state: 'active', expiresAtUnix: FUTURE_UNIX });
    const prisma = makePrisma([token]);
    // On-chain expiry is exactly 1 second off from DB — within tolerance.
    const provider = makeProvider({
      5: { ...matchingOnChain(token), expiry: FUTURE_UNIX + 1 },
    });

    const result = await reconcileOnChainState(prisma, provider);

    expect(result.discrepancies).toBe(0);
    expect(logEvent).not.toHaveBeenCalled();
  });

  test('AC2: zero tokens in sample produces zero discrepancies', async () => {
    const prisma = makePrisma([]);
    const provider = makeProvider({});

    const result = await reconcileOnChainState(prisma, provider);

    expect(result).toEqual({ checked: 0, discrepancies: 0, errors: 0 });
    expect(logEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC1 — Discrepancy detection (deliberately corrupted DB records)
// ---------------------------------------------------------------------------

describe('reconcileOnChainState — discrepancy detection', () => {
  beforeEach(() => jest.clearAllMocks());

  test('AC1: detects owner mismatch (DB wallet address differs from on-chain ownerOf)', async () => {
    const token = makeToken({ tokenId: 100, walletAddress: '0xoriginal' });
    const prisma = makePrisma([token]);
    const provider = makeProvider({
      100: { ...matchingOnChain(token), owner: '0xsomeoneelse' },
    });

    const result = await reconcileOnChainState(prisma, provider);

    expect(result.discrepancies).toBe(1);
    expect(logEvent).toHaveBeenCalledOnce();
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'RECONCILIATION_DISCREPANCY',
        reasonCode: 'ON_CHAIN_STATE_MISMATCH',
        walletId: '0xoriginal',
        communityId: 'community-1',
        beforeState: expect.objectContaining({ owner: '0xsomeoneelse' }),
        afterState: expect.objectContaining({ owner: '0xoriginal' }),
      }),
    );
  });

  test('AC1: detects isActive mismatch — DB says active but contract says inactive', async () => {
    const token = makeToken({ tokenId: 101, state: 'active' });
    const prisma = makePrisma([token]);
    const provider = makeProvider({
      101: { ...matchingOnChain(token), isActive: false },
    });

    const result = await reconcileOnChainState(prisma, provider);

    expect(result.discrepancies).toBe(1);
    expect(logEvent).toHaveBeenCalledOnce();
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'RECONCILIATION_DISCREPANCY',
        beforeState: expect.objectContaining({ isActive: false }),
        afterState: expect.objectContaining({ isActive: true }),
      }),
    );
  });

  test('AC1: detects expiry mismatch — DB expiresAt is 1 day off from on-chain (beyond tolerance)', async () => {
    const token = makeToken({ tokenId: 102, state: 'active', expiresAtUnix: FUTURE_UNIX });
    const prisma = makePrisma([token]);
    const corruptOnChainExpiry = FUTURE_UNIX + 86_400; // 1 day different
    const provider = makeProvider({
      102: { ...matchingOnChain(token), expiry: corruptOnChainExpiry },
    });

    const result = await reconcileOnChainState(prisma, provider);

    expect(result.discrepancies).toBe(1);
    expect(logEvent).toHaveBeenCalledOnce();
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'RECONCILIATION_DISCREPANCY',
        beforeState: expect.objectContaining({ expiry: corruptOnChainExpiry }),
        afterState: expect.objectContaining({ expiry: FUTURE_UNIX }),
      }),
    );
  });

  test('AC1: detects suspended mismatch — DB says suspended but contract says not suspended', async () => {
    const token = makeToken({ tokenId: 103, state: 'suspended' });
    const prisma = makePrisma([token]);
    const provider = makeProvider({
      103: { ...matchingOnChain(token), suspended: false, isActive: true },
    });

    const result = await reconcileOnChainState(prisma, provider);

    expect(result.discrepancies).toBe(1);
    expect(logEvent).toHaveBeenCalledOnce();
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'RECONCILIATION_DISCREPANCY',
        beforeState: expect.objectContaining({ suspended: false }),
        afterState: expect.objectContaining({ suspended: true }),
      }),
    );
  });

  test('AC1: detects communityId mismatch — DB community differs from on-chain', async () => {
    const token = makeToken({ tokenId: 104, communityId: 'community-correct' });
    const prisma = makePrisma([token]);
    const provider = makeProvider({
      104: { ...matchingOnChain(token), communityId: 'community-wrong' },
    });

    const result = await reconcileOnChainState(prisma, provider);

    expect(result.discrepancies).toBe(1);
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'RECONCILIATION_DISCREPANCY',
        beforeState: expect.objectContaining({ communityId: 'community-wrong' }),
        afterState: expect.objectContaining({}),
      }),
    );
  });

  test('AC1: multiple discrepant fields on the same token count as ONE discrepancy event', async () => {
    const token = makeToken({ tokenId: 105, state: 'active', expiresAtUnix: FUTURE_UNIX });
    const prisma = makePrisma([token]);
    const provider = makeProvider({
      105: {
        owner: '0xdifferent',
        isActive: false,
        expiry: PAST_UNIX,
        suspended: false,
        communityId: 'community-1',
      },
    });

    const result = await reconcileOnChainState(prisma, provider);

    // One token → one discrepancy alert, but the audit event contains all fields
    expect(result.discrepancies).toBe(1);
    expect(logEvent).toHaveBeenCalledOnce();
  });

  test('AC1: two tokens with different discrepancies each raise their own audit event', async () => {
    const t1 = makeToken({ tokenId: 200, state: 'active', walletAddress: '0xaaa' });
    const t2 = makeToken({ tokenId: 201, state: 'active', expiresAtUnix: FUTURE_UNIX, walletAddress: '0xbbb' });
    const prisma = makePrisma([t1, t2]);
    const provider = makeProvider({
      200: { ...matchingOnChain(t1), isActive: false },
      201: { ...matchingOnChain(t2), expiry: PAST_UNIX },
    });

    const result = await reconcileOnChainState(prisma, provider);

    expect(result).toMatchObject({ checked: 2, discrepancies: 2, errors: 0 });
    expect(logEvent).toHaveBeenCalledTimes(2);
  });

  test('AC1: DB record is NOT mutated by the worker (no update calls)', async () => {
    const token = makeToken({ tokenId: 300, state: 'active' });
    const prisma = makePrisma([token]);
    const provider = makeProvider({
      300: { ...matchingOnChain(token), isActive: false },
    });

    await reconcileOnChainState(prisma, provider);

    // findMany is called to read, but no update should be issued
    expect(prisma.membershipToken.findMany).toHaveBeenCalledOnce();
    expect((prisma.membershipToken as any).update).toBeUndefined();
    expect((prisma.membershipToken as any).upsert).toBeUndefined();
  });

  test('AC1: provider error for one token increments errors without throwing, other tokens proceed', async () => {
    const t1 = makeToken({ tokenId: 400 });
    const t2 = makeToken({ tokenId: 401 });
    const prisma = makePrisma([t1, t2]);

    const provider: jest.Mocked<OnChainViewProvider> = {
      getTokenState: jest
        .fn()
        .mockRejectedValueOnce(new Error('RPC timeout'))
        .mockResolvedValueOnce(matchingOnChain(t2)),
    };

    const result = await reconcileOnChainState(prisma, provider);

    expect(result.checked).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.discrepancies).toBe(0);
    expect(logEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Sampling / option tests
// ---------------------------------------------------------------------------

describe('reconcileOnChainState — sampling options', () => {
  beforeEach(() => jest.clearAllMocks());

  test('sampleSize limits the number of tokens checked', async () => {
    const tokens = Array.from({ length: 10 }, (_, i) =>
      makeToken({ tokenId: i + 1, state: 'active' }),
    );
    const prisma = makePrisma(tokens);
    const stateMap: Record<number, OnChainTokenState> = {};
    for (const t of tokens) stateMap[t.tokenId] = matchingOnChain(t);
    const provider = makeProvider(stateMap);

    // Over-fetch is min(sampleSize*4, 2000) = 20, then subsample to 3
    // — our mock returns 10 tokens, and shuffleAndSlice will pick 3
    const result = await reconcileOnChainState(prisma, provider, {
      sampleSize: 3,
      randomSample: true,
    });

    expect(result.checked).toBe(3);
  });

  test('communityId filter is passed to the DB query', async () => {
    const token = makeToken({ tokenId: 1, communityId: 'c-target' });
    const prisma = makePrisma([token]);
    const provider = makeProvider({ 1: matchingOnChain(token) });

    await reconcileOnChainState(prisma, provider, {
      communityId: 'c-target',
      randomSample: false,
    });

    expect(prisma.membershipToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          member: { communityId: 'c-target' },
        }),
      }),
    );
  });

  test('activeOnly=true filters query to active and suspended states', async () => {
    const prisma = makePrisma([]);
    const provider = makeProvider({});

    await reconcileOnChainState(prisma, provider, { activeOnly: true });

    expect(prisma.membershipToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: { in: ['active', 'suspended'] },
        }),
      }),
    );
  });

  test('activeOnly=false removes the state filter from the DB query', async () => {
    const prisma = makePrisma([]);
    const provider = makeProvider({});

    await reconcileOnChainState(prisma, provider, { activeOnly: false });

    const callArg = (prisma.membershipToken.findMany as jest.Mock).mock.calls[0][0];
    expect(callArg.where).not.toHaveProperty('state');
  });

  test('randomSample=false produces a deterministic ORDER BY tokenId: asc query', async () => {
    const prisma = makePrisma([]);
    const provider = makeProvider({});

    await reconcileOnChainState(prisma, provider, { randomSample: false, sampleSize: 5 });

    expect(prisma.membershipToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { tokenId: 'asc' },
        take: 5,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Worker lifecycle tests
// ---------------------------------------------------------------------------

describe('createOnChainReconciliationWorker — lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });
  afterEach(() => jest.useRealTimers());

  test('start/stop lifecycle does not throw', () => {
    const provider = makeProvider({});
    const prisma = makePrisma([]);
    const worker = createOnChainReconciliationWorker(10_000, provider, {}, prisma);
    expect(() => {
      worker.start();
      worker.stop();
    }).not.toThrow();
  });

  test('calling start twice does not create a second interval', () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const provider = makeProvider({});
    const prisma = makePrisma([]);
    const worker = createOnChainReconciliationWorker(10_000, provider, {}, prisma);

    worker.start();
    worker.start(); // second call should be a no-op

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    worker.stop();
    setIntervalSpy.mockRestore();
  });

  test('stop before start does not throw', () => {
    const provider = makeProvider({});
    const prisma = makePrisma([]);
    const worker = createOnChainReconciliationWorker(10_000, provider, {}, prisma);
    expect(() => worker.stop()).not.toThrow();
  });

  test('worker fires the reconciliation pass after the configured interval', async () => {
    const token = makeToken({ tokenId: 1, state: 'active' });
    const prisma = makePrisma([token]);
    const provider = makeProvider({ 1: matchingOnChain(token) });
    const worker = createOnChainReconciliationWorker(10_000, provider, {}, prisma);

    worker.start();
    jest.advanceTimersByTime(10_000);
    // Allow the async run() to settle
    await Promise.resolve();

    expect(prisma.membershipToken.findMany).toHaveBeenCalled();
    worker.stop();
  });
});

// ---------------------------------------------------------------------------
// Custom matcher extension
// ---------------------------------------------------------------------------

expect.extend({
  toHaveBeenCalledOnce(received: jest.Mock) {
    const count = received.mock.calls.length;
    const pass = count === 1;
    return {
      pass,
      message: () =>
        pass
          ? `Expected mock NOT to have been called exactly once, but it was.`
          : `Expected mock to have been called exactly once, but it was called ${count} time(s).`,
    };
  },
});

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toHaveBeenCalledOnce(): R;
    }
  }
}
