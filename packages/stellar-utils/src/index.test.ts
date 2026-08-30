import { describe, it, expect } from "vitest";
import {
  validateStellarAddress,
  isStellarAddress,
  assertStellarAddress,
  InvalidStellarAddressError,
} from "./index";

// --- Local StrKey encoder, used only to build deterministic test fixtures.
// Mirrors the RFC4648 base32 + CRC16/XMODEM StrKey spec independently of
// src/index.ts so fixtures don't rely on a hard-coded, hand-copied address.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

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

function encodeBase32(bytes: Uint8Array): string {
  let bitBuffer = 0;
  let bitCount = 0;
  let output = "";
  for (const byte of bytes) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      output += BASE32_ALPHABET[(bitBuffer >>> bitCount) & 0x1f];
    }
  }
  if (bitCount > 0) {
    output += BASE32_ALPHABET[(bitBuffer << (5 - bitCount)) & 0x1f];
  }
  return output;
}

function encodeStrKey(versionByte: number, payload: Uint8Array): string {
  const versionAndPayload = Uint8Array.from([versionByte, ...payload]);
  const checksum = crc16xmodem(versionAndPayload);
  const full = Uint8Array.from([...versionAndPayload, checksum & 0xff, (checksum >> 8) & 0xff]);
  return encodeBase32(full);
}

const ACCOUNT_ID_VERSION_BYTE = 6 << 3; // 'G'
const SEED_VERSION_BYTE = 18 << 3; // 'S'

function samplePayload(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + seed) % 256);
}

const VALID_ADDRESS = encodeStrKey(ACCOUNT_ID_VERSION_BYTE, samplePayload(1));

describe("validateStellarAddress", () => {
  it("accepts a valid ed25519 public key (G...) address", () => {
    const result = validateStellarAddress(VALID_ADDRESS);
    expect(result).toEqual({ valid: true, address: VALID_ADDRESS });
    expect(VALID_ADDRESS.startsWith("G")).toBe(true);
    expect(VALID_ADDRESS).toHaveLength(56);
  });

  it("is deterministic across repeated calls", () => {
    const first = validateStellarAddress(VALID_ADDRESS);
    const second = validateStellarAddress(VALID_ADDRESS);
    expect(first).toEqual(second);
  });

  it("rejects an address with an invalid checksum", () => {
    // Flip one character in the payload region without recomputing the checksum.
    const corruptedChar = VALID_ADDRESS[10] === "A" ? "B" : "A";
    const corrupted = VALID_ADDRESS.slice(0, 10) + corruptedChar + VALID_ADDRESS.slice(11);

    const result = validateStellarAddress(corrupted);
    expect(result).toEqual({ valid: false, code: "INVALID_STRKEY" });
  });

  it("rejects a truncated address", () => {
    const truncated = VALID_ADDRESS.slice(0, -1);
    const result = validateStellarAddress(truncated);
    expect(result).toEqual({ valid: false, code: "INVALID_STRKEY" });
  });

  it("rejects an address with extra trailing characters", () => {
    const padded = `${VALID_ADDRESS}A`;
    const result = validateStellarAddress(padded);
    expect(result).toEqual({ valid: false, code: "INVALID_STRKEY" });
  });

  it("rejects random strings", () => {
    expect(validateStellarAddress("not-a-stellar-address")).toEqual({
      valid: false,
      code: "INVALID_STRKEY",
    });
    expect(validateStellarAddress("1234567890")).toEqual({
      valid: false,
      code: "INVALID_STRKEY",
    });
  });

  it("rejects lowercase / mixed-case input rather than normalising it", () => {
    const result = validateStellarAddress(VALID_ADDRESS.toLowerCase());
    expect(result).toEqual({ valid: false, code: "INVALID_STRKEY" });
  });

  it("rejects a prefix-only match with an unsupported StrKey type", () => {
    const seedAddress = encodeStrKey(SEED_VERSION_BYTE, samplePayload(2));
    expect(seedAddress.startsWith("S")).toBe(true);

    const result = validateStellarAddress(seedAddress);
    expect(result).toEqual({ valid: false, code: "UNSUPPORTED_ADDRESS_TYPE" });
  });

  it("rejects empty and whitespace-only input", () => {
    expect(validateStellarAddress("")).toEqual({ valid: false, code: "EMPTY_ADDRESS" });
    expect(validateStellarAddress("   ")).toEqual({ valid: false, code: "EMPTY_ADDRESS" });
  });

  it("trims surrounding whitespace but does not alter internal content", () => {
    const result = validateStellarAddress(`  ${VALID_ADDRESS}  \n`);
    expect(result).toEqual({ valid: true, address: VALID_ADDRESS });
  });

  it("never throws for ordinary invalid input, regardless of type", () => {
    const inputs: unknown[] = [null, undefined, 42, true, {}, [], Symbol("x"), () => {}, new Date()];
    for (const input of inputs) {
      expect(() => validateStellarAddress(input)).not.toThrow();
      const result = validateStellarAddress(input);
      expect(result.valid).toBe(false);
    }
  });
});

describe("isStellarAddress", () => {
  it("returns true only for valid addresses", () => {
    expect(isStellarAddress(VALID_ADDRESS)).toBe(true);
    expect(isStellarAddress("not-a-stellar-address")).toBe(false);
    expect(isStellarAddress(null)).toBe(false);
  });
});

describe("assertStellarAddress", () => {
  it("returns the normalised address on success", () => {
    expect(assertStellarAddress(`  ${VALID_ADDRESS}  `)).toBe(VALID_ADDRESS);
  });

  it("throws InvalidStellarAddressError with the failure code on invalid input", () => {
    expect(() => assertStellarAddress("garbage")).toThrow(InvalidStellarAddressError);
    try {
      assertStellarAddress("");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidStellarAddressError);
      expect((error as InvalidStellarAddressError).code).toBe("EMPTY_ADDRESS");
    }
  });
});
