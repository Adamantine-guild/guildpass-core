const MAX_DECIMALS = 255;

export class InvalidAmountError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAmountError";
  }
}

function validateDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new RangeError(
      `Decimals must be an integer between 0 and ${MAX_DECIMALS}`
    );
  }
}

function scaleFor(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

/**
 * Converts a decimal string to integer base units without floating-point math.
 * Leading plus/minus signs are accepted. Excess fractional precision is rejected.
 */
export function parseAmount(value: string, decimals: number): bigint {
  validateDecimals(decimals);

  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidAmountError("Amount must be a non-empty decimal string");
  }

  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) {
    throw new InvalidAmountError(`Invalid decimal amount: ${value}`);
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";

  if (fraction.length > decimals) {
    throw new InvalidAmountError(
      `Amount has ${fraction.length} fractional digits; maximum is ${decimals}`
    );
  }

  const paddedFraction = fraction.padEnd(decimals, "0");
  const units = BigInt(whole) * scaleFor(decimals) + BigInt(paddedFraction || "0");
  return units === 0n ? 0n : sign * units;
}

/**
 * Formats integer base units as a canonical decimal string.
 * Fractional trailing zeros are removed and negative zero is never emitted.
 */
export function formatAmount(value: bigint, decimals: number): string {
  validateDecimals(decimals);

  if (typeof value !== "bigint") {
    throw new TypeError("Amount must be a bigint");
  }

  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const scale = scaleFor(decimals);
  const whole = magnitude / scale;

  if (decimals === 0) {
    return `${negative ? "-" : ""}${whole.toString()}`;
  }

  const fraction = (magnitude % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  const sign = negative ? "-" : "";

  return fraction.length === 0
    ? `${sign}${whole.toString()}`
    : `${sign}${whole.toString()}.${fraction}`;
}
