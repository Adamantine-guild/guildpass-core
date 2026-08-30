import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  runTaskPool,
  type AsyncTask,
  type TaskPoolOptions,
  type TaskResult,
} from "./index.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("runTaskPool configuration and input", () => {
  it("returns an empty result for an empty task list", async () => {
    assert.deepStrictEqual(
      await runTaskPool([], { concurrency: 3, timeoutMs: 100 }),
      []
    );
  });

  it("rejects invalid concurrency before invoking any task", () => {
    const invalidValues = [0, -1, 1.5, Number.NaN, Infinity, -Infinity];
    let starts = 0;
    const tasks = [async () => {
      starts += 1;
      return "unexpected";
    }];

    for (const concurrency of invalidValues) {
      assert.throws(
        () => runTaskPool(tasks, { concurrency }),
        /positive safe integer/
      );
    }

    assert.equal(starts, 0);
  });

  it("rejects unsafe integer concurrency", () => {
    assert.throws(
      () => runTaskPool([], { concurrency: Number.MAX_SAFE_INTEGER + 1 }),
      /positive safe integer/
    );
  });

  it("rejects timeout values that Node would coerce", () => {
    const invalidValues = [
      0,
      -1,
      1.5,
      Number.NaN,
      Infinity,
      2_147_483_648,
    ];

    for (const timeoutMs of invalidValues) {
      assert.throws(
        () => runTaskPool([], { concurrency: 1, timeoutMs }),
        /timeoutMs must be a positive safe integer/
      );
    }
  });

  it("rejects a non-function task before invoking earlier tasks", () => {
    let starts = 0;
    const invalidTasks = [
      async () => {
        starts += 1;
        return 1;
      },
      null,
    ] as unknown as Iterable<AsyncTask<number>>;

    assert.throws(
      () => runTaskPool(invalidTasks, { concurrency: 1 }),
      /task at index 1 must be a function/
    );
    assert.equal(starts, 0);
  });

  it("accepts a finite generator and preserves its iteration order", async () => {
    function* tasks(): Iterable<AsyncTask<number>> {
      yield async () => 1;
      yield async () => 2;
      yield async () => 3;
    }

    assert.deepStrictEqual(await runTaskPool(tasks(), { concurrency: 2 }), [
      { status: "fulfilled", value: 1 },
      { status: "fulfilled", value: 2 },
      { status: "fulfilled", value: 3 },
    ]);
  });

  it("propagates an iterator exception before any task starts", () => {
    let starts = 0;
    const iteratorError = new Error("iterator failed");

    function* tasks(): Iterable<AsyncTask<number>> {
      yield async () => {
        starts += 1;
        return 1;
      };
      throw iteratorError;
    }

    assert.throws(
      () => runTaskPool(tasks(), { concurrency: 1 }),
      (reason: unknown) => reason === iteratorError
    );
    assert.equal(starts, 0);
  });

  it("snapshots validated options before an iterable can mutate them", async () => {
    const options = { concurrency: 1, timeoutMs: 1_000 };
    let starts = 0;

    function* tasks(): Iterable<AsyncTask<number>> {
      yield async () => {
        starts += 1;
        return 1;
      };
      options.concurrency = 0;
      options.timeoutMs = 0;
    }

    assert.deepStrictEqual(await runTaskPool(tasks(), options), [
      { status: "fulfilled", value: 1 },
    ]);
    assert.equal(starts, 1);
  });

  it("reads each configuration property only once", async () => {
    let concurrencyReads = 0;
    let timeoutReads = 0;
    const options: TaskPoolOptions = {
      get concurrency() {
        concurrencyReads += 1;
        return 1;
      },
      get timeoutMs() {
        timeoutReads += 1;
        return undefined;
      },
    };

    assert.deepStrictEqual(await runTaskPool([async () => 1], options), [
      { status: "fulfilled", value: 1 },
    ]);
    assert.equal(concurrencyReads, 1);
    assert.equal(timeoutReads, 1);
  });
});

