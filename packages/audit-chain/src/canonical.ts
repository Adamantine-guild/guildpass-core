/**
 * Canonical serialization for audit event payloads.
 *
 * A hash chain is only meaningful if the same logical event always produces the
 * same bytes. `JSON.stringify` does not guarantee that: object key order
 * follows insertion order, so two payloads that are deeply equal can serialize
 * differently and yield different fingerprints.
 *
 * This module produces a deterministic encoding:
 *  - object keys are sorted (by UTF-16 code unit, the JS default) at every depth;
 *  - array order is preserved, since order is semantically meaningful;
 *  - `undefined` object properties are omitted, mirroring `JSON.stringify`;
 *  - values JSON cannot represent faithfully are rejected rather than silently
 *    coerced, so a payload can never hash to something that misrepresents it.
 */

/** A value that can appear in an audit event payload. */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue | undefined };

/** Thrown when a payload contains something that cannot be canonicalized. */
export class NonCanonicalizableValueError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`cannot canonicalize value at ${path || "<root>"}: ${detail}`);
    this.name = "NonCanonicalizableValueError";
    this.path = path;
  }
}

function describe(value: unknown): string {
  if (typeof value === "number") return Number.isNaN(value) ? "NaN" : `non-finite number (${value})`;
  if (typeof value === "bigint") return "bigint is not representable in JSON";
  if (typeof value === "function") return "function";
  if (typeof value === "symbol") return "symbol";
  if (typeof value === "undefined") return "undefined";
  return `unsupported value of type ${typeof value}`;
}

function encode(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      // NaN/Infinity would become `null` under JSON.stringify — a silent change
      // of meaning, which a fingerprint must never do.
      if (!Number.isFinite(value)) throw new NonCanonicalizableValueError(path, describe(value));
      // -0 and 0 are the same value for audit purposes; normalize so they hash alike.
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case "object":
      break;
    default:
      throw new NonCanonicalizableValueError(path, describe(value));
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new NonCanonicalizableValueError(path, "circular reference");
  }
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      // Array order is meaningful and is preserved. Holes and `undefined`
      // entries become `null`, matching JSON.stringify.
      const items = object.map((item, index) =>
        item === undefined ? "null" : encode(item, `${path}[${index}]`, seen),
      );
      return `[${items.join(",")}]`;
    }

    if (object instanceof Date) {
      // Dates serialize by value, not by object identity.
      return JSON.stringify(object.toISOString());
    }

    const record = object as Record<string, unknown>;
    // Sorting is what makes the encoding independent of key insertion order.
    const keys = Object.keys(record).sort();
    const entries: string[] = [];
    for (const key of keys) {
      const child = record[key];
      // Omitted rather than encoded, mirroring JSON.stringify: `{a: undefined}`
      // and `{}` are the same payload and must hash identically.
      if (child === undefined) continue;
      entries.push(`${JSON.stringify(key)}:${encode(child, path ? `${path}.${key}` : key, seen)}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(object);
  }
}

/**
 * Deterministically encode a payload to a UTF-8 string.
 *
 * Two payloads that are deeply equal produce byte-identical output regardless
 * of key insertion order or whitespace in the original source.
 *
 * @throws {NonCanonicalizableValueError} for circular references, `NaN`,
 * `Infinity`, `bigint`, functions or symbols.
 */
export function canonicalize(payload: unknown): string {
  return encode(payload, "", new Set());
}
