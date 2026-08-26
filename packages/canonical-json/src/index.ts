import { createHash } from "node:crypto";

/**
 * Custom Error thrown when an unsupported value type (e.g. undefined, Function, Symbol, BigInt, NaN, Infinity) is encountered.
 */
export class UnsupportedTypeError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedTypeError";
  }
}

/**
 * Custom Error thrown when a circular reference is detected in the input structure.
 */
export class CircularReferenceError extends Error {
  constructor(message = "Circular reference detected") {
    super(message);
    this.name = "CircularReferenceError";
  }
}

/**
 * Converts a supported JavaScript data structure into a deterministic, canonical JSON string representation.
 * - Object keys are sorted lexicographically in Unicode code point order.
 * - Array order is strictly preserved.
 * - Strings, booleans, null, and finite numbers are supported.
 * - Unsupported values (undefined, function, symbol, BigInt, NaN, Infinity) throw UnsupportedTypeError.
 * - Circular references throw CircularReferenceError.
 *
 * @param value The value to canonicalize
 * @returns Deterministic UTF-8 canonical JSON string
 */
export function canonicalize(value: unknown): string {
  const ancestorStack = new WeakSet<object>();

  function serialize(val: unknown): string {
    if (val === null) {
      return "null";
    }

    if (typeof val === "boolean") {
      return val ? "true" : "false";
    }

    if (typeof val === "string") {
      return JSON.stringify(val);
    }

    if (typeof val === "number") {
      if (!Number.isFinite(val)) {
        throw new UnsupportedTypeError(`Unsupported number value: ${val}`);
      }
      return JSON.stringify(val);
    }

    if (typeof val === "undefined") {
      throw new UnsupportedTypeError("Unsupported value type: undefined");
    }

    if (typeof val === "bigint") {
      throw new UnsupportedTypeError(`Unsupported value type: BigInt (${val.toString()})`);
    }

    if (typeof val === "symbol") {
      throw new UnsupportedTypeError(`Unsupported value type: Symbol (${val.toString()})`);
    }

    if (typeof val === "function") {
      throw new UnsupportedTypeError(`Unsupported value type: Function (${val.name || "anonymous"})`);
    }

    if (typeof val === "object") {
      if (ancestorStack.has(val)) {
        throw new CircularReferenceError("Circular reference detected");
      }

      ancestorStack.add(val);

      try {
        if (Array.isArray(val)) {
          const elements = val.map((item) => serialize(item));
          return `[${elements.join(",")}]`;
        }

        // Plain object - sort keys lexicographically
        const keys = Object.keys(val).sort();
        const entries: string[] = [];

        for (const key of keys) {
          const propertyVal = (val as Record<string, unknown>)[key];
          const serializedKey = JSON.stringify(key);
          const serializedVal = serialize(propertyVal);
          entries.push(`${serializedKey}:${serializedVal}`);
        }

        return `{${entries.join(",")}}`;
      } finally {
        ancestorStack.delete(val);
      }
    }

    throw new UnsupportedTypeError(`Unsupported value type: ${typeof val}`);
  }

  return serialize(value);
}

/**
 * Computes a cryptographic hash of the canonical JSON representation of a given value.
 *
 * @param value The value to canonicalize and hash
 * @param algorithm Cryptographic hash algorithm (default: 'sha256')
 * @returns Hexadecimal encoded hash string (lowercase)
 */
export function hashCanonicalJson(
  value: unknown,
  algorithm: string = "sha256"
): string {
  const canonicalString = canonicalize(value);
  return createHash(algorithm).update(canonicalString, "utf8").digest("hex");
}
