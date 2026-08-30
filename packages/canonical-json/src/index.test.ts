import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canonicalize,
  hashCanonicalJson,
  UnsupportedTypeError,
  CircularReferenceError,
} from "./index.js";

describe("Canonical JSON & Cryptographic Hashing Primitive", () => {
  it("recursively sorts object keys lexicographically regardless of insertion order", () => {
    const obj1 = { z: 10, a: { y: 20, b: 30 }, c: [3, 2, 1] };
    const obj2 = { a: { b: 30, y: 20 }, c: [3, 2, 1], z: 10 };

    const canonical1 = canonicalize(obj1);
    const canonical2 = canonicalize(obj2);

    assert.equal(canonical1, '{"a":{"b":30,"y":20},"c":[3,2,1],"z":10}');
    assert.equal(canonical1, canonical2);
  });

  it("produces identical SHA-256 hashes for semantically equivalent objects with different key orders", () => {
    const obj1 = { name: "GuildPass", version: 2, active: true };
    const obj2 = { active: true, version: 2, name: "GuildPass" };

    const hash1 = hashCanonicalJson(obj1);
    const hash2 = hashCanonicalJson(obj2);

    const expectedHash = createHash("sha256")
      .update('{"active":true,"name":"GuildPass","version":2}')
      .digest("hex");

    assert.equal(hash1, expectedHash);
    assert.equal(hash2, expectedHash);
  });

  it("preserves array order significance", () => {
    const arr1 = [1, 2, 3];
    const arr2 = [3, 2, 1];

    assert.equal(canonicalize(arr1), "[1,2,3]");
    assert.equal(canonicalize(arr2), "[3,2,1]");
    assert.notEqual(hashCanonicalJson(arr1), hashCanonicalJson(arr2));
  });

  it("correctly handles primitive data types (string, boolean, null, finite number)", () => {
    assert.equal(canonicalize("hello world"), '"hello world"');
    assert.equal(canonicalize(true), "true");
    assert.equal(canonicalize(false), "false");
    assert.equal(canonicalize(null), "null");
    assert.equal(canonicalize(42), "42");
    assert.equal(canonicalize(-3.14), "-3.14");
  });

  it("throws UnsupportedTypeError for unsupported numbers (NaN, Infinity)", () => {
    assert.throws(
      () => canonicalize(NaN),
      (err: any) => err instanceof UnsupportedTypeError && err.message.includes("NaN")
    );
    assert.throws(
      () => canonicalize(Infinity),
      (err: any) => err instanceof UnsupportedTypeError && err.message.includes("Infinity")
    );
    assert.throws(
      () => canonicalize(-Infinity),
      (err: any) => err instanceof UnsupportedTypeError && err.message.includes("-Infinity")
    );
  });

  it("throws UnsupportedTypeError for undefined, BigInt, Symbol, and Function values", () => {
    assert.throws(
      () => canonicalize({ key: undefined }),
      (err: any) => err instanceof UnsupportedTypeError && err.message.includes("undefined")
    );
    assert.throws(
      () => canonicalize({ key: 100n }),
      (err: any) => err instanceof UnsupportedTypeError && err.message.includes("BigInt")
    );
    assert.throws(
      () => canonicalize({ key: Symbol("test") }),
      (err: any) => err instanceof UnsupportedTypeError && err.message.includes("Symbol")
    );
    assert.throws(
      () => canonicalize({ key: () => {} }),
      (err: any) => err instanceof UnsupportedTypeError && err.message.includes("Function")
    );
  });

  it("prevents silent omission or conversion of unsupported values in arrays", () => {
    assert.throws(
      () => canonicalize([1, undefined, 3]),
      (err: any) => err instanceof UnsupportedTypeError
    );
    assert.throws(
      () => canonicalize([1, () => {}, 3]),
      (err: any) => err instanceof UnsupportedTypeError
    );
  });

  it("detects circular references and throws CircularReferenceError", () => {
    const circularObj: any = { a: 1 };
    circularObj.self = circularObj;

    assert.throws(
      () => canonicalize(circularObj),
      (err: any) => err instanceof CircularReferenceError
    );

    const circularArray: any = [1, 2];
    circularArray.push(circularArray);

    assert.throws(
      () => canonicalize(circularArray),
      (err: any) => err instanceof CircularReferenceError
    );
  });

  it("handles non-circular DAGs (shared references) without error", () => {
    const sharedChild = { value: "shared" };
    const dag = { left: sharedChild, right: sharedChild };

    const canonical = canonicalize(dag);
    assert.equal(canonical, '{"left":{"value":"shared"},"right":{"value":"shared"}}');
  });

  it("supports custom hash algorithms if specified", () => {
    const payload = { b: 2, a: 1 };
    const sha512Hash = hashCanonicalJson(payload, "sha512");
    const expectedSha512 = createHash("sha512")
      .update('{"a":1,"b":2}')
      .digest("hex");

    assert.equal(sha512Hash, expectedSha512);
  });
});
