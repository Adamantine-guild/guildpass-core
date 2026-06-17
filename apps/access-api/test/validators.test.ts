import {
  accessCheckBodySchema,
  communityIdParamSchema,
  roleQuerySchema,
  walletParamSchema,
} from '../src/validators';

// 56-char valid Stellar public keys (alphabet A-Z, 2-7)
const VALID_WALLET = 'A'.repeat(56);
// 56 chars but with invalid char '0' (not in base32)
const INVALID_WALLET = 'A'.repeat(55) + '0';
// Too short
const SHORT_WALLET = 'GAAAA';

describe('walletParamSchema', () => {
  test('accepts a valid 56-char Stellar wallet', () => {
    const r = walletParamSchema.safeParse({ wallet: VALID_WALLET });
    expect(r.success).toBe(true);
  });

  test('rejects wallet with invalid base32 char (0)', () => {
    const r = walletParamSchema.safeParse({ wallet: INVALID_WALLET });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].path).toEqual(['wallet']);
    }
  });

  test('rejects wallet that is too short', () => {
    const r = walletParamSchema.safeParse({ wallet: SHORT_WALLET });
    expect(r.success).toBe(false);
  });

  test('rejects empty wallet', () => {
    const r = walletParamSchema.safeParse({ wallet: '' });
    expect(r.success).toBe(false);
  });

  test('rejects non-string wallet', () => {
    const r = walletParamSchema.safeParse({ wallet: 12345 });
    expect(r.success).toBe(false);
  });
});

describe('communityIdParamSchema', () => {
  test('accepts a non-empty id', () => {
    const r = communityIdParamSchema.safeParse({ communityId: 'c1' });
    expect(r.success).toBe(true);
  });

  test('rejects empty id', () => {
    const r = communityIdParamSchema.safeParse({ communityId: '' });
    expect(r.success).toBe(false);
  });

  test('rejects id over 256 chars', () => {
    const r = communityIdParamSchema.safeParse({ communityId: 'a'.repeat(257) });
    expect(r.success).toBe(false);
  });
});

describe('roleQuerySchema', () => {
  test('accepts undefined (role is optional)', () => {
    const r = roleQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.role).toBeUndefined();
  });

  test('accepts admin/member/contributor', () => {
    for (const role of ['admin', 'member', 'contributor']) {
      const r = roleQuerySchema.safeParse({ role });
      expect(r.success).toBe(true);
    }
  });

  test('rejects unknown role', () => {
    const r = roleQuerySchema.safeParse({ role: 'superuser' });
    expect(r.success).toBe(false);
  });
});

describe('accessCheckBodySchema', () => {
  test('accepts a valid body', () => {
    const r = accessCheckBodySchema.safeParse({
      wallet: VALID_WALLET,
      communityId: 'c1',
      resource: 'docs/intro',
    });
    expect(r.success).toBe(true);
  });

  test('rejects body with empty communityId', () => {
    const r = accessCheckBodySchema.safeParse({
      wallet: VALID_WALLET,
      communityId: '',
      resource: 'docs/intro',
    });
    expect(r.success).toBe(false);
  });

  test('rejects body with empty resource', () => {
    const r = accessCheckBodySchema.safeParse({
      wallet: VALID_WALLET,
      communityId: 'c1',
      resource: '',
    });
    expect(r.success).toBe(false);
  });

  test('rejects body with invalid wallet', () => {
    const r = accessCheckBodySchema.safeParse({
      wallet: SHORT_WALLET,
      communityId: 'c1',
      resource: 'docs/intro',
    });
    expect(r.success).toBe(false);
  });

  test('rejects body missing required fields', () => {
    const r = accessCheckBodySchema.safeParse({ wallet: VALID_WALLET });
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join('.'));
      expect(paths).toEqual(expect.arrayContaining(['communityId', 'resource']));
    }
  });
});
