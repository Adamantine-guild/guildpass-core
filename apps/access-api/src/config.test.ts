import { loadConfig } from '../config';

const VALID: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  PORT: '3000',
  NODE_ENV: 'test',
  CHAIN_ID: '1',
  MEMBERSHIP_NFT_ADDRESS: '',
};

describe('loadConfig', () => {
  it('returns a valid config for a complete env', () => {
    const cfg = loadConfig(VALID);
    expect(cfg.databaseUrl).toBe(VALID.DATABASE_URL);
    expect(cfg.redisUrl).toBe(VALID.REDIS_URL);
    expect(cfg.port).toBe(3000);
    expect(cfg.nodeEnv).toBe('test');
    expect(cfg.chainId).toBe(1);
    expect(cfg.membershipNftAddress).toBeNull();
  });

  it('applies defaults for PORT, NODE_ENV, and CHAIN_ID when omitted', () => {
    const cfg = loadConfig({ DATABASE_URL: VALID.DATABASE_URL, REDIS_URL: VALID.REDIS_URL });
    expect(cfg.port).toBe(3000);
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.chainId).toBe(31337);
  });

  it('parses a valid MEMBERSHIP_NFT_ADDRESS', () => {
    const cfg = loadConfig({ ...VALID, MEMBERSHIP_NFT_ADDRESS: '0xabc123AB23456789abcdef01234567890ABCDEF01'.slice(0, 42) });
    // any valid 42-char address
    const addr = '0x' + 'a'.repeat(40);
    const cfg2 = loadConfig({ ...VALID, MEMBERSHIP_NFT_ADDRESS: addr });
    expect(cfg2.membershipNftAddress).toBe(addr);
  });

  it('throws when DATABASE_URL is missing', () => {
    const env = { ...VALID };
    delete env.DATABASE_URL;
    expect(() => loadConfig(env)).toThrow('DATABASE_URL');
  });

  it('throws when REDIS_URL is missing', () => {
    const env = { ...VALID };
    delete env.REDIS_URL;
    expect(() => loadConfig(env)).toThrow('REDIS_URL');
  });

  it('throws for an invalid DATABASE_URL', () => {
    expect(() => loadConfig({ ...VALID, DATABASE_URL: 'not-a-url' })).toThrow('DATABASE_URL');
  });

  it('throws for an invalid REDIS_URL', () => {
    expect(() => loadConfig({ ...VALID, REDIS_URL: 'not-a-url' })).toThrow('REDIS_URL');
  });

  it('throws for a PORT out of range', () => {
    expect(() => loadConfig({ ...VALID, PORT: '99999' })).toThrow('PORT');
    expect(() => loadConfig({ ...VALID, PORT: '0' })).toThrow('PORT');
    expect(() => loadConfig({ ...VALID, PORT: 'abc' })).toThrow('PORT');
  });

  it('throws for an invalid CHAIN_ID', () => {
    expect(() => loadConfig({ ...VALID, CHAIN_ID: '0' })).toThrow('CHAIN_ID');
    expect(() => loadConfig({ ...VALID, CHAIN_ID: 'mainnet' })).toThrow('CHAIN_ID');
  });

  it('throws for a malformed MEMBERSHIP_NFT_ADDRESS', () => {
    expect(() => loadConfig({ ...VALID, MEMBERSHIP_NFT_ADDRESS: '0xinvalid' })).toThrow('MEMBERSHIP_NFT_ADDRESS');
  });
});
