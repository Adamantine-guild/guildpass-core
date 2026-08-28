/** States exposed by a circuit breaker. */
export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

/** Time source used for cooldown decisions. */
export interface Clock {
  now(): number;
}

export interface CircuitBreakerOptions {
  /** Consecutive counted failures required to open a closed circuit. */
  readonly failureThreshold: number;
  /** Time for which an open circuit rejects calls before probing may begin. */
  readonly cooldownMs: number;
  /** Maximum unsettled probes and successful probes required to close. */
  readonly halfOpenProbeLimit: number;
  /** Classifies an operation rejection as a breaker failure or a neutral error. */
  readonly isFailure: (reason: unknown) => boolean;
  /** Injectable time source. Defaults to `Date.now`. */
  readonly clock?: Clock;
}

/** Immutable point-in-time view of breaker state and lifetime counters. */
export interface CircuitBreakerSnapshot {
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  readonly halfOpenInFlight: number;
  readonly halfOpenSuccesses: number;
  readonly successfulCalls: number;
  readonly countedFailures: number;
  readonly nonCountedErrors: number;
  readonly rejectedCalls: number;
}

export type CircuitBreakerRejectionReason = "OPEN" | "HALF_OPEN_LIMIT";

/** Raised when the breaker refuses a call without invoking its operation. */
export class CircuitBreakerRejectedError extends Error {
  public readonly reason: CircuitBreakerRejectionReason;

  constructor(reason: CircuitBreakerRejectionReason) {
    super(
      reason === "OPEN"
        ? "Circuit breaker is open"
        : "Circuit breaker half-open probe limit has been reached"
    );
    this.name = "CircuitBreakerRejectedError";
    this.reason = reason;
  }
}

interface NormalizedOptions {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly halfOpenProbeLimit: number;
  readonly isFailure: (reason: unknown) => boolean;
  readonly now: () => number;
}

interface ProbeTicket {
  readonly generation: number;
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }

  return value as number;
}

function normalizeOptions(options: CircuitBreakerOptions): NormalizedOptions {
  if (options === null || typeof options !== "object") {
    throw new TypeError("options must be an object");
  }

  // Read each caller-controlled property exactly once. Later mutation of the
  // options object cannot alter the policy after validation.
  const {
    failureThreshold,
    cooldownMs,
    halfOpenProbeLimit,
    isFailure,
    clock,
  } = options;

  if (typeof isFailure !== "function") {
    throw new TypeError("isFailure must be a function");
  }

  let now: () => number;
  if (clock === undefined) {
    now = () => Date.now();
  } else {
    if (clock === null || typeof clock !== "object") {
      throw new TypeError("clock must be an object with a now function");
    }

    const clockNow = clock.now;
    if (typeof clockNow !== "function") {
      throw new TypeError("clock must be an object with a now function");
    }

    // Capture both the function and its receiver, so replacing `clock.now`
    // after construction cannot silently change the breaker's time policy.
    now = () => clockNow.call(clock);
  }

  return {
    failureThreshold: positiveSafeInteger(
      failureThreshold,
      "failureThreshold"
    ),
    cooldownMs: positiveSafeInteger(cooldownMs, "cooldownMs"),
    halfOpenProbeLimit: positiveSafeInteger(
      halfOpenProbeLimit,
      "halfOpenProbeLimit"
    ),
    isFailure,
    now,
  };
}

/**
 * Generic asynchronous circuit breaker for one JavaScript isolate.
 *
 * Admission and every state mutation are synchronous sections with no `await`
 * or caller callback between their read and write. Settled calls carry the
 * generation in which they were admitted, so results from an older state
 * cycle can update lifetime metrics but cannot mutate the current state.
 */
