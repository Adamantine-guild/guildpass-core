import { randomBytes } from "node:crypto";

export type NonceStatus = "valid" | "consumed" | "expired" | "unknown";

export interface NonceRecord {
  nonce: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
  consumedAt?: number;
}

export interface IssueOptions {
  ttlMs?: number;
  now?: number;
}

export interface ValidateResult {
  status: NonceStatus;
}

export interface ConsumeResult {
  status: NonceStatus;
}

export interface NonceManagerOptions {
  defaultTtlMs?: number;
  nonceByteLength?: number;
  maxRecords?: number;
  now?: () => number;
}

export class NonceManager {
  private readonly defaultTtlMs: number;
  private readonly nonceByteLength: number;
  private readonly maxRecords: number;
  private readonly now: () => number;
  private readonly records = new Map<string, NonceRecord>();

  constructor(options: NonceManagerOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? 300000; // 5 minutes default
    this.nonceByteLength = options.nonceByteLength ?? 32; // 256 bits of entropy
    this.maxRecords = options.maxRecords ?? 10000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Generate a cryptographically secure random nonce
   */
  private generateNonce(): string {
    const bytes = randomBytes(this.nonceByteLength);
    return bytes.toString("base64url");
  }

  /**
   * Issue a new nonce with optional TTL
   */
  issue(options: IssueOptions = {}): string {
    const { ttlMs = this.defaultTtlMs, now = this.now() } = options;
    
    // Enforce max records limit by cleaning expired records first
    this.cleanupExpired(now);
    
    // If still at capacity, remove oldest record
    if (this.records.size >= this.maxRecords) {
      this.removeOldestRecord();
    }

    const nonce = this.generateNonce();
    const expiresAt = now + ttlMs;

    this.records.set(nonce, {
      nonce,
      createdAt: now,
      expiresAt,
      consumed: false,
    });

    return nonce;
  }

  /**
   * Validate a nonce without consuming it
   */
  validate(nonce: string, now = this.now()): ValidateResult {
    const record = this.records.get(nonce);

    if (!record) {
      return { status: "unknown" };
    }

    if (record.expiresAt <= now) {
      // Clean up expired record
      this.records.delete(nonce);
      return { status: "expired" };
    }

    if (record.consumed) {
      return { status: "consumed" };
    }

    return { status: "valid" };
  }

  /**
   * Consume a nonce atomically - can only be consumed once
   */
  consume(nonce: string, now = this.now()): ConsumeResult {
    const record = this.records.get(nonce);

    if (!record) {
      return { status: "unknown" };
    }

    if (record.expiresAt <= now) {
      // Clean up expired record
      this.records.delete(nonce);
      return { status: "expired" };
    }

    if (record.consumed) {
      return { status: "consumed" };
    }

    // Atomic consume operation
    record.consumed = true;
    record.consumedAt = now;

    return { status: "valid" };
  }

  /**
   * Clean up expired records
   */
  private cleanupExpired(now: number): number {
    let count = 0;
    for (const [nonce, record] of this.records.entries()) {
      if (record.expiresAt <= now) {
        this.records.delete(nonce);
        count++;
      }
    }
    return count;
  }

  /**
   * Remove the oldest record to enforce memory constraints
   */
  private removeOldestRecord(): void {
    let oldestNonce: string | null = null;
    let oldestCreatedAt = Infinity;

    for (const [nonce, record] of this.records.entries()) {
      if (record.createdAt < oldestCreatedAt) {
        oldestCreatedAt = record.createdAt;
        oldestNonce = nonce;
      }
    }

    if (oldestNonce) {
      this.records.delete(oldestNonce);
    }
  }

  /**
   * Get current record count (useful for monitoring)
   */
  getRecordCount(): number {
    return this.records.size;
  }

  /**
   * Manually trigger cleanup of expired records
   */
  clearExpired(now = this.now()): number {
    return this.cleanupExpired(now);
  }
}
