const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function parseUrl(key: string, value: string): string {
  try {
    new URL(value);
  } catch {
    throw new Error(`Invalid URL for ${key}: "${value}"`);
  }
  return value;
}

function parsePort(key: string, raw: string): number {
  const port = parseInt(raw, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port for ${key}: "${raw}"`);
  }
  return port;
}

function parseChainId(raw: string): number {
  const id = parseInt(raw, 10);
  if (isNaN(id) || id < 1) throw new Error(`Invalid CHAIN_ID: "${raw}"`);
  return id;
}

function parseContractAddress(key: string, value: string): string {
  if (!EVM_ADDRESS_RE.test(value)) {
    throw new Error(`Invalid EVM address for ${key}: "${value}"`);
  }
  return value;
}

export interface Config {
  databaseUrl: string;
  redisUrl: string;
  port: number;
  nodeEnv: string;
  membershipNftAddress: string | null;
  chainId: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = parseUrl('DATABASE_URL', requireEnv(env, 'DATABASE_URL'));
  const redisUrl = parseUrl('REDIS_URL', requireEnv(env, 'REDIS_URL'));
  const port = parsePort('PORT', env.PORT ?? '3000');
  const nodeEnv = env.NODE_ENV ?? 'development';
  const chainId = parseChainId(env.CHAIN_ID ?? '31337');

  const rawAddress = env.MEMBERSHIP_NFT_ADDRESS;
  const membershipNftAddress =
    rawAddress && rawAddress !== ''
      ? parseContractAddress('MEMBERSHIP_NFT_ADDRESS', rawAddress)
      : null;

  return { databaseUrl, redisUrl, port, nodeEnv, chainId, membershipNftAddress };
}

// Singleton — evaluated once at startup; throws if config is invalid.
export const config: Config = loadConfig();
