import { isValidWalletAddress, normalizeWalletAddress } from "./wallet";

// Classic EIP-55 test vector.
const LOWER = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const CHECKSUM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

describe("lib/wallet (#173)", () => {
  it("accepts valid lowercase and checksummed addresses", () => {
    expect(isValidWalletAddress(LOWER)).toBe(true);
    expect(isValidWalletAddress(CHECKSUM)).toBe(true);
  });

  it("rejects malformed, wrong-length and non-string inputs", () => {
    expect(isValidWalletAddress("0x123")).toBe(false);
    expect(isValidWalletAddress("not-an-address")).toBe(false);
    expect(isValidWalletAddress(LOWER.slice(0, -1))).toBe(false); // 39 hex chars
    expect(isValidWalletAddress(undefined)).toBe(false);
    expect(isValidWalletAddress(123)).toBe(false);
  });

  it("rejects a mixed-case address with an invalid EIP-55 checksum", () => {
    // Flip one letter's case in the valid checksum -> guaranteed bad checksum.
    const badChecksum = CHECKSUM.replace("A", "a");
    expect(badChecksum).not.toBe(CHECKSUM);
    expect(isValidWalletAddress(badChecksum)).toBe(false);
  });

  it("normalizes to lowercase (canonical form, not EIP-55 checksum)", () => {
    expect(normalizeWalletAddress(CHECKSUM)).toBe(LOWER);
    expect(normalizeWalletAddress(LOWER)).toBe(LOWER);
  });
});
