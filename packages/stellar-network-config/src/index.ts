/**
 * Canonical, transport-free parsing for Stellar network settings.
 * This module never creates RPC clients or performs network requests.
 */

export const STELLAR_TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const STELLAR_PUBLIC_NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015";

export type StellarNetwork = "testnet" | "public" | "custom";

export interface StellarNetworkConfig {
  readonly network: StellarNetwork;
  readonly passphrase: string;
  readonly rpcUrl: URL;
  readonly horizonUrl?: URL;
}

export interface StellarNetworkConfigInput {
  readonly network?: StellarNetwork;
  readonly passphrase?: string;
  readonly rpcUrl: unknown;
  readonly horizonUrl?: unknown;
}

export type StellarNetworkConfigValidationErrorCode =
  | "INVALID_INPUT"
  | "INVALID_NETWORK"
  | "MISSING_PASSPHRASE"
  | "INVALID_PASSPHRASE"
  | "NETWORK_PASSPHRASE_CONFLICT"
  | "INVALID_URL"
  | "UNSUPPORTED_URL_PROTOCOL"
  | "URL_CREDENTIALS_NOT_ALLOWED";

export interface StellarNetworkConfigValidationError {
  readonly valid: false;
  readonly code: StellarNetworkConfigValidationErrorCode;
  readonly field: "network" | "passphrase" | "rpcUrl" | "horizonUrl" | "input";
  readonly message: string;
}

export interface ValidStellarNetworkConfig {
  readonly valid: true;
  readonly config: StellarNetworkConfig;
}

export type StellarNetworkConfigParseResult =
  | ValidStellarNetworkConfig
  | StellarNetworkConfigValidationError;

const KNOWN_NETWORKS: ReadonlyMap<string, Exclude<StellarNetwork, "custom">> = new Map([
  [STELLAR_TESTNET_PASSPHRASE, "testnet"],
  [STELLAR_PUBLIC_NETWORK_PASSPHRASE, "public"],
]);
const ALLOWED_PROTOCOLS = new Set(["https:", "http:"]);

function error(
  code: StellarNetworkConfigValidationErrorCode,
  field: StellarNetworkConfigValidationError["field"],
  message: string,
): StellarNetworkConfigValidationError {
  return { valid: false, code, field, message };
}

function parseUrl(value: unknown, field: "rpcUrl" | "horizonUrl"):
  | { readonly valid: true; readonly url: URL }
  | StellarNetworkConfigValidationError {
  if (typeof value !== "string" && !(value instanceof URL)) {
    return error("INVALID_URL", field, `${field} must be an absolute URL.`);
  }

  let url: URL;
  try {
    url = new URL(value.toString());
  } catch {
    return error("INVALID_URL", field, `${field} must be an absolute URL.`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return error("UNSUPPORTED_URL_PROTOCOL", field, `${field} must use https: or http:.`);
  }
  if (url.username !== "" || url.password !== "") {
    return error("URL_CREDENTIALS_NOT_ALLOWED", field, `${field} must not contain credentials.`);
  }

  // Fragments do not affect HTTP requests and would make identical endpoints
  // compare differently. Keep root '/' but remove redundant path trailing slashes.
  url.hash = "";
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return { valid: true, url };
}

/**
 * Parses and canonicalises a Stellar network configuration without I/O.
 * Known passphrases always determine their stable network identifier; callers
 * cannot override that mapping with a conflicting `network` value.
 */
export function parseStellarNetworkConfig(input: unknown): StellarNetworkConfigParseResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return error("INVALID_INPUT", "input", "Network configuration must be an object.");
  }

  const candidate = input as StellarNetworkConfigInput;
  if (candidate.network !== undefined && candidate.network !== "testnet" && candidate.network !== "public" && candidate.network !== "custom") {
    return error("INVALID_NETWORK", "network", "network must be testnet, public, or custom.");
  }
  if (typeof candidate.passphrase !== "string") {
    return error("MISSING_PASSPHRASE", "passphrase", "passphrase is required.");
  }

  const passphrase = candidate.passphrase.trim();
  if (passphrase.length === 0) {
    return error("INVALID_PASSPHRASE", "passphrase", "passphrase must not be empty.");
  }

  const knownNetwork = KNOWN_NETWORKS.get(passphrase);
  let network: StellarNetwork;
  if (knownNetwork !== undefined) {
    if (candidate.network !== undefined && candidate.network !== knownNetwork) {
      return error(
        "NETWORK_PASSPHRASE_CONFLICT",
        "network",
        `network ${candidate.network} conflicts with the supplied ${knownNetwork} passphrase.`,
      );
    }
    network = knownNetwork;
  } else {
    if (candidate.network !== "custom") {
      return error(
        "INVALID_PASSPHRASE",
        "passphrase",
        "An unknown passphrase requires network to be explicitly set to custom.",
      );
    }
    network = "custom";
  }

  const rpcUrl = parseUrl(candidate.rpcUrl, "rpcUrl");
  if (!rpcUrl.valid) return rpcUrl;

  let horizonUrl: URL | undefined;
  if (candidate.horizonUrl !== undefined) {
    const parsedHorizonUrl = parseUrl(candidate.horizonUrl, "horizonUrl");
    if (!parsedHorizonUrl.valid) return parsedHorizonUrl;
    horizonUrl = parsedHorizonUrl.url;
  }

  return {
    valid: true,
    config: horizonUrl === undefined
      ? { network, passphrase, rpcUrl: rpcUrl.url }
      : { network, passphrase, rpcUrl: rpcUrl.url, horizonUrl },
  };
}

/** Throws a typed error for call sites where invalid configuration is exceptional. */
export class InvalidStellarNetworkConfigError extends Error {
  public readonly code: StellarNetworkConfigValidationErrorCode;
  public readonly field: StellarNetworkConfigValidationError["field"];

  constructor(validationError: StellarNetworkConfigValidationError) {
    super(validationError.message);
    this.name = "InvalidStellarNetworkConfigError";
    this.code = validationError.code;
    this.field = validationError.field;
  }
}

export function assertStellarNetworkConfig(input: unknown): StellarNetworkConfig {
  const result = parseStellarNetworkConfig(input);
  if (!result.valid) throw new InvalidStellarNetworkConfigError(result);
  return result.config;
}
