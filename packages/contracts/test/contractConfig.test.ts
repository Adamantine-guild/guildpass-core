import {
  isValidEvmAddress,
  isValidChainId,
  validateContractConfig,
  getContractAddresses,
  KNOWN_CHAIN_IDS,
} from '../src/index';

describe('isValidEvmAddress', () => {
  test('accepts a valid lowercase EVM address', () => {
    expect(isValidEvmAddress('0x' + 'a'.repeat(40))).toBe(true);
  });

  test('accepts a valid uppercase EVM address', () => {
    expect(isValidEvmAddress('0x' + 'A'.repeat(40))).toBe(true);
  });

  test('accepts a valid mixed-case EVM address', () => {
    expect(isValidEvmAddress('0xAbCdEf1234567890AbCdEf1234567890AbCdEf12')).toBe(true);
  });

  test('rejects empty string', () => {
    expect(isValidEvmAddress('')).toBe(false);
  });

  test('rejects address without 0x prefix', () => {
    expect(isValidEvmAddress('a'.repeat(40))).toBe(false);
  });

  test('rejects address that is too short', () => {
    expect(isValidEvmAddress('0x' + 'a'.repeat(39))).toBe(false);
  });

  test('rejects address that is too long', () => {
    expect(isValidEvmAddress('0x' + 'a'.repeat(41))).toBe(false);
  });

  test('rejects address with non-hex characters', () => {
    expect(isValidEvmAddress('0x' + 'g'.repeat(40))).toBe(false);
  });

  test('rejects non-address strings', () => {
    expect(isValidEvmAddress('not-an-address')).toBe(false);
    expect(isValidEvmAddress('0x')).toBe(false);
    expect(isValidEvmAddress('hello world')).toBe(false);
  });
});

describe('isValidChainId', () => {
  test('accepts positive integers', () => {
    expect(isValidChainId(1)).toBe(true);
    expect(isValidChainId(137)).toBe(true);
    expect(isValidChainId(31337)).toBe(true);
  });

  test('rejects zero', () => {
    expect(isValidChainId(0)).toBe(false);
  });

  test('rejects negative numbers', () => {
    expect(isValidChainId(-1)).toBe(false);
    expect(isValidChainId(-100)).toBe(false);
  });

  test('rejects non-integers', () => {
    expect(isValidChainId(1.5)).toBe(false);
    expect(isValidChainId(3.14)).toBe(false);
  });

  test('rejects non-finite numbers', () => {
    expect(isValidChainId(Infinity)).toBe(false);
    expect(isValidChainId(NaN)).toBe(false);
  });

  test('rejects non-number types', () => {
    expect(isValidChainId('1' as any)).toBe(false);
    expect(isValidChainId(null as any)).toBe(false);
    expect(isValidChainId(undefined as any)).toBe(false);
    expect(isValidChainId({} as any)).toBe(false);
  });
});

describe('validateContractConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('returns valid when both env vars are correctly set', () => {
    process.env.MEMBERSHIP_NFT_ADDRESS = '0x' + 'a'.repeat(40);
    process.env.CHAIN_ID = '1';

    const result = validateContractConfig();
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('returns error when MEMBERSHIP_NFT_ADDRESS is not set', () => {
    delete process.env.MEMBERSHIP_NFT_ADDRESS;
    process.env.CHAIN_ID = '1';

    const result = validateContractConfig();
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('MEMBERSHIP_NFT_ADDRESS is not set');
  });

  test('returns error when MEMBERSHIP_NFT_ADDRESS is invalid', () => {
    process.env.MEMBERSHIP_NFT_ADDRESS = 'not-valid';
    process.env.CHAIN_ID = '1';

    const result = validateContractConfig();
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/not a valid EVM address/);
  });

  test('returns error when CHAIN_ID is not set', () => {
    process.env.MEMBERSHIP_NFT_ADDRESS = '0x' + 'a'.repeat(40);
    delete process.env.CHAIN_ID;

    const result = validateContractConfig();
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('CHAIN_ID is not set');
  });

  test('returns error when CHAIN_ID is not a valid number', () => {
    process.env.MEMBERSHIP_NFT_ADDRESS = '0x' + 'a'.repeat(40);
    process.env.CHAIN_ID = 'abc';

    const result = validateContractConfig();
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/not a valid positive integer/);
  });

  test('returns error when CHAIN_ID is zero', () => {
    process.env.MEMBERSHIP_NFT_ADDRESS = '0x' + 'a'.repeat(40);
    process.env.CHAIN_ID = '0';

    const result = validateContractConfig();
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/not a valid positive integer/);
  });

  test('returns error when CHAIN_ID is negative', () => {
    process.env.MEMBERSHIP_NFT_ADDRESS = '0x' + 'a'.repeat(40);
    process.env.CHAIN_ID = '-1';

    const result = validateContractConfig();
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/not a valid positive integer/);
  });

  test('returns multiple errors when both env vars are invalid', () => {
    process.env.MEMBERSHIP_NFT_ADDRESS = 'bad';
    process.env.CHAIN_ID = 'bad';

    const result = validateContractConfig();
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  test('accepts known chain IDs', () => {
    process.env.MEMBERSHIP_NFT_ADDRESS = '0x' + 'a'.repeat(40);

    for (const chainId of Object.keys(KNOWN_CHAIN_IDS)) {
      process.env.CHAIN_ID = chainId;
      const result = validateContractConfig();
      expect(result.valid).toBe(true);
    }
  });
});

describe('getContractAddresses', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('returns valid addresses when config is correct', () => {
    const addr = '0x' + 'a'.repeat(40);
    process.env.MEMBERSHIP_NFT_ADDRESS = addr;
    process.env.CHAIN_ID = '137';

    const result = getContractAddresses();
    expect(result.membershipNFT).toBe(addr);
    expect(result.chainId).toBe(137);
  });

  test('throws when MEMBERSHIP_NFT_ADDRESS is missing', () => {
    delete process.env.MEMBERSHIP_NFT_ADDRESS;
    process.env.CHAIN_ID = '1';

    expect(() => getContractAddresses()).toThrow('Invalid contract configuration');
    expect(() => getContractAddresses()).toThrow('MEMBERSHIP_NFT_ADDRESS is not set');
  });

  test('throws when MEMBERSHIP_NFT_ADDRESS is invalid', () => {
    process.env.MEMBERSHIP_NFT_ADDRESS = 'invalid';
    process.env.CHAIN_ID = '1';

    expect(() => getContractAddresses()).toThrow('not a valid EVM address');
  });

  test('throws when CHAIN_ID is missing', () => {
    process.env.MEMBERSHIP_NFT_ADDRESS = '0x' + 'a'.repeat(40);
    delete process.env.CHAIN_ID;

    expect(() => getContractAddresses()).toThrow('CHAIN_ID is not set');
  });

  test('throws when CHAIN_ID is invalid', () => {
    process.env.MEMBERSHIP_NFT_ADDRESS = '0x' + 'a'.repeat(40);
    process.env.CHAIN_ID = 'not-a-number';

    expect(() => getContractAddresses()).toThrow('not a valid positive integer');
  });

  test('parses CHAIN_ID as integer', () => {
    process.env.MEMBERSHIP_NFT_ADDRESS = '0x' + 'a'.repeat(40);
    process.env.CHAIN_ID = '31337';

    const result = getContractAddresses();
    expect(typeof result.chainId).toBe('number');
    expect(result.chainId).toBe(31337);
  });
});
