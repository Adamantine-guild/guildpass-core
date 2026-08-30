const MAX_TIMEOUT_MS = 2_147_483_647;

/** An asynchronous unit of work controlled by the pool. */
export type AsyncTask<T> = (signal: AbortSignal) => PromiseLike<T>;

export interface FulfilledTaskResult<T> {
  readonly status: "fulfilled";
  readonly value: T;
}

export interface RejectedTaskResult {
  readonly status: "rejected";
  readonly reason: unknown;
}

export interface CancelledTaskResult {
  readonly status: "cancelled";
  readonly reason: unknown;
}

export interface TimedOutTaskResult {
  readonly status: "timed-out";
  readonly timeoutMs: number;
}

/** The terminal outcome observed by the pool for one input task. */
export type TaskResult<T> =
  | FulfilledTaskResult<T>
  | RejectedTaskResult
  | CancelledTaskResult
  | TimedOutTaskResult;

export interface TaskPoolOptions {
  /** Maximum number of task promises that may remain unsettled at once. */
  readonly concurrency: number;
  /** Cancels tasks that have not started and signals tasks already running. */
  readonly signal?: AbortSignal;
  /** Optional timeout, measured from each task's invocation. */
  readonly timeoutMs?: number;
}

interface ActiveTaskControl {
  cancel(reason: unknown): void;
}

interface NormalizedTaskPoolOptions {
  readonly concurrency: number;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number | undefined;
}

function normalizeOptions(options: TaskPoolOptions): NormalizedTaskPoolOptions {
  if (options === null || typeof options !== "object") {
    throw new TypeError("options must be an object");
  }

  const { concurrency, signal, timeoutMs } = options;

  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new TypeError("concurrency must be a positive safe integer");
  }

  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > MAX_TIMEOUT_MS)
  ) {
    throw new TypeError(
      `timeoutMs must be a positive safe integer no greater than ${MAX_TIMEOUT_MS}`
    );
  }

  return { concurrency, signal, timeoutMs };
}

function materializeTasks<T>(tasks: Iterable<AsyncTask<T>>): AsyncTask<T>[] {
  const taskList = Array.from(tasks);

  for (let index = 0; index < taskList.length; index += 1) {
    if (typeof taskList[index] !== "function") {
      throw new TypeError(`task at index ${index} must be a function`);
    }
  }

  return taskList;
}

function timeoutReason(timeoutMs: number): DOMException {
  return new DOMException(`Task timed out after ${timeoutMs} ms`, "TimeoutError");
}

async function executeTask<T>(
  task: AsyncTask<T>,
  index: number,
  timeoutMs: number | undefined,
  activeTasks: Set<ActiveTaskControl>,
  results: Array<TaskResult<T> | undefined>
): Promise<void> {
  const controller = new AbortController();
  let outcome: TaskResult<T> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTaskTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const abortTask = (reason: unknown): void => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  const control: ActiveTaskControl = {
    cancel(reason: unknown): void {
      if (outcome === undefined) {
        outcome = { status: "cancelled", reason };
      }

      clearTaskTimer();
      abortTask(reason);
    },
  };

  activeTasks.add(control);

  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timer = undefined;

      if (outcome === undefined) {
        outcome = { status: "timed-out", timeoutMs };
        abortTask(timeoutReason(timeoutMs));
      }
    }, timeoutMs);
  }

  try {
    let taskPromise: Promise<T>;

    try {
      taskPromise = Promise.resolve(task(controller.signal));
    } catch (reason: unknown) {
      if (outcome === undefined) {
        outcome = { status: "rejected", reason };
      }
      return;
    }

    try {
      const value = await taskPromise;
      if (outcome === undefined) {
        outcome = { status: "fulfilled", value };
      }
    } catch (reason: unknown) {
      if (outcome === undefined) {
        outcome = { status: "rejected", reason };
      }
    }
  } finally {
    clearTaskTimer();
    activeTasks.delete(control);

    if (outcome === undefined) {
      throw new Error("task completed without a recorded outcome");
    }

    results[index] = outcome;
  }
}

async function executeTaskPool<T>(
  taskList: readonly AsyncTask<T>[],
  options: NormalizedTaskPoolOptions
): Promise<readonly TaskResult<T>[]> {
  const results: Array<TaskResult<T> | undefined> = new Array(taskList.length);
  const activeTasks = new Set<ActiveTaskControl>();
  const externalSignal = options.signal;
  let nextIndex = 0;
  let cancellationObserved = false;
  let cancellationReason: unknown;
  let abortListenerAttached = false;

  const observeCancellation = (): void => {
    if (cancellationObserved) {
      return;
    }

    cancellationObserved = true;
    cancellationReason = externalSignal?.reason;

    for (const activeTask of activeTasks) {
      activeTask.cancel(cancellationReason);
    }
  };

  if (externalSignal?.aborted) {
    observeCancellation();
  } else if (externalSignal !== undefined) {
    externalSignal.addEventListener("abort", observeCancellation, { once: true });
    abortListenerAttached = true;
  }

  try {
    if (!cancellationObserved) {
      const worker = async (): Promise<void> => {
        while (!cancellationObserved) {
          if (nextIndex >= taskList.length) {
            return;
          }

          const index = nextIndex;
          nextIndex += 1;

          await executeTask(
            taskList[index],
            index,
            options.timeoutMs,
            activeTasks,
            results
          );
        }
      };

      const workerCount = Math.min(options.concurrency, taskList.length);
      const workers = Array.from({ length: workerCount }, () => worker());
      await Promise.all(workers);
    }

    if (cancellationObserved) {
      for (let index = 0; index < results.length; index += 1) {
        if (results[index] === undefined) {
          results[index] = {
            status: "cancelled",
            reason: cancellationReason,
          };
        }
      }
    }

    return Array.from(results, (result, index) => {
      if (result === undefined) {
        throw new Error(`task at index ${index} completed without a result`);
      }
      return result;
    });
  } finally {
    if (abortListenerAttached) {
      externalSignal?.removeEventListener("abort", observeCancellation);
    }
  }
}

/**
 * Executes a finite iterable of asynchronous task functions under a hard
 * concurrency ceiling and returns one structured result per input task.
 *
 * Results preserve input iteration order. Cancellation and timeouts signal
 * running tasks cooperatively; a worker slot is retained until the underlying
 * task promise settles, so a non-cooperative task can keep the pool pending.
 */
export function runTaskPool<T>(
  tasks: Iterable<AsyncTask<T>>,
  options: TaskPoolOptions
): Promise<readonly TaskResult<T>[]> {
  const normalizedOptions = normalizeOptions(options);
  const taskList = materializeTasks(tasks);
  return executeTaskPool(taskList, normalizedOptions);
}
