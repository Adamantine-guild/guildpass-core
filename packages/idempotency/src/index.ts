import { canonicalize, hashCanonicalJson } from "@guildpass/canonical-json";

export type IdempotencyStatus = "processing" | "completed";

export interface IdempotencyRecord<T = unknown> {
  key: string;
  fingerprint: string;
  status: IdempotencyStatus;
  result?: T;
  createdAt: number;
  expiresAt?: number;
}

export interface AcquireParams {
  key: string;
  fingerprint: string;
  ttlMs?: number;
  now?: number;
}

export type AcquireResult<T = unknown> =
  | { type: "acquired" }
  | { type: "completed"; result: T }
  | { type: "in_flight" }
  | { type: "conflict" };

export interface IdempotencyStore {
  acquire<T = unknown>(params: AcquireParams): Promise<AcquireResult<T>>;
  complete<T = unknown>(
    key: string,
    fingerprint: string,
    result: T,
    ttlMs?: number,
    now?: number
  ): Promise<void>;
  release(key: string, fingerprint: string): Promise<void>;
  get<T = unknown>(key: string, now?: number): Promise<IdempotencyRecord<T> | null>;
  clearExpired(now?: number): Promise<number>;
}

export class InvalidIdempotencyKeyError extends Error {
  constructor(message = "Invalid idempotency key") {
    super(message);
    this.name = "InvalidIdempotencyKeyError";
  }
}

export class InvalidFingerprintError extends Error {
  constructor(message = "Invalid idempotency fingerprint") {
    super(message);
    this.name = "InvalidFingerprintError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor(message = "Idempotency key reused with a different request fingerprint") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private records = new Map<string, IdempotencyRecord<any>>();

  async acquire<T = unknown>(params: AcquireParams): Promise<AcquireResult<T>> {
    const { key, fingerprint, ttlMs, now = Date.now() } = params;

    const existing = this.records.get(key);

    if (existing) {
      if (existing.expiresAt && existing.expiresAt <= now) {
        this.records.delete(key);
      } else {
        if (existing.fingerprint !== fingerprint) {
          return { type: "conflict" };
        }
        if (existing.status === "completed") {
          return { type: "completed", result: existing.result as T };
        }
        return { type: "in_flight" };
      }
    }

    const expiresAt = ttlMs ? now + ttlMs : undefined;
    this.records.set(key, {
      key,
      fingerprint,
      status: "processing",
      createdAt: now,
      expiresAt,
    });

    return { type: "acquired" };
  }

  async complete<T = unknown>(
    key: string,
    fingerprint: string,
    result: T,
    ttlMs?: number,
    now = Date.now()
  ): Promise<void> {
    const existing = this.records.get(key);
    if (!existing || existing.fingerprint !== fingerprint) {
      return;
    }

    existing.status = "completed";
    existing.result = result;
    if (ttlMs) {
      existing.expiresAt = now + ttlMs;
    }
  }

  async release(key: string, fingerprint: string): Promise<void> {
    const existing = this.records.get(key);
    if (existing && existing.fingerprint === fingerprint && existing.status === "processing") {
      this.records.delete(key);
    }
  }

  async get<T = unknown>(key: string, now = Date.now()): Promise<IdempotencyRecord<T> | null> {
    const existing = this.records.get(key);
    if (!existing) return null;

    if (existing.expiresAt && existing.expiresAt <= now) {
      this.records.delete(key);
      return null;
    }

    return existing as IdempotencyRecord<T>;
  }

  async clearExpired(now = Date.now()): Promise<number> {
    let count = 0;
    for (const [key, record] of this.records.entries()) {
      if (record.expiresAt && record.expiresAt <= now) {
        this.records.delete(key);
        count++;
      }
    }
    return count;
  }
}

export type IdempotencyExecutionStatus = "executed" | "replayed" | "conflict" | "in_flight";

export type IdempotencyExecutionOutcome<T> =
  | { status: "executed"; result: T; replayed: false }
  | { status: "replayed"; result: T; replayed: true }
  | { status: "conflict"; reason: string }
  | { status: "in_flight"; reason: string };

export interface IdempotencyEngineOptions {
  store?: IdempotencyStore;
  defaultTtlMs?: number;
}

export interface ExecuteOptions<T> {
  key: string;
  fingerprint: string | object;
  fn: () => Promise<T>;
  ttlMs?: number;
  waitForInFlightMs?: number;
  now?: () => number;
}

export class IdempotencyEngine {
  private store: IdempotencyStore;
  private defaultTtlMs?: number;
  private inFlightPromises = new Map<string, Promise<any>>();

  constructor(options: IdempotencyEngineOptions = {}) {
    this.store = options.store || new InMemoryIdempotencyStore();
    this.defaultTtlMs = options.defaultTtlMs;
  }

  static generateFingerprint(payload: unknown): string {
    return hashCanonicalJson(payload);
  }

  async execute<T>(options: ExecuteOptions<T>): Promise<IdempotencyExecutionOutcome<T>> {
    const { key, fn, ttlMs = this.defaultTtlMs, waitForInFlightMs = 5000, now } = options;

    if (!key || typeof key !== "string" || key.trim().length === 0) {
      throw new InvalidIdempotencyKeyError("Idempotency key must be a non-empty string");
    }

    let fingerprintStr: string;
    if (typeof options.fingerprint === "string") {
      if (options.fingerprint.trim().length === 0) {
        throw new InvalidFingerprintError("Idempotency fingerprint must be a non-empty string");
      }
      fingerprintStr = options.fingerprint;
    } else if (typeof options.fingerprint === "object" && options.fingerprint !== null) {
      fingerprintStr = IdempotencyEngine.generateFingerprint(options.fingerprint);
    } else {
      throw new InvalidFingerprintError("Fingerprint must be a non-empty string or object payload");
    }

    const currentNow = now ? now() : Date.now();

    const acquireResult = await this.store.acquire<T>({
      key,
      fingerprint: fingerprintStr,
      ttlMs,
      now: currentNow,
    });

    if (acquireResult.type === "conflict") {
      return {
        status: "conflict",
        reason: "Idempotency key reused with a different request fingerprint",
      };
    }

    if (acquireResult.type === "completed") {
      return {
        status: "replayed",
        result: acquireResult.result,
        replayed: true,
      };
    }

    if (acquireResult.type === "acquired") {
      let deferredResolve!: (val: T) => void;
      let deferredReject!: (err: any) => void;

      const promise = new Promise<T>((res, rej) => {
        deferredResolve = res;
        deferredReject = rej;
      });
      // Attach no-op catch handler to suppress unhandled rejection if no secondary caller is waiting
      promise.catch(() => {});

      this.inFlightPromises.set(key, promise);

      try {
        const result = await fn();
        await this.store.complete(key, fingerprintStr, result, ttlMs, currentNow);
        deferredResolve(result);
        return {
          status: "executed",
          result,
          replayed: false,
        };
      } catch (error) {
        await this.store.release(key, fingerprintStr);
        deferredReject(error);
        throw error;
      } finally {
        this.inFlightPromises.delete(key);
      }
    }

    if (waitForInFlightMs > 0) {
      const existingPromise = this.inFlightPromises.get(key);
      if (existingPromise) {
        try {
          const inFlightResult = await existingPromise;
          return {
            status: "replayed",
            result: inFlightResult,
            replayed: true,
          };
        } catch {
          return this.execute({ ...options, waitForInFlightMs: 0 });
        }
      }
    }

    return {
      status: "in_flight",
      reason: "Operation is currently in flight",
    };
  }
}
