import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GENESIS_HASH,
  buildChain,
  computeEventHash,
  linkEvent,
  verifyChain,
  type AuditEventEnvelope,
  type ChainedAuditEvent,
} from "./chain.js";

function event(sequence: number, payload: unknown = { action: "grant" }): AuditEventEnvelope {
  return {
    id: `evt-${sequence}`,
    sequence,
    timestamp: `2026-01-0${sequence + 1}T00:00:00.000Z`,
    payload,
  };
}

const sample = (count = 4) => buildChain(Array.from({ length: count }, (_, i) => event(i)));

describe("linkEvent / buildChain", () => {
  it("anchors the first event to the genesis hash", () => {
    const [first] = sample(1);
    assert.equal(first!.previousHash, GENESIS_HASH);
    assert.match(first!.hash, /^[0-9a-f]{64}$/);
  });

  it("chains each event onto the previous fingerprint", () => {
    const chain = sample(3);
    assert.equal(chain[1]!.previousHash, chain[0]!.hash);
    assert.equal(chain[2]!.previousHash, chain[1]!.hash);
  });

  it("is deterministic — the same events always produce the same fingerprints", () => {
    assert.deepEqual(
      sample(3).map((e) => e.hash),
      sample(3).map((e) => e.hash),
    );
  });

  it("gives different fingerprints to identical payloads at different positions", () => {
    // Same payload, but the chain position differs, so the digests must differ.
    const a = linkEvent(event(0), GENESIS_HASH);
    const b = linkEvent(event(0), "a".repeat(64));
    assert.notEqual(a.hash, b.hash);
  });

  it("separates fields so contents cannot be shifted between them", () => {
    // Without length-prefixed framing, moving a character from `id` into
    // `timestamp` could produce the same preimage. It must not.
    const shifted = computeEventHash(GENESIS_HASH, {
      id: "evt-",
      sequence: 0,
      timestamp: "12026-01-01T00:00:00.000Z",
      payload: {},
    });
    const original = computeEventHash(GENESIS_HASH, {
      id: "evt-1",
      sequence: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: {},
    });
    assert.notEqual(shifted, original);
  });
});

describe("verifyChain — accepts sound chains", () => {
  it("accepts a freshly built chain", () => {
    assert.deepEqual(verifyChain(sample(5)), { valid: true });
  });

  it("accepts an empty chain", () => {
    assert.deepEqual(verifyChain([]), { valid: true });
  });

  it("accepts a single-event chain", () => {
    assert.deepEqual(verifyChain(sample(1)), { valid: true });
  });
});

describe("verifyChain — detects tampering", () => {
  it("detects a mutated payload and reports the exact index", () => {
    const chain = sample(5);
    // Edit event 2's payload in place, leaving its stored hash untouched.
    chain[2] = { ...chain[2]!, payload: { action: "revoke" } };

    const result = verifyChain(chain);
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.index, 2);
    assert.equal(result.valid === false && result.reason, "HASH_MISMATCH");
  });

  it("detects a mutated timestamp", () => {
    const chain = sample(4);
    chain[1] = { ...chain[1]!, timestamp: "2030-01-01T00:00:00.000Z" };

    const result = verifyChain(chain);
    assert.equal(result.valid === false && result.reason, "HASH_MISMATCH");
    assert.equal(result.valid === false && result.index, 1);
  });

  it("detects a deleted link", () => {
    const chain = sample(5);
    chain.splice(2, 1); // remove event 2; event 3 now follows event 1

    const result = verifyChain(chain);
    assert.equal(result.valid, false);
    // The break surfaces at the position the removed event used to occupy.
    assert.equal(result.valid === false && result.index, 2);
  });

  it("detects a reordered pair", () => {
    const chain = sample(5);
    const [a, b] = [chain[2]!, chain[3]!];
    chain[2] = b;
    chain[3] = a;

    const result = verifyChain(chain);
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.index, 2);
  });

  it("detects a removed head — the chain no longer starts at genesis", () => {
    const chain = sample(4);
    chain.shift();

    const result = verifyChain(chain);
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.index, 0);
    assert.equal(result.valid === false && result.reason, "GENESIS_MISMATCH");
  });

  it("detects a forged previousHash", () => {
    const chain = sample(4);
    chain[2] = { ...chain[2]!, previousHash: "f".repeat(64) };

    const result = verifyChain(chain);
    assert.equal(result.valid === false && result.reason, "PREVIOUS_HASH_MISMATCH");
    assert.equal(result.valid === false && result.index, 2);
  });

  it("detects a sequence gap even when hashes were recomputed", () => {
    // A tamperer with write access can rebuild fingerprints; the sequence
    // numbers still reveal that an event was dropped.
    const rebuilt = buildChain([event(0), event(1), event(3)]) as ChainedAuditEvent[];

    const result = verifyChain(rebuilt);
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.reason, "SEQUENCE_MISMATCH");
    assert.equal(result.valid === false && result.index, 2);
  });

  it("accepts a truncated tail, and says so — the documented limitation", () => {
    // Removing trailing events leaves a chain that is internally consistent.
    // Detecting this needs an external anchor, which is out of scope here.
    const truncated = sample(5).slice(0, 3);
    assert.deepEqual(verifyChain(truncated), { valid: true });
  });
});
