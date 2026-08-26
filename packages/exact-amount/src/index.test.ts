import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatAmount, InvalidAmountError, parseAmount } from "./index.js";

describe("exact amount parsing", () => {
  it("parses whole and fractional amounts", () => {
    assert.equal(parseAmount("12", 3), 12000n);
    assert.equal(parseAmount("12.345", 3), 12345n);
    assert.equal(parseAmount("0.5", 3), 500n);
  });

  it("handles leading and trailing zeros deterministically", () => {
    assert.equal(parseAmount("00012.3400", 4), 123400n);
    assert.equal(formatAmount(123400n, 4), "12.34");
    assert.equal(formatAmount(120000n, 4), "12");
  });

  it("defines signed amount semantics", () => {
    assert.equal(parseAmount("+1.25", 2), 125n);
    assert.equal(parseAmount("-1.25", 2), -125n);
    assert.equal(parseAmount("-0.00", 2), 0n);
    assert.equal(formatAmount(-125n, 2), "-1.25");
    assert.equal(formatAmount(0n, 2), "0");
  });

  it("supports values beyond Number's safe integer range", () => {
    const input = "123456789012345678901234567890.123456";
    const units = 123456789012345678901234567890123456n;
    assert.equal(parseAmount(input, 6), units);
    assert.equal(formatAmount(units, 6), input);
  });

  it("rejects excess precision instead of rounding implicitly", () => {
    assert.throws(
      () => parseAmount("1.234", 2),
      (error: unknown) =>
        error instanceof InvalidAmountError &&
        error.message.includes("maximum is 2")
    );
  });

  it("rejects malformed and ambiguous decimal strings", () => {
    for (const value of ["", "1.", ".5", "1.2.3", "1e3", " 1", "1 ", "--1", "NaN"]) {
      assert.throws(() => parseAmount(value, 2), InvalidAmountError);
    }
  });

  it("validates configured precision", () => {
    for (const decimals of [-1, 1.5, 256, Number.NaN]) {
      assert.throws(() => parseAmount("1", decimals), RangeError);
      assert.throws(() => formatAmount(1n, decimals), RangeError);
    }
  });
});

describe("exact amount formatting", () => {
  it("formats zero-decimal amounts", () => {
    assert.equal(formatAmount(42n, 0), "42");
    assert.equal(formatAmount(-42n, 0), "-42");
  });

  it("preserves leading fractional zeros", () => {
    assert.equal(formatAmount(5n, 3), "0.005");
    assert.equal(formatAmount(-5n, 3), "-0.005");
  });

  it("round-trips integer base-unit values", () => {
    const values = [0n, 1n, -1n, 10n, 1001n, -999999999999999999999n];
    for (const decimals of [0, 1, 2, 6, 18]) {
      for (const value of values) {
        assert.equal(parseAmount(formatAmount(value, decimals), decimals), value);
      }
    }
  });

  it("requires bigint values", () => {
    assert.throws(() => formatAmount(1 as unknown as bigint, 2), TypeError);
  });
});
