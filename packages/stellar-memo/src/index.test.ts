import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatMemo,
  InvalidStellarMemoError,
  parseMemo,
  STELLAR_MEMO_ID_MAX,
} from "./index.js";

const hashHex = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

describe("Stellar memo parsing", () => {
  it("parses every supported canonical string representation", () => {
    assert.deepEqual(parseMemo("none"), { type: "none" });
    assert.deepEqual(parseMemo("text:GuildPass"), { type: "text", value: "GuildPass" });
    assert.deepEqual(parseMemo("id:18446744073709551615"), { type: "id", value: STELLAR_MEMO_ID_MAX });
    assert.deepEqual(parseMemo(`hash:${hashHex}`), { type: "hash", value: Uint8Array.from({ length: 32 }, (_, i) => i) });
    assert.deepEqual(parseMemo(`return:${hashHex}`), { type: "return", value: Uint8Array.from({ length: 32 }, (_, i) => i) });
  });

  it("uses UTF-8 byte length rather than JavaScript character length", () => {
    const boundary = "\u{1F600}".repeat(7);
    assert.equal(boundary.length, 14);
    assert.deepEqual(parseMemo(`text:${boundary}`), { type: "text", value: boundary });
    assert.throws(() => parseMemo(`text:${boundary}a`), InvalidStellarMemoError);
    assert.throws(() => parseMemo(`text:${"\u{1F600}".repeat(8)}`), InvalidStellarMemoError);
    assert.throws(() => parseMemo("text:\ud800"), InvalidStellarMemoError);
  });

  it("preserves IDs as bigint and rejects unsafe or out-of-range forms", () => {
    const parsed = parseMemo("id:9007199254740993");
    assert.equal(parsed.type, "id");
    if (parsed.type === "id") assert.equal(parsed.value, 9_007_199_254_740_993n);
    for (const value of ["id:-1", "id:18446744073709551616", "id:01", "id:+1", "id:1.0", "id:1e3"]) {
      assert.throws(() => parseMemo(value), InvalidStellarMemoError);
    }
    assert.throws(() => parseMemo({ type: "id", value: 1 as unknown as bigint }), InvalidStellarMemoError);
  });

  it("rejects malformed hash encodings and incorrect structured hash lengths", () => {
    for (const value of ["00", hashHex.toUpperCase(), `${hashHex}00`, `${hashHex.slice(0, -1)}g`]) {
      assert.throws(() => parseMemo(`hash:${value}`), InvalidStellarMemoError);
      assert.throws(() => parseMemo(`return:${value}`), InvalidStellarMemoError);
    }
    assert.throws(() => parseMemo({ type: "hash", value: new Uint8Array(31) }), InvalidStellarMemoError);
    assert.throws(() => parseMemo({ type: "return", value: new Uint8Array(33) }), InvalidStellarMemoError);
  });
});

describe("Stellar memo formatting", () => {
  it("round-trips all supported memo types through their canonical representation", () => {
    const memos = [
      "none",
      "text:Résumé 😀",
      "id:0",
      "id:18446744073709551615",
      `hash:${hashHex}`,
      `return:${hashHex}`,
    ];
    for (const input of memos) {
      assert.equal(formatMemo(parseMemo(input)), input);
    }
  });

  it("copies structured hash input before returning it", () => {
    const source = new Uint8Array(32);
    const memo = parseMemo({ type: "hash", value: source });
    source[0] = 255;
    assert.equal(formatMemo(memo), `hash:${"00".repeat(32)}`);
  });
});
