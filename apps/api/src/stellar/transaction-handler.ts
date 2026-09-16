import { CircuitBreaker, CircuitBreakerRejectedError } from "@guildpass/circuit-breaker";
import { retry, type RetryOptions, RetryExhaustedError } from "@guildpass/retry-policy";
import { StellarTransactionError } from "../errors/index.js";

export type StellarErrorCategory = "TRANSIENT" | "PERMANENT" | "UNKNOWN";

export interface StellarErrorClassification {
  category: StellarErrorCategory;
  isRetryable: boolean;
  code: string;
  message: string;
}

/**
 * Known permanent Stellar / Soroban transaction error result codes.
 * Retrying these will NEVER succeed and only wastes network and compute resources.
 */
export const PERMANENT_STELLAR_RESULT_CODES = new Set<string>([
  "tx_bad_auth",
  "tx_bad_auth_extra",
  "tx_insufficient_balance",
  "tx_insufficient_fee",
  "tx_missing_operation",
  "tx_too_early",
  "tx_too_late",
  "op_underfunded",
  "op_no_trust",
  "op_not_authorized",
  "op_line_full",
  "op_no_issuer",
  "op_no_destination",
  "op_already_exists",
  "op_invalid_limit",
  "op_src_no_trust",
  "op_src_not_authorized",
]);

/**
 * Known transient error codes that are safe to retry after a delay.
 */
export const TRANSIENT_STELLAR_RESULT_CODES = new Set<string>([
  "tx_bad_seq", // Can retry after refreshing source account sequence
  "tx_internal_error",
  "tx_soroban_internal_error",
]);

/**
 * Classifies a raw error from a Stellar RPC or Horizon call into a structured classification.
 */
export function classifyStellarError(error: unknown): StellarErrorClassification {
  if (!error) {
    return {
      category: "UNKNOWN",
      isRetryable: false,
      code: "STELLAR_UNKNOWN",
      message: "An unknown Stellar error occurred",
    };
  }

  if (error instanceof StellarTransactionError) {
    return {
      category: error.isRetryable ? "TRANSIENT" : "PERMANENT",
      isRetryable: error.isRetryable,
      code: error.txResultCode || "STELLAR_TRANSACTION_ERROR",
      message: error.message,
    };
  }

  const errObj = error as Record<string, any>;
  const txCode =
    errObj.txResultCode ||
    errObj.resultCode ||
    errObj.response?.data?.extras?.result_codes?.transaction;
  const opCodes: string[] =
    errObj.opResultCodes ||
    errObj.response?.data?.extras?.result_codes?.operations ||
    [];

  // Check permanent transaction-level codes
  if (txCode && PERMANENT_STELLAR_RESULT_CODES.has(txCode)) {
    return {
      category: "PERMANENT",
      isRetryable: false,
      code: txCode,
      message: `Permanent Stellar transaction failure: ${txCode}`,
    };
  }

  // Check permanent operation-level codes
  for (const opCode of opCodes) {
    if (PERMANENT_STELLAR_RESULT_CODES.has(opCode)) {
      return {
        category: "PERMANENT",
        isRetryable: false,
        code: opCode,
        message: `Permanent Stellar operation failure: ${opCode}`,
      };
    }
  }

  // Check transient transaction-level codes
  if (txCode && TRANSIENT_STELLAR_RESULT_CODES.has(txCode)) {
    return {
      category: "TRANSIENT",
      isRetryable: true,
      code: txCode,
      message: `Transient Stellar transaction failure: ${txCode}`,
    };
  }

  // Check HTTP status codes (e.g. 429, 502, 503, 504)
  const status = errObj.status || errObj.statusCode || errObj.response?.status;
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return {
      category: "TRANSIENT",
      isRetryable: true,
      code: `HTTP_${status}`,
      message: `Stellar RPC returned transient HTTP status ${status}`,
    };
  }

  // Check standard network timeout/connection errors
  const message = String(errObj.message || "");
  if (
    message.includes("ETIMEDOUT") ||
    message.includes("ECONNRESET") ||
    message.includes("timeout") ||
    message.includes("NetworkError") ||
    message.includes("fetch failed")
  ) {
    return {
      category: "TRANSIENT",
      isRetryable: true,
      code: "NETWORK_TIMEOUT",
      message: `Stellar RPC connection error: ${message}`,
    };
  }

  return {
    category: "UNKNOWN",
    isRetryable: false,
    code: "STELLAR_ERROR",
    message: message || "Unclassified Stellar error",
  };
}

export interface StellarExecutorOptions {
  circuitBreaker?: CircuitBreaker;
  retryOptions?: RetryOptions;
}

export interface StellarTxResult<T = unknown> {
  success: true;
  txHash: string;
  ledger?: number;
  data?: T;
  attempts: number;
}

/**
 * Robust executor for Stellar transactions providing circuit breaker protection
 * and classified retry handling.
 */
export class StellarTransactionExecutor {
  public readonly circuitBreaker: CircuitBreaker;
  public readonly retryOptions: RetryOptions;

  constructor(options: StellarExecutorOptions = {}) {
    this.circuitBreaker =
      options.circuitBreaker ||
      new CircuitBreaker({
        failureThreshold: 3,
        cooldownMs: 15000,
        halfOpenProbeLimit: 1,
        isFailure: (reason: unknown) => {
          const classification = classifyStellarError(reason);
          // Circuit breaker trips only on transient infra/RPC failures, not user-induced permanent errors
          return classification.isRetryable;
        },
      });

    this.retryOptions = options.retryOptions || {
      maxAttempts: 3,
      initialDelay: 300,
      maxDelay: 3000,
      backoffMultiplier: 2,
      jitter: { enabled: false }, // predictable for tests/runtime
      isRetryable: (reason: unknown) => {
        const classification = classifyStellarError(reason);
        return classification.isRetryable;
      },
    };
  }

  /**
   * Executes a transaction submission within the circuit breaker and retry policy.
   */
  async submitTransaction<T = unknown>(
    operation: () => Promise<{ txHash: string; ledger?: number; data?: T }>
  ): Promise<StellarTxResult<T>> {
    try {
      return await this.circuitBreaker.execute(async () => {
        let attemptsCount = 0;
        try {
          const result = await retry(async (meta: { attempt: number }) => {
            attemptsCount = meta.attempt;
            return await operation();
          }, this.retryOptions);

          return {
            success: true,
            txHash: result.txHash,
            ledger: result.ledger,
            data: result.data,
            attempts: attemptsCount,
          };
        } catch (error) {
          if (error instanceof RetryExhaustedError) {
            const classification = classifyStellarError(error.cause);
            throw new StellarTransactionError(
              `Stellar transaction failed after ${error.attempts} attempt(s): ${classification.message}`,
              {
                isRetryable: classification.isRetryable,
                txResultCode: classification.code,
                statusCode: 503,
                details: { cause: classification.message },
              }
            );
          }

          const classification = classifyStellarError(error);
          throw new StellarTransactionError(classification.message, {
            isRetryable: classification.isRetryable,
            txResultCode: classification.code,
            statusCode: classification.isRetryable ? 503 : 400,
            details: { code: classification.code },
          });
        }
      });
    } catch (cbError) {
      if (cbError instanceof CircuitBreakerRejectedError) {
        throw new StellarTransactionError(
          "Stellar network RPC is currently unavailable (circuit breaker OPEN). Please retry shortly.",
          {
            isRetryable: true,
            statusCode: 503,
            txResultCode: "CIRCUIT_BREAKER_OPEN",
          }
        );
      }
      throw cbError;
    }
  }
}
