import { describe, expect, it } from "vitest";
import {
  STELLAR_PUBLIC_NETWORK_PASSPHRASE,
  STELLAR_TESTNET_PASSPHRASE,
  parseStellarNetworkConfig,
} from "./index";

describe("parseStellarNetworkConfig", () => {
  it("maps the public passphrase to the public network", () => {
    const result = parseStellarNetworkConfig({
      passphrase: STELLAR_PUBLIC_NETWORK_PASSPHRASE,
      rpcUrl: "https://soroban-rpc.mainnet.stellar.org/#ignored",
      horizonUrl: "https://horizon.stellar.org/api///#ignored",
    });
    expect(result).toMatchObject({ valid: true, config: { network: "public" } });
    if (result.valid) {
      expect(result.config.rpcUrl.toString()).toBe("https://soroban-rpc.mainnet.stellar.org/");
      expect(result.config.horizonUrl?.toString()).toBe("https://horizon.stellar.org/api");
    }
  });

  it("maps the testnet passphrase deterministically without hostname inference", () => {
    const result = parseStellarNetworkConfig({
      passphrase: ` ${STELLAR_TESTNET_PASSPHRASE} `,
      rpcUrl: "https://example.invalid/rpc/",
    });
    expect(result).toMatchObject({ valid: true, config: { network: "testnet", passphrase: STELLAR_TESTNET_PASSPHRASE } });
  });

  it("supports an explicitly configured custom network", () => {
    const result = parseStellarNetworkConfig({
      network: "custom",
      passphrase: "My isolated Stellar network",
      rpcUrl: new URL("http://localhost:8000/soroban-rpc/"),
    });
    expect(result).toMatchObject({ valid: true, config: { network: "custom", passphrase: "My isolated Stellar network" } });
    if (result.valid) expect(result.config.rpcUrl.toString()).toBe("http://localhost:8000/soroban-rpc");
  });

  it("rejects unknown passphrases unless custom is explicit", () => {
    expect(parseStellarNetworkConfig({ passphrase: "private", rpcUrl: "https://rpc.example" })).toMatchObject({
      valid: false, code: "INVALID_PASSPHRASE", field: "passphrase",
    });
  });

  it("rejects conflicting known network identifiers and passphrases", () => {
    expect(parseStellarNetworkConfig({ network: "public", passphrase: STELLAR_TESTNET_PASSPHRASE, rpcUrl: "https://rpc.example" })).toMatchObject({
      valid: false, code: "NETWORK_PASSPHRASE_CONFLICT", field: "network",
    });
    expect(parseStellarNetworkConfig({ network: "custom", passphrase: STELLAR_PUBLIC_NETWORK_PASSPHRASE, rpcUrl: "https://rpc.example" })).toMatchObject({
      valid: false, code: "NETWORK_PASSPHRASE_CONFLICT",
    });
  });

  it.each([
    ["not a URL", "INVALID_URL"],
    ["ftp://rpc.example", "UNSUPPORTED_URL_PROTOCOL"],
    ["file:///tmp/rpc", "UNSUPPORTED_URL_PROTOCOL"],
    ["https://user:password@rpc.example", "URL_CREDENTIALS_NOT_ALLOWED"],
  ])("rejects invalid RPC URL %s", (rpcUrl, code) => {
    expect(parseStellarNetworkConfig({ passphrase: STELLAR_TESTNET_PASSPHRASE, rpcUrl })).toMatchObject({ valid: false, code, field: "rpcUrl" });
  });

  it("validates optional Horizon URLs and preserves query strings", () => {
    const valid = parseStellarNetworkConfig({
      passphrase: STELLAR_TESTNET_PASSPHRASE,
      rpcUrl: "https://rpc.example",
      horizonUrl: "https://horizon.example/api///?cursor=1#fragment",
    });
    expect(valid).toMatchObject({ valid: true });
    if (valid.valid) expect(valid.config.horizonUrl?.toString()).toBe("https://horizon.example/api?cursor=1");

    expect(parseStellarNetworkConfig({
      passphrase: STELLAR_TESTNET_PASSPHRASE, rpcUrl: "https://rpc.example", horizonUrl: "ssh://horizon.example",
    })).toMatchObject({ valid: false, code: "UNSUPPORTED_URL_PROTOCOL", field: "horizonUrl" });
  });

  it("returns structured errors for malformed input without I/O", () => {
    expect(parseStellarNetworkConfig(null)).toMatchObject({ valid: false, code: "INVALID_INPUT", field: "input" });
    expect(parseStellarNetworkConfig({ passphrase: "", rpcUrl: "https://rpc.example" })).toMatchObject({ valid: false, code: "INVALID_PASSPHRASE" });
    expect(parseStellarNetworkConfig({ passphrase: STELLAR_TESTNET_PASSPHRASE, rpcUrl: "https://rpc.example", horizonUrl: "https://token@horizon.example" })).toMatchObject({ valid: false, code: "URL_CREDENTIALS_NOT_ALLOWED", field: "horizonUrl" });
  });
});
