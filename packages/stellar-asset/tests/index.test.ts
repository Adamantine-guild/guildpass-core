import { describe, it, expect } from "vitest";
import { parseAsset, formatAsset, isValidStellarAddress } from "../src/index.js";

const VALID_ISSUER = "GBZD7RKC3WZL2VOFJC3ZVE5FE46VHEAGT4U6VEFBR6LVOWKVMPMP6TRD";
const INVALID_ISSUER_CHECKSUM = "GBZD7RKC3WZL2VOFJC3ZVE5FE46VHEAGT4U6VEFBR6LVOWKVMPMP6TRE"; // Altered last char

describe("isValidStellarAddress", () => {
  it("validates a correct address", () => {
    expect(isValidStellarAddress(VALID_ISSUER)).toBe(true);
  });
  it("rejects an address with invalid checksum", () => {
    expect(isValidStellarAddress(INVALID_ISSUER_CHECKSUM)).toBe(false);
  });
  it("rejects addresses with invalid prefix", () => {
    expect(isValidStellarAddress("MBZD7RKC3WZL2VOFJC3ZVE5FE46VHEAGT4U6VEFBR6LVOWKVMPMP6TRD")).toBe(false);
  });
  it("rejects addresses with invalid length", () => {
    expect(isValidStellarAddress(VALID_ISSUER.slice(0, -1))).toBe(false);
  });
});

describe("parseAsset", () => {
  it("parses native assets", () => {
    expect(parseAsset("native")).toEqual({ type: "native" });
    expect(parseAsset("XLM")).toEqual({ type: "native" });
  });

  it("parses valid credit assets", () => {
    expect(parseAsset(`USD:${VALID_ISSUER}`)).toEqual({
      type: "credit",
      code: "USD",
      issuer: VALID_ISSUER
    });
  });

  it("rejects missing code or issuer", () => {
    expect(() => parseAsset(`:${VALID_ISSUER}`)).toThrow();
    expect(() => parseAsset("USD:")).toThrow();
  });

  it("rejects malformed separators", () => {
    expect(() => parseAsset(`USD-${VALID_ISSUER}`)).toThrow();
    expect(() => parseAsset(`USD::${VALID_ISSUER}`)).toThrow();
  });

  it("rejects invalid code lengths", () => {
    expect(() => parseAsset(`TOOLONGASSET1:${VALID_ISSUER}`)).toThrow();
  });

  it("rejects invalid code characters", () => {
    expect(() => parseAsset(`US-D:${VALID_ISSUER}`)).toThrow();
  });

  it("rejects invalid issuer", () => {
    expect(() => parseAsset(`USD:${INVALID_ISSUER_CHECKSUM}`)).toThrow();
  });
});

describe("formatAsset", () => {
  it("formats native asset", () => {
    expect(formatAsset({ type: "native" })).toBe("native");
  });

  it("formats credit asset", () => {
    expect(formatAsset({ type: "credit", code: "USD", issuer: VALID_ISSUER })).toBe(`USD:${VALID_ISSUER}`);
  });
});

describe("round-trip", () => {
  it("round-trips correctly", () => {
    const assetStr = `USDC:${VALID_ISSUER}`;
    expect(formatAsset(parseAsset(assetStr))).toBe(assetStr);
    
    expect(formatAsset(parseAsset("native"))).toBe("native");
    expect(formatAsset(parseAsset("XLM"))).toBe("native"); // canonicalizes
  });
});
