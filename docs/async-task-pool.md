# Asynchronous Task Pool

`@guildpass/async-task-pool` executes a finite iterable of asynchronous task
functions under a hard concurrency ceiling. It is framework-independent, has
no runtime dependencies, and does not contain GuildPass domain logic.

## API

```ts
import { runTaskPool } from "@guildpass/async-task-pool";

const controller = new AbortController();

const results = await runTaskPool(
  [
    async (signal) => readFirstResource({ signal }),
    async (signal) => readSecondResource({ signal }),
  ],
  {
    concurrency: 2,
    timeoutMs: 5_000,
    signal: controller.signal,
  }
);
```

Each task receives a task-local `AbortSignal`. Callers should propagate that
signal to any underlying API that supports cancellation and should stop their
own work when it is aborted.

The pool returns one result per input task:

```ts
type TaskResult<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown }
  | { readonly status: "cancelled"; readonly reason: unknown }
  | { readonly status: "timed-out"; readonly timeoutMs: number };
```

Results always preserve input iteration order, not completion order.

## Concurrency model

The pool materializes and validates the finite input iterable before invoking
any task. It then creates at most `min(concurrency, taskCount)` workers. Each
worker invokes one task at a time and does not claim another input until the
previous task's actual promise has settled.

Tasks are functions rather than already-created promises. Passing already
running promises would make it impossible for the pool to limit when work
starts.

## Cancellation model

When the external signal is already aborted, no task starts and every input is
reported as `cancelled` with the external signal's reason.

When cancellation is observed during execution:

1. no additional task is invoked;
2. tasks not yet started are reported as `cancelled`;
3. each running task's local signal is aborted with the external reason;
4. the pool waits for the running task promises to settle before it resolves.

Cancellation is cooperative. JavaScript cannot forcibly terminate an
arbitrary promise or its side effects. A running task that ignores its signal
and never settles can therefore keep the pool pending. This strict-drain policy
is intentional: returning its worker slot early could allow replacement work
to start while the timed-out or cancelled operation is still active, violating
the configured concurrency ceiling.

## Timeout model

`timeoutMs` is optional and applies independently to every task. A task's timer
starts when that task is invoked, not while it waits for a worker.

When the timer expires, the pool:

1. fixes that task's result as `timed-out`;
2. aborts the task-local signal with a `DOMException` named `TimeoutError`;
3. retains the worker slot until the task promise actually settles;
4. consumes any later fulfillment or rejection without replacing the
   `timed-out` result.

The first terminal event observed by the pool wins. A task that settles before
its deadline is `fulfilled` or `rejected`; a later timeout or external abort
does not replace that outcome. Similarly, an external cancellation observed
after a timeout does not replace `timed-out`.

Pending timers are cleared when tasks settle early or external cancellation
makes them unnecessary. The external abort listener is also removed when the
pool completes normally. Node.js recommends one-shot abort listeners to avoid
memory leaks; see the official
[`AbortSignal` documentation](https://nodejs.org/docs/latest-v24.x/api/globals.html#class-abortsignal).

## Validation and errors

Configuration and the complete iterable are validated synchronously before any
task starts.

- `concurrency` must be a positive safe integer.
- `timeoutMs`, when present, must be a positive safe integer no greater than
  `2_147_483_647`.
- every iterable entry must be a function.
- the iterable must be finite and may throw its own iteration error.

Node.js coerces delays outside its supported range to approximately one
millisecond, so accepting them would create unexpectedly immediate timeouts.
See the official
[`setTimeout` documentation](https://nodejs.org/docs/latest-v24.x/api/timers.html#settimeoutcallback-delay-args).

Task failures do not reject the pool. Synchronous exceptions and asynchronous
rejections become `rejected` results, and the original rejection value is
preserved as `unknown`.

## Operational limits

- The pool bounds simultaneously unsettled task promises; it is not a rate
  limiter, retry engine, queue service, or process scheduler.
- Timeouts cannot interrupt synchronous CPU-bound code because timer callbacks
  require the JavaScript event loop to run.
- The complete task list and result list are retained in memory, so memory use
  is `O(n)` for `n` input tasks.
- A task may perform irreversible side effects before observing cancellation.
  Callers remain responsible for making such operations safe and idempotent.
- No task priority, retries, progress callbacks, dynamic task insertion, HTTP,
  database, Redis, or blockchain integration is provided.
