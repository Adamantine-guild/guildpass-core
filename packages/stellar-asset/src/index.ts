/**
 * Canonical representation of a Stellar asset.
 */
export type StellarAsset =
  | { type: "native" }
  | {
      type: "credit";
      code: string;
      issuer: string;
    };

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(input: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor((input.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (let i = 0; i < input.length; i++) {
    const val = ALPHABET.indexOf(input[i]);
    if (val === -1) throw new Error("Invalid base32 char");
    value = (value << 5) | val;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (value >>> bits) & 0xff;
    }
  }
  return bytes.slice(0, index);
}

function crc16XModem(data: Uint8Array): number {
  let crc = 0x0000;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc = (crc << 1);
      }
    }
  }
  return crc & 0xFFFF;
}

/**
 * Validates a Stellar ed25519 public key (issuer address).
 */
export function isValidStellarAddress(address: string): boolean {
  if (!/^G[A-Z2-7]{55}$/.test(address)) {
    return false;
  }
  try {
    const decoded = decodeBase32(address);
    if (decoded.length !== 35) return false;
    // Version byte for account ID ('G' = 6 << 3 = 48)
    if (decoded[0] !== 48) return false;
    
    const payload = decoded.slice(0, 33);
    const expectedChecksum = decoded[33] | (decoded[34] << 8);
    const computedChecksum = crc16XModem(payload);
    
    return expectedChecksum === computedChecksum;
  } catch {
    return false;
  }
}

/**
 * Parses a Stellar asset string representation into a canonical form.
 * Canonical input form for native: "native" or "XLM".
 * Input form for credit: "CODE:ISSUER".
 */
export function parseAsset(assetStr: string): StellarAsset {
  if (assetStr === "native" || assetStr === "XLM") {
    return { type: "native" };
  }

  const parts = assetStr.split(":");
  if (parts.length !== 2) {
    throw new Error("Invalid asset string representation. Expected CODE:ISSUER");
  }

  const [code, issuer] = parts;

  if (code.length < 1 || code.length > 12) {
    throw new Error("Invalid asset code length. Must be 1-12 characters.");
  }
  if (!/^[a-zA-Z0-9]+$/.test(code)) {
    throw new Error("Invalid asset code characters. Must be alphanumeric.");
  }
  
  if (!isValidStellarAddress(issuer)) {
    throw new Error("Invalid issuer address.");
  }

  return { type: "credit", code, issuer };
}

/**
 * Formats a StellarAsset into a string representation.
 */
export function formatAsset(asset: StellarAsset): string {
  if (asset.type === "native") {
    return "native";
  }
  return `${asset.code}:${asset.issuer}`;
}
