export interface ContractAddresses {
  membershipNFT: string;
  chainId: number;
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

/**
 * Validates the contract configuration from environment variables.
 * Returns a result object with validation status and any errors.
 */
export function validateContractConfig(): ContractValidationResult {
  const errors: string[] = [];

  const membershipNFT = process.env.MEMBERSHIP_NFT_ADDRESS ?? '';
  if (!membershipNFT) {
    errors.push('MEMBERSHIP_NFT_ADDRESS is not set');
  } else if (!isValidEvmAddress(membershipNFT)) {
    errors.push(
      `MEMBERSHIP_NFT_ADDRESS "${membershipNFT}" is not a valid EVM address (expected 0x + 40 hex chars)`,
    );
  }

  const chainIdRaw = process.env.CHAIN_ID ?? '';
  if (!chainIdRaw) {
    errors.push('CHAIN_ID is not set');
  } else {
    const parsed = Number(chainIdRaw);
    if (!isValidChainId(parsed)) {
      errors.push(
        `CHAIN_ID "${chainIdRaw}" is not a valid positive integer`,
      );
    }
  }

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

  return {
    membershipNFT: process.env.MEMBERSHIP_NFT_ADDRESS!,
    chainId: parseInt(process.env.CHAIN_ID!, 10),
  };
}

// Legacy export — silently returns empty contract address in production.
// Prefer getContractAddresses() which validates before returning.
export const addresses: ContractAddresses = {
  membershipNFT: process.env.MEMBERSHIP_NFT_ADDRESS || '',
  chainId: parseInt(process.env.CHAIN_ID || '31337', 10),
};

// Minimal ABI fragment for events the backend may subscribe to later
export const MembershipNFTAbi = [
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "to", "type": "address" },
      { "indexed": true, "internalType": "uint256", "name": "tokenId", "type": "uint256" },
      { "indexed": false, "internalType": "string", "name": "communityId", "type": "string" },
      { "indexed": false, "internalType": "uint256", "name": "expiresAt", "type": "uint256" }
    ],
    "name": "MembershipMinted",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "uint256", "name": "tokenId", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "newExpiresAt", "type": "uint256" }
    ],
    "name": "MembershipRenewed",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "uint256", "name": "tokenId", "type": "uint256" },
      { "indexed": false, "internalType": "bool", "name": "isSuspended", "type": "bool" }
    ],
    "name": "MembershipSuspended",
    "type": "event"
  }
] as const;
