/** The largest memo text payload permitted by Stellar, measured in UTF-8 bytes. */
export const STELLAR_MEMO_TEXT_MAX_BYTES = 28;
/** The exact byte length of Stellar hash and return-hash memo payloads. */
export const STELLAR_MEMO_HASH_BYTES = 32;
/** The largest unsigned 64-bit memo ID permitted by Stellar. */
export const STELLAR_MEMO_ID_MAX = 18_446_744_073_709_551_615n;

export type StellarMemo =
  | { type: "none" }
  | { type: "text"; value: string }
  | { type: "id"; value: bigint }
  | { type: "hash"; value: Uint8Array }
  | { type: "return"; value: Uint8Array };

/**
 * Structured inputs accepted by {@link parseMemo}. Hash byte arrays are copied
 * so a parsed memo cannot be changed by mutating the caller's array.
 */
export type StellarMemoInput = StellarMemo;

export class InvalidStellarMemoError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStellarMemoError";
  }
}

const encoder = new TextEncoder();
const HEX = /^[0-9a-f]{64}$/;
const ID = /^(?:0|[1-9][0-9]*)$/;

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validateText(value: unknown): string {
  if (typeof value !== "string") {
    throw new InvalidStellarMemoError("Text memo value must be a string");
  }
  if (hasUnpairedSurrogate(value)) {
    throw new InvalidStellarMemoError("Text memo value must contain valid Unicode scalar values");
  }
  const length = encoder.encode(value).byteLength;
  if (length > STELLAR_MEMO_TEXT_MAX_BYTES) {
    throw new InvalidStellarMemoError(
      `Text memo value must be at most ${STELLAR_MEMO_TEXT_MAX_BYTES} UTF-8 bytes; received ${length}`
    );
  }
  return value;
}

function validateId(value: unknown): bigint {
  if (typeof value !== "bigint") {
    throw new InvalidStellarMemoError("ID memo value must be a bigint");
  }
  if (value < 0n || value > STELLAR_MEMO_ID_MAX) {
    throw new InvalidStellarMemoError(`ID memo value must be between 0 and ${STELLAR_MEMO_ID_MAX}`);
  }
  return value;
}

function validateHash(value: unknown, memoType: "hash" | "return"): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new InvalidStellarMemoError(`${memoType} memo value must be a Uint8Array`);
  }
  if (value.byteLength !== STELLAR_MEMO_HASH_BYTES) {
    throw new InvalidStellarMemoError(
      `${memoType} memo value must be exactly ${STELLAR_MEMO_HASH_BYTES} bytes; received ${value.byteLength}`
    );
  }
  return new Uint8Array(value);
}

function decodeHex(value: string, memoType: "hash" | "return"): Uint8Array {
  if (!HEX.test(value)) {
    throw new InvalidStellarMemoError(
      `${memoType} memo must be exactly ${STELLAR_MEMO_HASH_BYTES * 2} lowercase hexadecimal characters`
    );
  }
  const bytes = new Uint8Array(STELLAR_MEMO_HASH_BYTES);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function encodeHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseStringMemo(input: string): StellarMemo {
  if (input === "none") return { type: "none" };

  const separator = input.indexOf(":");
  if (separator < 1) {
    throw new InvalidStellarMemoError("Memo string must use a supported canonical representation");
  }
  const type = input.slice(0, separator);
  const value = input.slice(separator + 1);

  switch (type) {
    case "text":
      return { type: "text", value: validateText(value) };
    case "id":
      if (!ID.test(value)) {
        throw new InvalidStellarMemoError("ID memo must be an unsigned canonical decimal integer");
      }
      return { type: "id", value: validateId(BigInt(value)) };
    case "hash":
      return { type: "hash", value: decodeHex(value, "hash") };
    case "return":
      return { type: "return", value: decodeHex(value, "return") };
    default:
      throw new InvalidStellarMemoError(`Unsupported Stellar memo type: ${type}`);
  }
}

function parseStructuredMemo(input: StellarMemoInput): StellarMemo {
  switch (input.type) {
    case "none":
      return { type: "none" };
    case "text":
      return { type: "text", value: validateText(input.value) };
    case "id":
      return { type: "id", value: validateId(input.value) };
    case "hash":
      return { type: "hash", value: validateHash(input.value, "hash") };
    case "return":
      return { type: "return", value: validateHash(input.value, "return") };
    default:
      throw new InvalidStellarMemoError("Unsupported Stellar memo type");
  }
}

/** Parses a canonical string or structured memo input into a validated memo. */
export function parseMemo(input: string | StellarMemoInput): StellarMemo {
  if (typeof input === "string") return parseStringMemo(input);
  if (input === null || typeof input !== "object") {
    throw new InvalidStellarMemoError("Memo input must be a string or structured memo object");
  }
  return parseStructuredMemo(input);
}

/** Formats a validated structured memo as its unique canonical string representation. */
export function formatMemo(memo: StellarMemo): string {
  const validated = parseMemo(memo);
  switch (validated.type) {
    case "none": return "none";
    case "text": return `text:${validated.value}`;
    case "id": return `id:${validated.value.toString()}`;
    case "hash": return `hash:${encodeHex(validated.value)}`;
    case "return": return `return:${encodeHex(validated.value)}`;
  }
}
