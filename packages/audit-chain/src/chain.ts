/**
 * Tamper-evident audit event hash chain.
 *
 * Each event's fingerprint incorporates the previous event's fingerprint, so
 * altering, removing or reordering any earlier event changes every fingerprint
 * after it. Verification therefore detects unexpected mutation.
 *
 * What this does NOT do: it cannot prevent a writer who controls the whole
 * store from deleting the tail and recomputing the chain. Detecting that needs
 * an external anchor (a published root, a counter-signature). This module is
 * only the primitive; it has no storage, database or framework dependency.
 */

import { createHash } from "node:crypto";

import { canonicalize } from "./canonical.js";

/** Hash algorithm and encoding are pinned: changing either changes every fingerprint. */
const HASH_ALGORITHM = "sha256";

/**
 * Anchor for the first link. A fixed, all-zero digest distinguishes "start of
 * chain" from "previous fingerprint omitted", so a chain cannot be silently
 * re-rooted at a later event.
 */
export const GENESIS_HASH = "0".repeat(64);

/** Version tag mixed into every digest, so a future format change cannot collide with this one. */
const DOMAIN = "guildpass.audit-chain.v1";

/** The minimum an event must carry to be chained. */
export interface AuditEventEnvelope {
  /** Unique identifier for this event. */
  id: string;
  /** Monotonically increasing position in the chain, starting at 0. */
  sequence: number;
  /** ISO-8601 timestamp of when the event occurred. */
  timestamp: string;
  /** Event body. Any JSON-representable value; canonicalized before hashing. */
  payload: unknown;
}

/** An envelope with its computed fingerprint and the fingerprint it chains from. */
export interface ChainedAuditEvent extends AuditEventEnvelope {
  /** Fingerprint of the preceding event, or GENESIS_HASH for the first. */
  previousHash: string;
  /** Fingerprint of this event, covering `previousHash` and the envelope. */
  hash: string;
}

/** Why a chain failed verification. */
export type ChainBreakReason =
  | "HASH_MISMATCH"
  | "PREVIOUS_HASH_MISMATCH"
  | "GENESIS_MISMATCH"
  | "SEQUENCE_MISMATCH";

export type VerifyChainResult =
  | { valid: true }
  /**
   * `index` is the first position where the chain stops being consistent —
   * enough to locate the tampering, not merely detect it.
   */
  | { valid: false; index: number; reason: ChainBreakReason; detail: string };

/**
 * Field-separated preimage.
 *
 * Every part is length-prefixed so no combination of field values can produce
 * the same byte string as a different combination — without this, an id ending
 * in a digit and a sequence starting with one could be ambiguous.
 */
function preimage(previousHash: string, event: AuditEventEnvelope): string {
  const parts = [
    DOMAIN,
    previousHash,
    event.id,
    String(event.sequence),
    event.timestamp,
    canonicalize(event.payload),
  ];
  return parts.map((part) => `${part.length}:${part}`).join("|");
}

/**
 * Compute the fingerprint an event would have when chained onto `previousHash`.
 * Pure: the same inputs always yield the same digest.
 */
export function computeEventHash(previousHash: string, event: AuditEventEnvelope): string {
  return createHash(HASH_ALGORITHM).update(preimage(previousHash, event), "utf8").digest("hex");
}

/**
 * Chain a single event onto the given previous fingerprint.
 *
 * Pass `GENESIS_HASH` (the default) for the first event in a chain.
 */
export function linkEvent(
  event: AuditEventEnvelope,
  previousHash: string = GENESIS_HASH,
): ChainedAuditEvent {
  return {
    ...event,
    previousHash,
    hash: computeEventHash(previousHash, event),
  };
}

/**
 * Chain an ordered list of events, each onto the one before it.
 *
 * The input order is the chain order; this does not sort, because reordering
 * events is exactly the tampering the chain is meant to expose.
 */
export function buildChain(events: readonly AuditEventEnvelope[]): ChainedAuditEvent[] {
  const chained: ChainedAuditEvent[] = [];
  let previousHash = GENESIS_HASH;
  for (const event of events) {
    const link = linkEvent(event, previousHash);
    chained.push(link);
    previousHash = link.hash;
  }
  return chained;
}

/**
 * Verify a chain is internally consistent.
 *
 * Checks, in order, that the first event anchors to `GENESIS_HASH`, that each
 * event's `previousHash` matches the preceding fingerprint, that sequence
 * numbers increase by exactly one, and that each recorded `hash` matches a
 * recomputation of its contents.
 *
 * Returns the first index that fails rather than a bare boolean, so a caller
 * can report where the chain diverges.
 */
export function verifyChain(events: readonly ChainedAuditEvent[]): VerifyChainResult {
  let expectedPrevious = GENESIS_HASH;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;

    if (event.previousHash !== expectedPrevious) {
      // At index 0 this means the chain does not start at genesis — e.g. the
      // original head was removed and a later event now sits first.
      const reason: ChainBreakReason = index === 0 ? "GENESIS_MISMATCH" : "PREVIOUS_HASH_MISMATCH";
      return {
        valid: false,
        index,
        reason,
        detail: `expected previousHash ${expectedPrevious}, found ${event.previousHash}`,
      };
    }

    const expectedSequence = index === 0 ? events[0]!.sequence : events[index - 1]!.sequence + 1;
    if (event.sequence !== expectedSequence) {
      return {
        valid: false,
        index,
        reason: "SEQUENCE_MISMATCH",
        detail: `expected sequence ${expectedSequence}, found ${event.sequence}`,
      };
    }

    const recomputed = computeEventHash(event.previousHash, event);
    if (recomputed !== event.hash) {
      // The stored contents no longer produce the stored fingerprint: this
      // event's payload, id or timestamp was modified after it was chained.
      return {
        valid: false,
        index,
        reason: "HASH_MISMATCH",
        detail: `recomputed ${recomputed}, recorded ${event.hash}`,
      };
    }

    expectedPrevious = event.hash;
  }

  return { valid: true };
}