describe("runTaskPool concurrency and ordering", () => {
  it("never exceeds the configured concurrency using controlled promises", async () => {
    const gates = Array.from({ length: 7 }, () => deferred<number>());
    const starts: number[] = [];
    let active = 0;
    let maximumActive = 0;

    const tasks = gates.map((gate, index) => async () => {
      starts.push(index);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        return await gate.promise;
      } finally {
        active -= 1;
      }
    });

    const pool = runTaskPool(tasks, { concurrency: 3 });
    await flushMicrotasks();
    assert.deepStrictEqual(starts, [0, 1, 2]);
    assert.equal(active, 3);

    for (let index = 0; index < gates.length; index += 1) {
      gates[index].resolve(index * 10);
      await flushMicrotasks();
      assert.ok(active <= 3);
    }

    assert.deepStrictEqual(await pool, [
      { status: "fulfilled", value: 0 },
      { status: "fulfilled", value: 10 },
      { status: "fulfilled", value: 20 },
      { status: "fulfilled", value: 30 },
      { status: "fulfilled", value: 40 },
      { status: "fulfilled", value: 50 },
      { status: "fulfilled", value: 60 },
    ]);
    assert.equal(maximumActive, 3);
    assert.equal(active, 0);
  });

  it("preserves input order when tasks settle in reverse order", async () => {
    const gates = Array.from({ length: 4 }, () => deferred<string>());
    const pool = runTaskPool(
      gates.map((gate) => async () => gate.promise),
      { concurrency: 4 }
    );

    for (let index = gates.length - 1; index >= 0; index -= 1) {
      gates[index].resolve(`value-${index}`);
    }

    assert.deepStrictEqual(await pool, [
      { status: "fulfilled", value: "value-0" },
      { status: "fulfilled", value: "value-1" },
      { status: "fulfilled", value: "value-2" },
      { status: "fulfilled", value: "value-3" },
    ]);
  });

  it("does not create more workers than tasks", async () => {
    let active = 0;
    let maximumActive = 0;

    const results = await runTaskPool(
      [
        async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          active -= 1;
          return "only";
        },
      ],
      { concurrency: 1000 }
    );

    assert.deepStrictEqual(results, [{ status: "fulfilled", value: "only" }]);
    assert.equal(maximumActive, 1);
  });
});

describe("runTaskPool failures", () => {
  it("captures synchronous exceptions thrown during task invocation", async () => {
    const failure = new Error("synchronous failure");

    const results = await runTaskPool(
      [
        () => {
          throw failure;
        },
        async () => "still runs",
      ],
      { concurrency: 1 }
    );

    assert.deepStrictEqual(results, [
      { status: "rejected", reason: failure },
      { status: "fulfilled", value: "still runs" },
    ]);
  });

  it("captures asynchronous rejection values without failing the pool", async () => {
    const results = await runTaskPool(
      [async () => Promise.reject("non-error rejection"), async () => 42],
      { concurrency: 2 }
    );

    assert.deepStrictEqual(results, [
      { status: "rejected", reason: "non-error rejection" },
      { status: "fulfilled", value: 42 },
    ]);
  });

  it("assimilates a rejecting PromiseLike without an unhandled rejection", async () => {
    const failure = new Error("thenable failure");
    const thenable: PromiseLike<never> = {
      then(_onFulfilled, onRejected) {
        if (onRejected != null) {
          onRejected(failure);
        }
        return Promise.resolve(undefined as never);
      },
    };

    assert.deepStrictEqual(
      await runTaskPool([() => thenable], { concurrency: 1 }),
      [{ status: "rejected", reason: failure }]
    );
  });
});

