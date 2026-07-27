import { isAddress } from "ethers";

/**
 * Returns true when `value` is a syntactically valid EVM address (checksummed
 * or lowercase). Backed by ethers' `isAddress`, so a mixed-case input whose
 * EIP-55 checksum is wrong is rejected rather than silently accepted.
 */
export function isValidWalletAddress(value: unknown): value is string {
  return typeof value === "string" && isAddress(value);
}

/**
 * Canonical storage form for wallet addresses across the API: lowercase.
 *
 * Deliberately NOT the EIP-55 checksum form (`getAddress`): `Wallet.address` is
 * unique and every existing row and call site is already lowercase, so adopting
 * checksum as canonical would orphan current data. Lowercasing keeps the
 * checksummed and lowercase spellings of one wallet mapped to a single record.
 */
export function normalizeWalletAddress(value: string): string {
  return value.toLowerCase();
}
