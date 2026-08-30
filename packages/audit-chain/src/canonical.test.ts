import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NonCanonicalizableValueError, canonicalize } from "./canonical.js";
import { GENESIS_HASH, computeEventHash } from "./chain.js";

describe("canonicalize — determinism", () => {
  it("is independent of key insertion order at every depth", () => {
    const a = { b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } };
    const b = { a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 };
    assert.equal(canonicalize(a), canonicalize(b));
  });

  it("is independent of source whitespace", () => {
    const a = JSON.parse('{"x":1,"y":[2,3]}');
    const b = JSON.parse('{\n  "y": [ 2, 3 ],\n  "x": 1\n}');
    assert.equal(canonicalize(a), canonicalize(b));
  });

  it("preserves array order, which is semantically meaningful", () => {
    assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
  });

  it("treats an omitted key and an explicit undefined as the same payload", () => {
    assert.equal(canonicalize({ a: 1 }), canonicalize({ a: 1, b: undefined }));
  });

  it("distinguishes null from undefined/absent", () => {
    assert.notEqual(canonicalize({ a: 1, b: null }), canonicalize({ a: 1 }));
  });

  it("does not conflate a number with its string form", () => {
    assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: "1" }));
  });

  it("normalizes -0 to 0", () => {
    assert.equal(canonicalize({ a: -0 }), canonicalize({ a: 0 }));
  });

  it("handles non-ASCII and escapes consistently", () => {
    assert.equal(canonicalize({ k: "café ✓" }), canonicalize({ k: "café ✓" }));
    assert.notEqual(canonicalize({ k: 'a"b' }), canonicalize({ k: "ab" }));
  });

  it("serializes dates by value", () => {
    const iso = "2026-01-01T00:00:00.000Z";
    assert.equal(canonicalize({ at: new Date(iso) }), canonicalize({ at: iso }));
  });
});

describe("canonicalize — rejects values it cannot represent faithfully", () => {
  it("rejects NaN and Infinity rather than silently emitting null", () => {
    assert.throws(() => canonicalize({ a: NaN }), NonCanonicalizableValueError);
    assert.throws(() => canonicalize({ a: Infinity }), NonCanonicalizableValueError);
  });

  it("rejects bigint, functions and symbols", () => {
    assert.throws(() => canonicalize({ a: 1n }), NonCanonicalizableValueError);
    assert.throws(() => canonicalize({ a: () => 1 }), NonCanonicalizableValueError);
    assert.throws(() => canonicalize({ a: Symbol("s") }), NonCanonicalizableValueError);
  });

  it("rejects circular references instead of overflowing the stack", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    assert.throws(() => canonicalize(cyclic), NonCanonicalizableValueError);
  });

  it("reports the path of the offending value", () => {
    try {
      canonicalize({ outer: { inner: [1, NaN] } });
      assert.fail("expected a NonCanonicalizableValueError");
    } catch (error) {
      assert.ok(error instanceof NonCanonicalizableValueError);
      assert.equal(error.path, "outer.inner[1]");
    }
  });
});

describe("canonicalization feeds the chain", () => {
  it("gives payloads that differ only by key order the same fingerprint", () => {
    const base = { id: "evt-0", sequence: 0, timestamp: "2026-01-01T00:00:00.000Z" };
    const one = computeEventHash(GENESIS_HASH, { ...base, payload: { b: 2, a: 1 } });
    const two = computeEventHash(GENESIS_HASH, { ...base, payload: { a: 1, b: 2 } });
    assert.equal(one, two);
  });

  it("changes the fingerprint when a nested value changes", () => {
    const base = { id: "evt-0", sequence: 0, timestamp: "2026-01-01T00:00:00.000Z" };
    const one = computeEventHash(GENESIS_HASH, { ...base, payload: { role: { id: 1 } } });
    const two = computeEventHash(GENESIS_HASH, { ...base, payload: { role: { id: 2 } } });
    assert.notEqual(one, two);
  });
});