describe("runTaskPool cancellation", () => {
  it("does not start tasks when the external signal is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("stop before start");
    controller.abort(reason);
    let starts = 0;

    const results = await runTaskPool(
      Array.from({ length: 3 }, () => async () => {
        starts += 1;
        return "unexpected";
      }),
      { concurrency: 2, signal: controller.signal }
    );

    assert.equal(starts, 0);
    assert.deepStrictEqual(results, Array.from({ length: 3 }, () => ({
      status: "cancelled",
      reason,
    })));
  });

  it("stops launching tasks, signals running work, and drains it", async () => {
    const controller = new AbortController();
    const reason = new Error("shutdown");
    const gates = [deferred<number>(), deferred<number>()];
    const receivedSignals: AbortSignal[] = [];
    const starts: number[] = [];
    let poolSettled = false;

    const tasks: AsyncTask<number>[] = [
      (signal) => {
        starts.push(0);
        receivedSignals.push(signal);
        return gates[0].promise;
      },
      (signal) => {
        starts.push(1);
        receivedSignals.push(signal);
        return gates[1].promise;
      },
      async () => {
        starts.push(2);
        return 2;
      },
    ];

    const pool = runTaskPool(tasks, {
      concurrency: 2,
      signal: controller.signal,
    });
    void pool.finally(() => {
      poolSettled = true;
    });

    await flushMicrotasks();
    controller.abort(reason);
    await flushMicrotasks();

    assert.deepStrictEqual(starts, [0, 1]);
    assert.ok(receivedSignals.every((signal) => signal.aborted));
    assert.ok(receivedSignals.every((signal) => signal.reason === reason));
    assert.equal(poolSettled, false);

    gates[0].resolve(0);
    gates[1].reject(new Error("late rejection after cancellation"));

    assert.deepStrictEqual(await pool, [
      { status: "cancelled", reason },
      { status: "cancelled", reason },
      { status: "cancelled", reason },
    ]);
    assert.equal(poolSettled, true);
  });

  it("observes cancellation triggered synchronously by a running task", async () => {
    const controller = new AbortController();
    const starts: number[] = [];

    const tasks = Array.from({ length: 5 }, (_, index) => async () => {
      starts.push(index);
      if (index === 0) {
        controller.abort("cancelled inside task");
      }
      return index;
    });

    const results = await runTaskPool(tasks, {
      concurrency: 5,
      signal: controller.signal,
    });

    assert.deepStrictEqual(starts, [0]);
    assert.deepStrictEqual(results, Array.from({ length: 5 }, () => ({
      status: "cancelled",
      reason: "cancelled inside task",
    })));
  });

  it("removes the external abort listener after normal completion", async (context) => {
    const controller = new AbortController();
    const addListenerMock = context.mock.method(
      controller.signal,
      "addEventListener"
    );
    const removeListenerMock = context.mock.method(
      controller.signal,
      "removeEventListener"
    );

    assert.deepStrictEqual(
      await runTaskPool([async () => "done"], {
        concurrency: 1,
        signal: controller.signal,
      }),
      [{ status: "fulfilled", value: "done" }]
    );

    assert.equal(addListenerMock.mock.callCount(), 1);
    assert.equal(removeListenerMock.mock.callCount(), 1);
  });
});

