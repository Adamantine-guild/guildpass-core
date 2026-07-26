export interface ContractAddresses {
  membershipNFT: string;
  chainId: number;
}

export interface MembershipChainConfig extends ContractAddresses {
  rpcUrl?: string;
  name?: string;
}

/**
 * Validates that a string is a valid EVM address (0x + 40 hex chars).
 */
export function isValidEvmAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

/**
 * Validates that a value is a valid chain ID (positive integer).
 */
export function isValidChainId(chainId: unknown): chainId is number {
  if (typeof chainId !== 'number') return false;
  if (!Number.isFinite(chainId)) return false;
  if (!Number.isInteger(chainId)) return false;
  if (chainId <= 0) return false;
  return true;
}

/**
 * Known chain IDs for reference (mainnet, goerli, sepolia, hardhat, etc.)
 */
export const KNOWN_CHAIN_IDS: Record<number, string> = {
  1: 'Ethereum Mainnet',
  5: 'Goerli Testnet',
  11155111: 'Sepolia Testnet',
  137: 'Polygon Mainnet',
  80001: 'Polygon Mumbai',
  42161: 'Arbitrum One',
  10: 'Optimism Mainnet',
  31337: 'Hardhat Local',
};

export interface ContractValidationResult {
  valid: boolean;
  errors: string[];
}

export function parseMembershipChainConfigs(raw = process.env.MEMBERSHIP_CHAIN_CONFIGS): MembershipChainConfig[] {
  if (raw?.trim()) {
    const parsed = JSON.parse(raw) as Array<{ chainId: number | string; membershipNftAddress: string; rpcUrl?: string; name?: string }>;
    return parsed.map((entry) => ({
      chainId: Number(entry.chainId),
      membershipNFT: entry.membershipNftAddress,
      rpcUrl: entry.rpcUrl,
      name: entry.name,
    }));
  }

  return [{
    membershipNFT: process.env.MEMBERSHIP_NFT_ADDRESS || '',
    chainId: process.env.CHAIN_ID === undefined ? NaN : parseInt(process.env.CHAIN_ID, 10),
    rpcUrl: process.env.RPC_URL,
  }];
}

/**
 * Validates the contract configuration from environment variables.
 * Returns a result object with validation status and any errors.
 */
export function validateContractConfig(): ContractValidationResult {
  const errors: string[] = [];

  let configs: MembershipChainConfig[] = [];
  try {
    configs = parseMembershipChainConfigs();
  } catch (error) {
    errors.push(`MEMBERSHIP_CHAIN_CONFIGS is not valid JSON: ${(error as Error).message}`);
  }

  if (configs.length === 0) {
    errors.push('At least one membership chain config is required');
  }

  configs.forEach((config, index) => {
    const legacy = configs.length === 1 && !process.env.MEMBERSHIP_CHAIN_CONFIGS;
    const prefix = legacy ? '' : `MEMBERSHIP_CHAIN_CONFIGS[${index}].`;
    if (!config.membershipNFT) {
      errors.push(legacy ? 'MEMBERSHIP_NFT_ADDRESS is not set' : `${prefix}membershipNftAddress is not set`);
    } else if (!isValidEvmAddress(config.membershipNFT)) {
      errors.push(legacy
        ? `MEMBERSHIP_NFT_ADDRESS "${config.membershipNFT}" is not a valid EVM address (expected 0x + 40 hex chars)`
        : `${prefix}membershipNftAddress "${config.membershipNFT}" is not a valid EVM address (expected 0x + 40 hex chars)`);
    }

    if (!isValidChainId(config.chainId)) {
      const chainIdRaw = legacy ? (process.env.CHAIN_ID ?? '') : String(config.chainId);
      errors.push(legacy
        ? (chainIdRaw ? `CHAIN_ID "${chainIdRaw}" is not a valid positive integer` : 'CHAIN_ID is not set')
        : `${prefix}chainId "${config.chainId}" is not a valid positive integer`);
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Returns validated contract addresses. Throws if the configuration is invalid.
 * Use validateContractConfig() first if you want to inspect errors without throwing.
 */
export function getContractAddresses(): ContractAddresses {
  const validation = validateContractConfig();

  if (!validation.valid) {
    throw new Error(
      `Invalid contract configuration:\n${validation.errors.join('\n')}`,
    );
  }

  return parseMembershipChainConfigs()[0];
}

// Returns all configured membership deployments. Prefer this for multi-chain indexing.
export function getMembershipChainConfigs(): MembershipChainConfig[] {
  const validation = validateContractConfig();
  if (!validation.valid) {
    throw new Error(`Invalid contract configuration:\n${validation.errors.join('\n')}`);
  }
  return parseMembershipChainConfigs();
}

// Legacy export — first configured contract only. Prefer getMembershipChainConfigs().
export const addresses: ContractAddresses = {
  membershipNFT: process.env.MEMBERSHIP_NFT_ADDRESS || '',
  chainId: parseInt(process.env.CHAIN_ID || '31337', 10),
};

// ---------------------------------------------------------------------------
// Re-export everything from the events module — the single source of truth
// for contract ABI, typed event definitions, and log decoders.
// ---------------------------------------------------------------------------
export {
  MembershipNFTAbi,
  EVENT_TOPICS,
  decodeEventLog,
  getAbiEvent,
  getTopicHash,
} from './events';

export type {
  AbiEvent,
  AbiEventParameter,
  RawLog,
  EventMetadata,
  DecodedContractEvent,
  DecodedMembershipMintedEvent,
  DecodedMembershipRenewedEvent,
  DecodedMembershipSuspendedEvent,
  DecodedAdminUpdatedEvent,
  DecodedOwnershipTransferProposedEvent,
  DecodedOwnershipTransferredEvent,
  DecodedMembershipMerkleRootUpdatedEvent,
  DecodedMembershipClaimedEvent,
} from './events';