export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly halfOpenProbeLimit: number;
  private readonly isFailure: (reason: unknown) => boolean;
  private readonly now: () => number;

  private state: CircuitState = "CLOSED";
  private generation = 0;
  private openedAt: number | undefined;
  private consecutiveFailures = 0;
  private halfOpenSuccesses = 0;
  private readonly activeProbes = new Set<ProbeTicket>();

  private successfulCalls = 0;
  private countedFailures = 0;
  private nonCountedErrors = 0;
  private rejectedCalls = 0;

  constructor(options: CircuitBreakerOptions) {
    const normalized = normalizeOptions(options);
    this.failureThreshold = normalized.failureThreshold;
    this.cooldownMs = normalized.cooldownMs;
    this.halfOpenProbeLimit = normalized.halfOpenProbeLimit;
    this.isFailure = normalized.isFailure;
    this.now = normalized.now;

    // Fail at construction when an injected clock is unusable instead of
    // accepting a breaker whose first time-dependent transition will fail.
    this.readClock();
  }

  /**
   * Executes `operation` when the current state admits it.
   *
   * Rejected operations preserve their original reason after classification.
   * Calls refused by the breaker reject with `CircuitBreakerRejectedError`
   * and never invoke `operation`.
   */
  public execute<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    if (typeof operation !== "function") {
      throw new TypeError("operation must be a function");
    }

    this.refreshOpenState();

    if (this.state === "OPEN") {
      this.rejectedCalls += 1;
      return Promise.reject(new CircuitBreakerRejectedError("OPEN"));
    }

    let ticket: ProbeTicket | undefined;
    if (this.state === "HALF_OPEN") {
      const currentProbeCount = this.currentGenerationProbeCount();

      // Successful probes consume their share of this recovery cycle. Neutral
      // errors do not, so once they settle a replacement probe may be admitted.
      // The global size also retains slots occupied by stale unsettled probes.
      if (
        this.activeProbes.size >= this.halfOpenProbeLimit ||
        this.halfOpenSuccesses + currentProbeCount >=
          this.halfOpenProbeLimit
      ) {
        this.rejectedCalls += 1;
        return Promise.reject(
          new CircuitBreakerRejectedError("HALF_OPEN_LIMIT")
        );
      }

      ticket = { generation: this.generation };
      this.activeProbes.add(ticket);
    }

    const admittedGeneration = this.generation;
    return this.invoke(operation, admittedGeneration, ticket);
  }

  /** Returns a new frozen snapshot; callers cannot mutate internal state. */
  public getSnapshot(): CircuitBreakerSnapshot {
    this.refreshOpenState();

    return Object.freeze({
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      halfOpenInFlight: this.activeProbes.size,
      halfOpenSuccesses: this.halfOpenSuccesses,
      successfulCalls: this.successfulCalls,
      countedFailures: this.countedFailures,
      nonCountedErrors: this.nonCountedErrors,
      rejectedCalls: this.rejectedCalls,
    });
  }

  private async invoke<T>(
    operation: () => T | PromiseLike<T>,
    admittedGeneration: number,
    ticket: ProbeTicket | undefined
  ): Promise<T> {
    try {
      const value = await Promise.resolve(operation());
      this.successfulCalls += 1;
      this.recordSuccess(admittedGeneration);
      return value;
    } catch (reason: unknown) {
      const counted = this.classify(reason);

      if (counted) {
        this.countedFailures += 1;
        this.recordCountedFailure(admittedGeneration);
      } else {
        this.nonCountedErrors += 1;
      }

      throw reason;
    } finally {
      if (ticket !== undefined) {
        this.activeProbes.delete(ticket);
      }
    }
  }

  private classify(reason: unknown): boolean {
    const result = this.isFailure(reason);

    if (typeof result !== "boolean") {
      throw new TypeError("isFailure must return a boolean");
    }

    return result;
  }

  private recordSuccess(admittedGeneration: number): void {
    if (admittedGeneration !== this.generation) {
      return;
    }

    if (this.state === "CLOSED") {
      this.consecutiveFailures = 0;
      return;
    }

    if (this.state === "HALF_OPEN") {
      this.halfOpenSuccesses += 1;

      if (this.halfOpenSuccesses === this.halfOpenProbeLimit) {
        this.transitionToClosed();
      }
    }
  }

  private recordCountedFailure(admittedGeneration: number): void {
    if (admittedGeneration !== this.generation) {
      return;
    }

    if (this.state === "HALF_OPEN") {
      this.transitionToOpen(this.readClock());
      return;
    }

    if (this.state !== "CLOSED") {
      return;
    }

    const nextFailureCount = this.consecutiveFailures + 1;
    if (nextFailureCount < this.failureThreshold) {
      this.consecutiveFailures = nextFailureCount;
      return;
    }

    const now = this.readClock();
    // The clock is caller-supplied. Recheck after invoking it so even a
    // re-entrant implementation cannot apply this failure to a newer cycle.
    if (
      admittedGeneration === this.generation &&
      this.state === "CLOSED"
    ) {
      this.consecutiveFailures = nextFailureCount;
      this.transitionToOpen(now);
    }
  }

  private refreshOpenState(): void {
    if (this.state !== "OPEN") {
      return;
    }

    const openedAt = this.openedAt;
    if (openedAt === undefined) {
      throw new Error("open circuit has no cooldown anchor");
    }

    const now = this.readClock();
    if (now - openedAt >= this.cooldownMs && this.state === "OPEN") {
      this.state = "HALF_OPEN";
      this.generation += 1;
      this.openedAt = undefined;
      this.consecutiveFailures = 0;
      this.halfOpenSuccesses = 0;
    }
  }

  private transitionToOpen(now: number): void {
    this.state = "OPEN";
    this.generation += 1;
    this.openedAt = now;
    this.halfOpenSuccesses = 0;
  }

  private transitionToClosed(): void {
    this.state = "CLOSED";
    this.generation += 1;
    this.openedAt = undefined;
    this.consecutiveFailures = 0;
    this.halfOpenSuccesses = 0;
  }

  private currentGenerationProbeCount(): number {
    let count = 0;
    for (const ticket of this.activeProbes) {
      if (ticket.generation === this.generation) {
        count += 1;
      }
    }
    return count;
  }

  private readClock(): number {
    const value = this.now();

    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError("clock.now() must return a finite number");
    }

    return value;
  }
}
