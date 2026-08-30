/**
 * Retry Policy Engine
 * 
 * A generic asynchronous retry engine supporting exponential backoff, jitter,
 * cancellation, and caller-defined retry classification.
 * 
 * This is a standalone resilience primitive with no dependencies on
 * Stellar RPC, HTTP clients, Redis, Prisma, or other services.
 */

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Configuration for jitter injection into backoff delays.
 */
export interface JitterConfig {
  /**
   * Whether to apply jitter to backoff delays.
   * @default true
   */
  enabled?: boolean;
  
  /**
   * Random number generator for deterministic jitter in tests.
   * If not provided, uses Math.random().
   */
  random?: () => number;
}

/**
 * Configuration for retry behavior.
 */
export interface RetryOptions {
  /**
   * Maximum number of attempts (including the first execution).
   * @default 3
   */
  maxAttempts?: number;
  
  /**
   * Initial delay before the first retry in milliseconds.
   * @default 1000
   */
  initialDelay?: number;
  
  /**
   * Maximum delay cap in milliseconds.
   * @default 30000
   */
  maxDelay?: number;
  
  /**
   * Multiplier for exponential backoff.
   * @default 2
   */
  backoffMultiplier?: number;
  
  /**
   * Jitter configuration to prevent retry storms.
   * @default { enabled: true }
   */
  jitter?: JitterConfig;
  
  /**
   * AbortSignal for cancellation.
   */
  signal?: AbortSignal;
  
  /**
   * Predicate to determine if an error is retryable.
   * If not provided, all errors are considered retryable.
   */
  isRetryable?: (error: unknown) => boolean;
  
  /**
   * Callback invoked before each retry attempt.
   * Receives the attempt number (1-indexed) and the error that caused the retry.
   */
  onRetry?: (attempt: number, error: unknown) => void;
}

/**
 * Metadata about retry attempts.
 */
export interface RetryMetadata {
  /**
   * The attempt number (1-indexed).
   */
  attempt: number;
  
  /**
   * Total number of attempts made.
   */
  totalAttempts: number;
}

/**
 * Error thrown when retry attempts are exhausted.
 */
export class RetryExhaustedError extends Error {
  /**
   * The error that caused the final failure.
   */
  readonly cause: unknown;
  
  /**
   * Number of attempts made.
   */
  readonly attempts: number;
  
