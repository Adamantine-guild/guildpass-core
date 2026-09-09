export type DeduplicationResult =
  | { type: "first_seen"; shouldProcess: true }
  | { type: "duplicate"; shouldProcess: false }
  | { type: "error"; shouldProcess: false; reason: string };

export interface EventRecord {
  fingerprint: string;
  firstSeenAt: number;
  expiresAt: number;
}

export interface CheckAndRecordOptions {
  retentionMs?: number;
  now?: number;
}

export interface EventDeduplicationOptions {
  defaultRetentionMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class InvalidFingerprintError extends Error {
  constructor(message = "Invalid fingerprint") {
    super(message);
    this.name = "InvalidFingerprintError";
  }
}

export class EventDeduplicationEngine {
  private readonly defaultRetentionMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly records = new Map<string, EventRecord>();

  constructor(options: EventDeduplicationOptions = {}) {
    this.defaultRetentionMs = options.defaultRetentionMs ?? 300000; // 5 minutes default
    this.maxEntries = options.maxEntries ?? 10000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Validate fingerprint format
   */
  private validateFingerprint(fingerprint: string): void {
    if (!fingerprint || typeof fingerprint !== "string" || fingerprint.trim().length === 0) {
      throw new InvalidFingerprintError("Fingerprint must be a non-empty string");
    }
  }

  /**
   * Atomically check if event has been seen and record if new
   */
  checkAndRecord(fingerprint: string, options: CheckAndRecordOptions = {}): DeduplicationResult {
    try {
      this.validateFingerprint(fingerprint);
    } catch (error) {
      return {
        type: "error",
        shouldProcess: false,
        reason: error instanceof Error ? error.message : "Invalid fingerprint",
      };
    }

    const { retentionMs = this.defaultRetentionMs, now = this.now() } = options;

    // Clean up expired records first
    this.cleanupExpired(now);

    // Check if already exists
    const existing = this.records.get(fingerprint);
    if (existing) {
      if (existing.expiresAt <= now) {
        // Expired - remove and treat as new
        this.records.delete(fingerprint);
      } else {
        // Still valid - duplicate
        return { type: "duplicate", shouldProcess: false };
      }
    }

    // Enforce max entries limit
    if (this.records.size >= this.maxEntries) {
      this.evictOldest();
    }

    // Record new event
    this.records.set(fingerprint, {
      fingerprint,
      firstSeenAt: now,
      expiresAt: now + retentionMs,
    });

    return { type: "first_seen", shouldProcess: true };
  }

  /**
   * Check if event has been seen without recording
   */
  check(fingerprint: string, now = this.now()): DeduplicationResult {
    try {
      this.validateFingerprint(fingerprint);
    } catch (error) {
      return {
        type: "error",
        shouldProcess: false,
        reason: error instanceof Error ? error.message : "Invalid fingerprint",
      };
    }

    const existing = this.records.get(fingerprint);
    if (!existing) {
      return { type: "first_seen", shouldProcess: true };
    }

    if (existing.expiresAt <= now) {
      // Expired - treat as new
      return { type: "first_seen", shouldProcess: true };
    }

    // Still valid - duplicate
    return { type: "duplicate", shouldProcess: false };
  }

  /**
   * Clean up expired records
   */
  private cleanupExpired(now: number): number {
    let count = 0;
    for (const [fingerprint, record] of this.records.entries()) {
      if (record.expiresAt <= now) {
        this.records.delete(fingerprint);
        count++;
      }
    }
    return count;
  }

  /**
   * Evict oldest entry when capacity is reached
   * Uses FIFO eviction based on firstSeenAt timestamp
   */
  private evictOldest(): void {
    let oldestFingerprint: string | null = null;
    let oldestFirstSeenAt = Infinity;

    for (const [fingerprint, record] of this.records.entries()) {
      if (record.firstSeenAt < oldestFirstSeenAt) {
        oldestFirstSeenAt = record.firstSeenAt;
        oldestFingerprint = fingerprint;
      }
    }

    if (oldestFingerprint) {
      this.records.delete(oldestFingerprint);
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

  /**
   * Clear all records (useful for testing or reset scenarios)
   */
  clear(): void {
    this.records.clear();
  }
}
