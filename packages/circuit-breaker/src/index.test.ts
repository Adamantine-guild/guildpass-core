import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CircuitBreaker,
  CircuitBreakerRejectedError,
  type CircuitBreakerOptions,
  type Clock,
} from "./index.js";

const COUNTED_FAILURE = Symbol("counted failure");
const NEUTRAL_ERROR = Symbol("neutral error");

interface TestClock extends Clock {
  set(value: number): void;
  advance(deltaMs: number): void;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function testClock(start = 1_000): TestClock {
  let current = start;
  return {
    now: () => current,
    set(value: number): void {
      current = value;
    },
    advance(deltaMs: number): void {
      current += deltaMs;
    },
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function breakerOptions(
  clock: Clock = testClock(),
  overrides: Partial<CircuitBreakerOptions> = {}
): CircuitBreakerOptions {
  return {
    failureThreshold: 2,
    cooldownMs: 100,
    halfOpenProbeLimit: 2,
    isFailure: (reason) => reason === COUNTED_FAILURE,
    clock,
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function countedFailure(breaker: CircuitBreaker): Promise<void> {
  await assert.rejects(
    breaker.execute(() => Promise.reject(COUNTED_FAILURE)),
    (reason: unknown) => reason === COUNTED_FAILURE
  );
}

async function expectRefused(
  promise: Promise<unknown>,
  expectedReason: "OPEN" | "HALF_OPEN_LIMIT"
): Promise<void> {
  await assert.rejects(promise, (reason: unknown) => {
    assert.ok(reason instanceof CircuitBreakerRejectedError);
    assert.equal(reason.reason, expectedReason);
    return true;
  });
}

describe("CircuitBreaker configuration", () => {
  it("starts CLOSED with zeroed immutable metrics", () => {
    const breaker = new CircuitBreaker(breakerOptions());
    const snapshot = breaker.getSnapshot();

    assert.deepStrictEqual(snapshot, {
      state: "CLOSED",
      consecutiveFailures: 0,
      halfOpenInFlight: 0,
      halfOpenSuccesses: 0,
      successfulCalls: 0,
      countedFailures: 0,
      nonCountedErrors: 0,
      rejectedCalls: 0,
    });
    assert.ok(Object.isFrozen(snapshot));
    assert.throws(() => {
      (snapshot as { state: string }).state = "OPEN";
    }, TypeError);
    assert.equal(breaker.getSnapshot().state, "CLOSED");
  });

  it("rejects a missing or non-object options value", () => {
    for (const options of [null, undefined, 1, "options"]) {
      assert.throws(
        () => new CircuitBreaker(options as unknown as CircuitBreakerOptions),
        /options must be an object/
      );
    }
  });

  it("rejects every non-positive or non-safe numeric setting", () => {
    const invalidValues = [0, -1, 1.5, Number.NaN, Infinity, -Infinity];
    const names = [
      "failureThreshold",
      "cooldownMs",
      "halfOpenProbeLimit",
    ] as const;

    for (const name of names) {
      for (const value of invalidValues) {
        assert.throws(
          () =>
            new CircuitBreaker(
              breakerOptions(testClock(), { [name]: value })
            ),
          new RegExp(`${name} must be a positive safe integer`)
        );
      }

      assert.throws(
        () =>
          new CircuitBreaker(
            breakerOptions(testClock(), {
              [name]: Number.MAX_SAFE_INTEGER + 1,
            })
          ),
        new RegExp(`${name} must be a positive safe integer`)
      );
    }
  });

  it("rejects invalid classifier and clock contracts", () => {
    assert.throws(
      () =>
        new CircuitBreaker(
          breakerOptions(testClock(), {
            isFailure: null as unknown as (reason: unknown) => boolean,
          })
        ),
      /isFailure must be a function/
    );
    assert.throws(
      () =>
        new CircuitBreaker(
          breakerOptions(testClock(), {
            clock: { now: 1 } as unknown as Clock,
          })
        ),
      /clock must be an object with a now function/
    );

    for (const value of [Number.NaN, Infinity, -Infinity, "100"]) {
      assert.throws(
        () =>
          new CircuitBreaker(
            breakerOptions({ now: () => value as number })
          ),
        /clock\.now\(\) must return a finite number/
      );
    }
  });

  it("reads each option once and snapshots callbacks at construction", async () => {
    const clock = testClock();
    const reads = new Map<string, number>();
    const count = (name: string): void => {
      reads.set(name, (reads.get(name) ?? 0) + 1);
    };
    const originalClassifier = (reason: unknown): boolean =>
      reason === COUNTED_FAILURE;
    const options: CircuitBreakerOptions = {
      get failureThreshold() {
        count("failureThreshold");
        return 1;
      },
      get cooldownMs() {
        count("cooldownMs");
        return 100;
      },
      get halfOpenProbeLimit() {
        count("halfOpenProbeLimit");
        return 1;
      },
      get isFailure() {
        count("isFailure");
        return originalClassifier;
      },
      get clock() {
        count("clock");
        return clock;
      },
    };

    const breaker = new CircuitBreaker(options);
    Object.defineProperty(options, "isFailure", {
      value: () => false,
    });
    Object.defineProperty(clock, "now", {
      value: () => Number.NaN,
    });

    await countedFailure(breaker);
    assert.equal(breaker.getSnapshot().state, "OPEN");
    assert.deepStrictEqual(Object.fromEntries(reads), {
      failureThreshold: 1,
      cooldownMs: 1,
      halfOpenProbeLimit: 1,
      isFailure: 1,
      clock: 1,
    });
  });

  it("rejects a non-function operation before changing metrics", () => {
    const breaker = new CircuitBreaker(breakerOptions());
    assert.throws(
      () => breaker.execute(null as unknown as () => Promise<void>),
      /operation must be a function/
    );
    assert.equal(breaker.getSnapshot().rejectedCalls, 0);
  });
});

describe("CircuitBreaker CLOSED behaviour", () => {
  it("returns synchronous, asynchronous, and PromiseLike values", async () => {
    const breaker = new CircuitBreaker(breakerOptions());
    const thenable: PromiseLike<number> = {
      then(onFulfilled, onRejected) {
        return Promise.resolve(3).then(onFulfilled, onRejected);
      },
    };

    assert.equal(await breaker.execute(() => 1), 1);
    assert.equal(await breaker.execute(async () => 2), 2);
    assert.equal(await breaker.execute(() => thenable), 3);
    assert.equal(breaker.getSnapshot().successfulCalls, 3);
  });

  it("does not increment failures on success and resets the streak", async () => {
    const breaker = new CircuitBreaker(breakerOptions());
    await countedFailure(breaker);
    assert.equal(breaker.getSnapshot().consecutiveFailures, 1);

    await breaker.execute(() => "healthy");
    assert.equal(breaker.getSnapshot().consecutiveFailures, 0);
    assert.equal(breaker.getSnapshot().countedFailures, 1);
  });

  it("opens at the exact configured counted-failure threshold", async () => {
    const breaker = new CircuitBreaker(
      breakerOptions(testClock(), { failureThreshold: 3 })
    );

    await countedFailure(breaker);
    await countedFailure(breaker);
    assert.equal(breaker.getSnapshot().state, "CLOSED");
    assert.equal(breaker.getSnapshot().consecutiveFailures, 2);

    await countedFailure(breaker);
    assert.equal(breaker.getSnapshot().state, "OPEN");
    assert.equal(breaker.getSnapshot().consecutiveFailures, 3);
  });

  it("preserves synchronous throws and classifies them", async () => {
    const breaker = new CircuitBreaker(breakerOptions());

    await assert.rejects(
      breaker.execute(() => {
        throw COUNTED_FAILURE;
      }),
      (reason: unknown) => reason === COUNTED_FAILURE
    );
    assert.equal(breaker.getSnapshot().countedFailures, 1);
  });

  it("treats non-counted errors as neutral without resetting the streak", async () => {
    const breaker = new CircuitBreaker(breakerOptions());
    await countedFailure(breaker);

    await assert.rejects(
      breaker.execute(() => Promise.reject(NEUTRAL_ERROR)),
      (reason: unknown) => reason === NEUTRAL_ERROR
    );

    const snapshot = breaker.getSnapshot();
    assert.equal(snapshot.state, "CLOSED");
    assert.equal(snapshot.consecutiveFailures, 1);
    assert.equal(snapshot.nonCountedErrors, 1);
    assert.equal(snapshot.countedFailures, 1);
  });

  it("leaves state unchanged when the classifier throws or returns non-boolean", async () => {
    const classifierError = new Error("classifier failed");
    const throwing = new CircuitBreaker(
      breakerOptions(testClock(), {
        isFailure: () => {
          throw classifierError;
        },
      })
    );
    await assert.rejects(
      throwing.execute(() => Promise.reject(COUNTED_FAILURE)),
      (reason: unknown) => reason === classifierError
    );
    assert.equal(throwing.getSnapshot().state, "CLOSED");
    assert.equal(throwing.getSnapshot().countedFailures, 0);

    const nonBoolean = new CircuitBreaker(
      breakerOptions(testClock(), {
        isFailure: (() => "yes") as unknown as (reason: unknown) => boolean,
      })
    );
    await assert.rejects(
      nonBoolean.execute(() => Promise.reject(COUNTED_FAILURE)),
      /isFailure must return a boolean/
    );
    assert.equal(nonBoolean.getSnapshot().state, "CLOSED");
  });
});

describe("CircuitBreaker OPEN and cooldown behaviour", () => {
  it("refuses OPEN calls without invoking the protected operation", async () => {
    const breaker = new CircuitBreaker(
      breakerOptions(testClock(), { failureThreshold: 1 })
    );
    await countedFailure(breaker);
    let invocations = 0;

    await expectRefused(
      breaker.execute(() => {
        invocations += 1;
        return "unexpected";
      }),
      "OPEN"
    );

    assert.equal(invocations, 0);
    assert.equal(breaker.getSnapshot().rejectedCalls, 1);
  });

  it("stays OPEN immediately before cooldown and permits a probe at equality", async () => {
    const clock = testClock();
    const breaker = new CircuitBreaker(
      breakerOptions(clock, {
        failureThreshold: 1,
        cooldownMs: 100,
        halfOpenProbeLimit: 1,
      })
    );
    await countedFailure(breaker);

    clock.advance(99);
    assert.equal(breaker.getSnapshot().state, "OPEN");
    await expectRefused(breaker.execute(() => "too early"), "OPEN");

    clock.advance(1);
    assert.equal(await breaker.execute(() => "probe"), "probe");
    assert.equal(breaker.getSnapshot().state, "CLOSED");
  });

  it("performs lazy time transitions without timers", async (context) => {
    const setTimeoutMock = context.mock.method(globalThis, "setTimeout");
    const clock = testClock();
    const breaker = new CircuitBreaker(
      breakerOptions(clock, { failureThreshold: 1, halfOpenProbeLimit: 1 })
    );

    await countedFailure(breaker);
    clock.advance(100);
    assert.equal(breaker.getSnapshot().state, "HALF_OPEN");
    assert.equal(setTimeoutMock.mock.callCount(), 0);
  });
});

describe("CircuitBreaker HALF_OPEN behaviour", () => {
  it("bounds unsettled probes and closes only after the documented successes", async () => {
    const clock = testClock();
    const breaker = new CircuitBreaker(
      breakerOptions(clock, { failureThreshold: 1, halfOpenProbeLimit: 3 })
    );
    await countedFailure(breaker);
    clock.advance(100);

    const gates = [deferred<number>(), deferred<number>(), deferred<number>()];
    let invocations = 0;
    const probes = gates.map((gate) =>
      breaker.execute(() => {
        invocations += 1;
        return gate.promise;
      })
    );
    assert.equal(invocations, 3);
    assert.equal(breaker.getSnapshot().halfOpenInFlight, 3);

    await expectRefused(
      breaker.execute(() => {
        invocations += 1;
        return 4;
      }),
      "HALF_OPEN_LIMIT"
    );
    assert.equal(invocations, 3);

    gates[0].resolve(1);
    assert.equal(await probes[0], 1);
    assert.equal(breaker.getSnapshot().state, "HALF_OPEN");
    assert.equal(breaker.getSnapshot().halfOpenSuccesses, 1);

    // A successful probe consumes one place in this recovery cycle, so an
    // additional call is still refused while the other two remain unsettled.
    await expectRefused(breaker.execute(() => 5), "HALF_OPEN_LIMIT");

    gates[1].resolve(2);
    gates[2].resolve(3);
    assert.deepStrictEqual(await Promise.all(probes), [1, 2, 3]);
    assert.equal(breaker.getSnapshot().state, "CLOSED");
    assert.equal(breaker.getSnapshot().halfOpenInFlight, 0);
  });

  it("reopens immediately when a probe has a counted failure", async () => {
    const clock = testClock();
    const breaker = new CircuitBreaker(
      breakerOptions(clock, { failureThreshold: 1, halfOpenProbeLimit: 2 })
    );
    await countedFailure(breaker);
    clock.advance(100);

    await countedFailure(breaker);
    assert.equal(breaker.getSnapshot().state, "OPEN");

    clock.advance(99);
    assert.equal(breaker.getSnapshot().state, "OPEN");
    clock.advance(1);
    assert.equal(breaker.getSnapshot().state, "HALF_OPEN");
  });

  it("lets a neutral probe error release capacity without reopening", async () => {
    const clock = testClock();
    const breaker = new CircuitBreaker(
      breakerOptions(clock, { failureThreshold: 1, halfOpenProbeLimit: 1 })
    );
    await countedFailure(breaker);
    clock.advance(100);

    await assert.rejects(
      breaker.execute(() => Promise.reject(NEUTRAL_ERROR)),
      (reason: unknown) => reason === NEUTRAL_ERROR
    );
    assert.equal(breaker.getSnapshot().state, "HALF_OPEN");
    assert.equal(breaker.getSnapshot().halfOpenInFlight, 0);

    assert.equal(await breaker.execute(() => "replacement"), "replacement");
    assert.equal(breaker.getSnapshot().state, "CLOSED");
  });
});

describe("CircuitBreaker concurrent and stale completion behaviour", () => {
  it("serializes concurrent failure completions at the exact threshold", async () => {
    const breaker = new CircuitBreaker(
      breakerOptions(testClock(), { failureThreshold: 25 })
    );
    const gates = Array.from({ length: 50 }, () => deferred<never>());
    const calls = gates.map((gate) => breaker.execute(() => gate.promise));

    for (const gate of gates) {
      gate.reject(COUNTED_FAILURE);
    }
    await Promise.allSettled(calls);

    const snapshot = breaker.getSnapshot();
    assert.equal(snapshot.state, "OPEN");
    assert.equal(snapshot.consecutiveFailures, 25);
    assert.equal(snapshot.countedFailures, 50);
  });

  it("does not let older CLOSED results mutate a newly OPEN circuit", async () => {
    const clock = testClock();
    const breaker = new CircuitBreaker(
      breakerOptions(clock, { failureThreshold: 1, halfOpenProbeLimit: 1 })
    );
    const staleSuccess = deferred<string>();
    const staleFailure = deferred<never>();
    const successCall = breaker.execute(() => staleSuccess.promise);
    const failureCall = breaker.execute(() => staleFailure.promise);

    staleFailure.reject(COUNTED_FAILURE);
    await assert.rejects(failureCall);
    assert.equal(breaker.getSnapshot().state, "OPEN");

    staleSuccess.resolve("late success");
    assert.equal(await successCall, "late success");
    assert.equal(breaker.getSnapshot().state, "OPEN");
    assert.equal(breaker.getSnapshot().successfulCalls, 1);
  });

  it("retains stale probe slots until their actual promises settle", async () => {
    const clock = testClock();
    const breaker = new CircuitBreaker(
      breakerOptions(clock, { failureThreshold: 1, halfOpenProbeLimit: 2 })
    );
    await countedFailure(breaker);
    clock.advance(100);

    const failingProbe = deferred<never>();
    const staleProbe = deferred<string>();
    const first = breaker.execute(() => failingProbe.promise);
    const stale = breaker.execute(() => staleProbe.promise);
    failingProbe.reject(COUNTED_FAILURE);
    await assert.rejects(first);
    assert.equal(breaker.getSnapshot().state, "OPEN");
    assert.equal(breaker.getSnapshot().halfOpenInFlight, 1);

    clock.advance(100);
    const freshGate = deferred<string>();
    const fresh = breaker.execute(() => freshGate.promise);
    assert.equal(breaker.getSnapshot().halfOpenInFlight, 2);
    await expectRefused(breaker.execute(() => "overflow"), "HALF_OPEN_LIMIT");

    freshGate.resolve("fresh one");
    assert.equal(await fresh, "fresh one");
    assert.equal(breaker.getSnapshot().state, "HALF_OPEN");

    const replacement = breaker.execute(() => "fresh two");
    assert.equal(await replacement, "fresh two");
    assert.equal(breaker.getSnapshot().state, "CLOSED");

    staleProbe.reject(COUNTED_FAILURE);
    await assert.rejects(stale);
    assert.equal(breaker.getSnapshot().state, "CLOSED");
    assert.equal(breaker.getSnapshot().countedFailures, 3);
  });

  it("handles many simultaneous callers without exceeding the probe limit", async () => {
    const clock = testClock();
    const breaker = new CircuitBreaker(
      breakerOptions(clock, { failureThreshold: 1, halfOpenProbeLimit: 5 })
    );
    await countedFailure(breaker);
    clock.advance(100);

    const gates = Array.from({ length: 100 }, () => deferred<number>());
    let active = 0;
    let maximumActive = 0;
    let invoked = 0;
    const calls = gates.map((gate, index) =>
      breaker.execute(async () => {
        invoked += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          return await gate.promise;
        } finally {
          active -= 1;
        }
      }).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason })
      )
    );

    assert.equal(invoked, 5);
    assert.equal(active, 5);
    for (let index = 0; index < 5; index += 1) {
      gates[index].resolve(index);
    }
    const results = await Promise.all(calls);

    assert.equal(maximumActive, 5);
    assert.equal(active, 0);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      5
    );
    assert.equal(
      results.filter(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof CircuitBreakerRejectedError
      ).length,
      95
    );
    assert.equal(breaker.getSnapshot().state, "CLOSED");
  });
});

describe("CircuitBreaker metrics", () => {
  it("returns fresh snapshots and counts every public outcome category", async () => {
    const clock = testClock();
    const breaker = new CircuitBreaker(
      breakerOptions(clock, { failureThreshold: 1, halfOpenProbeLimit: 1 })
    );

    await breaker.execute(() => "success");
    await assert.rejects(
      breaker.execute(() => Promise.reject(NEUTRAL_ERROR))
    );
    await countedFailure(breaker);
    await expectRefused(breaker.execute(() => "blocked"), "OPEN");

    const first = breaker.getSnapshot();
    const second = breaker.getSnapshot();
    assert.notEqual(first, second);
    assert.equal(first.successfulCalls, 1);
    assert.equal(first.countedFailures, 1);
    assert.equal(first.nonCountedErrors, 1);
    assert.equal(first.rejectedCalls, 1);
  });
});
