/**
 * Deterministic validation for Stellar StrKey-encoded addresses.
 *
 * Implements RFC4648 base32 decoding and the StrKey checksum (CRC16/XMODEM)
 * directly, per https://developers.stellar.org/docs/encyclopedia/base32.
 * Has no dependency on a Stellar SDK, database, or HTTP framework, so it can
 * be safely reused by any GuildPass module that needs to accept a Stellar
 * account identifier (wallet linking, membership operations, contract
 * integrations, etc.).
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STRKEY_PATTERN = /^[A-Z2-7]+$/;

/**
 * StrKey version bytes. Only `accountId` (`G...`) is a supported GuildPass
 * address type. The others are still recognised so that well-formed StrKeys
 * of those types can be rejected explicitly via `UNSUPPORTED_ADDRESS_TYPE`
 * instead of silently accepted or lumped in with generically malformed input.
 */
const STRKEY_VERSION_BYTE = {
  accountId: 6 << 3, // 'G' - ed25519 public key
  muxedAccount: 12 << 3, // 'M'
  seed: 18 << 3, // 'S' - ed25519 secret seed
  preAuthTx: 19 << 3, // 'T'
  sha256Hash: 23 << 3, // 'X'
  signedPayload: 15 << 3, // 'P'
  contract: 2 << 3, // 'C'
  liquidityPool: 11 << 3, // 'L'
  claimableBalance: 1 << 3, // 'B'
} as const;

const KNOWN_VERSION_BYTES = new Set<number>(Object.values(STRKEY_VERSION_BYTE));
const ED25519_PUBLIC_KEY_PAYLOAD_LENGTH = 32;

export type StellarAddressValidationErrorCode =
  | "EMPTY_ADDRESS"
  | "INVALID_STRKEY"
  | "UNSUPPORTED_ADDRESS_TYPE";

export type StellarAddressValidationResult =
  | { readonly valid: true; readonly address: string }
  | { readonly valid: false; readonly code: StellarAddressValidationErrorCode };

/**
 * Decodes an unpadded RFC4648 base32 string into raw bytes.
 *
 * Returns null when the input is not the unique canonical encoding of a byte
 * sequence: an unknown alphabet character, non-zero trailing padding bits,
 * or a length longer than the minimal encoding for the resulting bytes (e.g.
 * a valid StrKey with extra trailing zero-value characters appended).
 */
function decodeBase32(input: string): Uint8Array | null {
  let bitBuffer = 0;
  let bitCount = 0;
  const bytes: number[] = [];

  for (const char of input) {
    const symbol = BASE32_ALPHABET.indexOf(char);
    if (symbol === -1) {
      return null;
    }
    bitBuffer = (bitBuffer << 5) | symbol;
    bitCount += 5;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bitBuffer >>> bitCount) & 0xff);
    }
    bitBuffer &= (1 << bitCount) - 1;
  }

  if (bitBuffer !== 0) {
    return null;
  }
  if (input.length !== Math.ceil((bytes.length * 8) / 5)) {
    return null;
  }

  return Uint8Array.from(bytes);
}

/** CRC16/XMODEM checksum, as used by the Stellar StrKey format. */
function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/**
 * Validates a Stellar StrKey address.
 *
 * Behaviour:
 * - Only leading/trailing whitespace is trimmed before validation; internal
 *   whitespace and casing are never altered or tolerated.
 * - Only ed25519 public account addresses (the `G...` StrKey type) are
 *   accepted as valid GuildPass addresses.
 * - Other well-formed StrKey types (muxed accounts, seeds, pre-auth tx
 *   hashes, sha256 hashes, signed payloads, contracts, liquidity pools,
 *   claimable balances) are recognised and rejected explicitly via
 *   `UNSUPPORTED_ADDRESS_TYPE`.
 * - Never throws for ordinary invalid input.
 */
export function validateStellarAddress(input: unknown): StellarAddressValidationResult {
  if (typeof input !== "string") {
    return { valid: false, code: "EMPTY_ADDRESS" };
  }

  const address = input.trim();
  if (address.length === 0) {
    return { valid: false, code: "EMPTY_ADDRESS" };
  }

  if (!STRKEY_PATTERN.test(address)) {
    return { valid: false, code: "INVALID_STRKEY" };
  }

  const decoded = decodeBase32(address);
  if (decoded === null || decoded.length < 3) {
    return { valid: false, code: "INVALID_STRKEY" };
  }

  const versionAndPayload = decoded.subarray(0, decoded.length - 2);
  const checksumBytes = decoded.subarray(decoded.length - 2);
  const expectedChecksum = checksumBytes[0] | (checksumBytes[1] << 8);
  const actualChecksum = crc16xmodem(versionAndPayload);

  if (expectedChecksum !== actualChecksum) {
    return { valid: false, code: "INVALID_STRKEY" };
  }

  const versionByte = versionAndPayload[0];
  const payload = versionAndPayload.subarray(1);

  if (versionByte !== STRKEY_VERSION_BYTE.accountId) {
    return {
      valid: false,
      code: KNOWN_VERSION_BYTES.has(versionByte) ? "UNSUPPORTED_ADDRESS_TYPE" : "INVALID_STRKEY",
    };
  }

  if (payload.length !== ED25519_PUBLIC_KEY_PAYLOAD_LENGTH) {
    return { valid: false, code: "INVALID_STRKEY" };
  }

  return { valid: true, address };
}

/** Type guard variant of {@link validateStellarAddress}. */
export function isStellarAddress(input: unknown): input is string {
  return validateStellarAddress(input).valid;
}

/** Thrown by {@link assertStellarAddress} when validation fails. */
export class InvalidStellarAddressError extends Error {
  public readonly code: StellarAddressValidationErrorCode;

  constructor(code: StellarAddressValidationErrorCode) {
    super(`Invalid Stellar address: ${code}`);
    this.name = "InvalidStellarAddressError";
    this.code = code;
  }
}

/**
 * Asserts that `input` is a valid Stellar address, returning the normalised
 * (trimmed) address on success. Throws {@link InvalidStellarAddressError} on
 * failure. Intended for call sites that have already decided invalid input
 * is exceptional, not for validating raw user input on the happy path.
 */
export function assertStellarAddress(input: unknown): string {
  const result = validateStellarAddress(input);
  if (!result.valid) {
    throw new InvalidStellarAddressError(result.code);
  }
  return result.address;
}
