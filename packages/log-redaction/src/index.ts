export interface RedactionOptions {
  /**
   * Custom field names to redact (matched case-insensitively).
   */
  redactKeys?: string[];
  /**
   * Replacement text for redacted values. Defaults to '[REDACTED]'.
   */
  mask?: string;
  /**
   * Maximum recursion depth before stopping traversal. Defaults to 20.
   */
  maxDepth?: number;
}

/**
 * Default sensitive keys that must be redacted.
 */
export const DEFAULT_REDACT_KEYS: readonly string[] = [
  'authorization',
  'password',
  'secret',
  'token',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'seed',
  'seedphrase',
  'seed_phrase',
  'secretkey',
  'secret_key',
  'jwt',
  'bearer',
  'cookie',
  'credentials',
  'passphrase',
  'access_token',
  'refresh_token',
];

export const DEFAULT_MASK = '[REDACTED]';
export const DEFAULT_MAX_DEPTH = 20;

/**
 * Normalizes a property key for case-insensitive and delimiter-agnostic comparison.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/**
 * Deterministically and recursively redacts sensitive information from structured data.
 * Produces a sanitized deep copy without mutating the input.
 */
export function redact<T = unknown>(input: T, options?: RedactionOptions): T {
  const mask = options?.mask ?? DEFAULT_MASK;
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;

  const userKeys = options?.redactKeys ?? [];
  const sensitiveKeySet = new Set(
    [...DEFAULT_REDACT_KEYS, ...userKeys].map(normalizeKey)
  );

  const seen = new WeakSet<object>();

  function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === null || proto === Object.prototype;
  }

  function traverse(value: unknown, currentDepth: number): unknown {
    if (currentDepth >= maxDepth && value !== null && typeof value === 'object') {
      return '[MAX_DEPTH_EXCEEDED]';
    }

    // Primitives and functions/symbols
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'function' || typeof value === 'symbol') {
        return undefined;
      }
      return value;
    }

    // Circular reference handling
    if (seen.has(value)) {
      return '[CIRCULAR]';
    }

    // Date objects: preserve value as cloned Date
    if (value instanceof Date) {
      return new Date(value.getTime());
    }

    // RegExp objects
    if (value instanceof RegExp) {
      return new RegExp(value.source, value.flags);
    }

    // Error objects: preserve serializable error properties
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }

    // Arrays: traverse each element
    if (Array.isArray(value)) {
      seen.add(value);
      return value.map((item) => traverse(item, currentDepth + 1));
    }

    // Map objects
    if (value instanceof Map) {
      const clonedMap: Record<string, unknown> = {};
      seen.add(value);
      for (const [k, v] of value.entries()) {
        const keyStr = String(k);
        if (sensitiveKeySet.has(normalizeKey(keyStr))) {
          clonedMap[keyStr] = mask;
        } else {
          clonedMap[keyStr] = traverse(v, currentDepth + 1);
        }
      }
      return clonedMap;
    }

    // Set objects
    if (value instanceof Set) {
      seen.add(value);
      return Array.from(value).map((item) => traverse(item, currentDepth + 1));
    }

    if (!isPlainObject(value)) {
      seen.add(value);
      const copy: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        if (sensitiveKeySet.has(normalizeKey(key))) {
          copy[key] = mask;
        } else {
          copy[key] = traverse((value as Record<string, unknown>)[key], currentDepth + 1);
        }
      }
      return copy;
    }

    // Plain Objects
    seen.add(value);
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(value)) {
      if (sensitiveKeySet.has(normalizeKey(key))) {
        result[key] = mask;
      } else {
        result[key] = traverse((value as Record<string, unknown>)[key], currentDepth + 1);
      }
    }

    return result;
  }

  return traverse(input, 0) as T;
}