describe("runTaskPool timeouts", () => {
  it("times out a cooperative task and passes it a TimeoutError signal", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let receivedReason: unknown;

    const pool = runTaskPool(
      [
        (signal) =>
          new Promise<string>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                receivedReason = signal.reason;
                resolve("stopped");
              },
              { once: true }
            );
          }),
      ],
      { concurrency: 1, timeoutMs: 25 }
    );

    context.mock.timers.tick(25);
    await flushMicrotasks();

    assert.deepStrictEqual(await pool, [
      { status: "timed-out", timeoutMs: 25 },
    ]);
    assert.ok(receivedReason instanceof DOMException);
    assert.equal(receivedReason.name, "TimeoutError");
  });

  it("retains a worker slot after timeout until non-cooperative work settles", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const firstGate = deferred<number>();
    const starts: number[] = [];
    let firstSignal: AbortSignal | undefined;
    let poolSettled = false;

    const pool = runTaskPool(
      [
        (signal) => {
          starts.push(0);
          firstSignal = signal;
          return firstGate.promise;
        },
        async () => {
          starts.push(1);
          return 1;
        },
      ],
      { concurrency: 1, timeoutMs: 10 }
    );
    void pool.finally(() => {
      poolSettled = true;
    });

    context.mock.timers.tick(10);
    await flushMicrotasks();

    assert.equal(firstSignal?.aborted, true);
    assert.deepStrictEqual(starts, [0]);
    assert.equal(poolSettled, false);

    firstGate.resolve(0);
    await flushMicrotasks();
    assert.deepStrictEqual(starts, [0, 1]);

    assert.deepStrictEqual(await pool, [
      { status: "timed-out", timeoutMs: 10 },
      { status: "fulfilled", value: 1 },
    ]);
  });

  it("starts each timeout when its task is invoked, not while queued", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const observedAborts: number[] = [];

    const task = (index: number): AsyncTask<number> => (signal) =>
      new Promise<number>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            observedAborts.push(index);
            resolve(index);
          },
          { once: true }
        );
      });

    const pool = runTaskPool([task(0), task(1)], {
      concurrency: 1,
      timeoutMs: 50,
    });

    context.mock.timers.tick(50);
    await flushMicrotasks();
    assert.deepStrictEqual(observedAborts, [0]);

    context.mock.timers.tick(49);
    await flushMicrotasks();
    assert.deepStrictEqual(observedAborts, [0]);

    context.mock.timers.tick(1);
    await flushMicrotasks();
    assert.deepStrictEqual(observedAborts, [0, 1]);

    assert.deepStrictEqual(await pool, [
      { status: "timed-out", timeoutMs: 50 },
      { status: "timed-out", timeoutMs: 50 },
    ]);
  });

  it("clears a pending timer when a task completes", async (context) => {
    const clearTimeoutMock = context.mock.method(globalThis, "clearTimeout");

    assert.deepStrictEqual(
      await runTaskPool([async () => "fast"], {
        concurrency: 1,
        timeoutMs: 60_000,
      }),
      [{ status: "fulfilled", value: "fast" }]
    );

    assert.equal(clearTimeoutMock.mock.callCount(), 1);
  });

  it("keeps a timed-out result and consumes the task's later rejection", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const gate = deferred<never>();
    const lateFailure = new Error("late failure");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const pool = runTaskPool([async () => gate.promise], {
        concurrency: 1,
        timeoutMs: 5,
      });

      context.mock.timers.tick(5);
      await flushMicrotasks();
      gate.reject(lateFailure);

      assert.deepStrictEqual(await pool, [
        { status: "timed-out", timeoutMs: 5 },
      ]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(unhandled, []);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("keeps the first observed terminal state between timeout and cancellation", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const controller = new AbortController();
    const gate = deferred<number>();

    const pool = runTaskPool([async () => gate.promise], {
      concurrency: 1,
      timeoutMs: 10,
      signal: controller.signal,
    });

    context.mock.timers.tick(10);
    controller.abort("later cancellation");
    gate.resolve(1);

    assert.deepStrictEqual(await pool, [
      { status: "timed-out", timeoutMs: 10 },
    ]);
  });

  it("keeps cancellation when it is observed before timeout and clears the timer", async (context) => {
    const clearTimeoutMock = context.mock.method(globalThis, "clearTimeout");
    const controller = new AbortController();
    const reason = new Error("cancel before deadline");

    const pool = runTaskPool(
      [
        (signal) =>
          new Promise<number>((resolve) => {
            signal.addEventListener("abort", () => resolve(1), { once: true });
          }),
      ],
      {
        concurrency: 1,
        timeoutMs: 60_000,
        signal: controller.signal,
      }
    );

    controller.abort(reason);

    assert.deepStrictEqual(await pool, [{ status: "cancelled", reason }]);
    assert.equal(clearTimeoutMock.mock.callCount(), 1);
  });
});

describe("TaskResult typing", () => {
  it("supports exhaustive discrimination by status", () => {
    const describeResult = (result: TaskResult<number>): string => {
      switch (result.status) {
        case "fulfilled":
          return String(result.value);
        case "rejected":
          return String(result.reason);
        case "cancelled":
          return String(result.reason);
        case "timed-out":
          return String(result.timeoutMs);
        default: {
          const exhaustive: never = result;
          return exhaustive;
        }
      }
    };

    assert.equal(describeResult({ status: "fulfilled", value: 7 }), "7");
  });
});