  constructor(message: string, cause: unknown, attempts: number) {
    super(message);
    this.name = "RetryExhaustedError";
    this.cause = cause;
    this.attempts = attempts;
  }
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY = 1000;
const DEFAULT_MAX_DELAY = 30000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;

// ============================================================================
// Backoff Calculation
// ============================================================================

/**
 * Calculates exponential backoff delay for a given attempt.
 * 
 * @param attempt - The attempt number (1-indexed)
 * @param initialDelay - Initial delay in milliseconds
 * @param maxDelay - Maximum delay cap in milliseconds
 * @param multiplier - Backoff multiplier
 * @param jitter - Jitter configuration
 * @returns Delay in milliseconds
 */
export function calculateBackoff(
  attempt: number,
  initialDelay: number = DEFAULT_INITIAL_DELAY,
  maxDelay: number = DEFAULT_MAX_DELAY,
  multiplier: number = DEFAULT_BACKOFF_MULTIPLIER,
  jitter: JitterConfig = { enabled: true }
): number {
  // Calculate exponential backoff: initialDelay * (multiplier ^ (attempt - 1))
  const exponentialDelay = initialDelay * Math.pow(multiplier, attempt - 1);
  
  // Cap at maximum delay
  const cappedDelay = Math.min(exponentialDelay, maxDelay);
  
  // Apply jitter if enabled
  if (jitter.enabled !== false) {
    const random = jitter.random || Math.random;
    // Full jitter: random value between 0 and cappedDelay
    return cappedDelay * random();
  }
  
  return cappedDelay;
}

// ============================================================================
// Retry Classification
// ============================================================================

/**
 * Default retry classification - considers all errors retryable.
 */
function defaultIsRetryable(_error: unknown): boolean {
  return true;
}

// ============================================================================
// Delay with Cancellation
// ============================================================================

/**
 * Creates a delay promise that respects AbortSignal.
 * 
 * @param ms - Delay in milliseconds
 * @param signal - Optional AbortSignal for cancellation
 * @returns Promise that resolves after delay or rejects on abort
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    
    const timeout = setTimeout(() => {
      resolve();
      cleanup();
    }, ms);
    
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
      cleanup();
    };
    
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    
    signal?.addEventListener("abort", onAbort);
  });
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validates retry configuration.
 */
function validateOptions(options: RetryOptions): void {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialDelay = options.initialDelay ?? DEFAULT_INITIAL_DELAY;
  const maxDelay = options.maxDelay ?? DEFAULT_MAX_DELAY;
  const multiplier = options.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
  
  if (maxAttempts < 1) {
    throw new RangeError("maxAttempts must be at least 1");
  }
  
  if (initialDelay < 0) {
    throw new RangeError("initialDelay must be non-negative");
  }
  
  if (maxDelay < 0) {
    throw new RangeError("maxDelay must be non-negative");
  }
  
  if (multiplier < 1) {
    throw new RangeError("backoffMultiplier must be at least 1");
  }
  
  if (initialDelay > maxDelay) {
    throw new RangeError("initialDelay cannot exceed maxDelay");
  }
}

// ============================================================================
// Main Retry Function
// ============================================================================

/**
 * Retries an async operation with configurable backoff and jitter.
 * 
 * @param operation - Async operation to retry
 * @param options - Retry configuration
 * @returns Promise that resolves with operation result or rejects with RetryExhaustedError
 * 
 * @example
 * ```ts
 * const result = await retry(
 *   async () => fetch(url),
 *   { maxAttempts: 5, initialDelay: 1000 }
 * );
 * ```
 */
export async function retry<T>(
  operation: (metadata: RetryMetadata) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  validateOptions(options);
  
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialDelay = options.initialDelay ?? DEFAULT_INITIAL_DELAY;
  const maxDelay = options.maxDelay ?? DEFAULT_MAX_DELAY;
  const multiplier = options.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
  const jitter = options.jitter ?? { enabled: true };
  const isRetryable = options.isRetryable ?? defaultIsRetryable;
  
  let lastError: unknown;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Check for cancellation before each attempt
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    
    const metadata: RetryMetadata = {
      attempt,
      totalAttempts: attempt
    };
    
    try {
      // Execute the operation
      const result = await operation(metadata);
      return result;
    } catch (error) {
      lastError = error;
      
      // Check if error is retryable
      if (!isRetryable(error)) {
        throw error;
      }
      
      // If this was the last attempt, throw exhausted error
      if (attempt === maxAttempts) {
        throw new RetryExhaustedError(
          `Operation failed after ${maxAttempts} attempts`,
          lastError,
          maxAttempts
        );
      }
      
      // Invoke onRetry callback if provided
      options.onRetry?.(attempt, error);
      
      // Calculate backoff and wait before next attempt
      const backoffDelay = calculateBackoff(
        attempt + 1,
        initialDelay,
        maxDelay,
        multiplier,
        jitter
      );
      
      await delay(backoffDelay, options.signal);
    }
  }
  
  // This should never be reached, but TypeScript needs it
  throw new RetryExhaustedError(
    "Operation failed",
    lastError,
    maxAttempts
  );
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Creates a retry predicate that classifies errors by type.
 * 
 * @param retryableTypes - Array of error constructors that are retryable
 * @returns Predicate function for isRetryable option
 * 
 * @example
 * ```ts
 * const isNetworkErrorRetryable = retryableByType([NetworkError, TimeoutError]);
 * await retry(operation, { isRetryable: isNetworkErrorRetryable });
 * ```
 */
export function retryableByType(
  retryableTypes: Array<new (...args: any[]) => Error>
): (error: unknown) => boolean {
  return (error: unknown) => {
    return retryableTypes.some(
      (Type) => error instanceof Type
    );
  };
}

/**
 * Creates a retry predicate that classifies errors by error code/message.
 * 
 * @param retryableCodes - Array of error codes or messages that are retryable
 * @returns Predicate function for isRetryable option
 * 
 * @example
 * ```ts
 * const isRetryableByCode = retryableByCode(['ETIMEDOUT', 'ECONNRESET']);
 * await retry(operation, { isRetryable: isRetryableByCode });
 * ```
 */
export function retryableByCode(
  retryableCodes: string[]
): (error: unknown) => boolean {
  return (error: unknown) => {
    if (error instanceof Error) {
      const errorCode = (error as any).code;
      return retryableCodes.includes(errorCode || error.message);
    }
    return false;
  };
};

/**
 * Creates a retry predicate that classifies errors by custom predicate.
 * 
 * @param predicate - Custom predicate function
 * @returns Predicate function for isRetryable option
 */
export function retryableIf(
  predicate: (error: unknown) => boolean
): (error: unknown) => boolean {
  return predicate;
}
