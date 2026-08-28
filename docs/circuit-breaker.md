# Asynchronous Circuit Breaker

`@guildpass/circuit-breaker` is a dependency-free resilience primitive for
protecting asynchronous operations with a `CLOSED`, `OPEN`, and `HALF_OPEN`
state machine. It has no HTTP, Stellar, persistence, retry, or framework
integration.

## API

```ts
import {
  CircuitBreaker,
  CircuitBreakerRejectedError,
} from "@guildpass/circuit-breaker";

const breaker = new CircuitBreaker({
  failureThreshold: 3,
  cooldownMs: 10_000,
  halfOpenProbeLimit: 2,
  isFailure: (reason) => reason instanceof Error,
});

try {
  const value = await breaker.execute(() => performOperation());
  console.log(value);
} catch (reason: unknown) {
  if (reason instanceof CircuitBreakerRejectedError) {
    // reason.reason is either "OPEN" or "HALF_OPEN_LIMIT".
  }
  throw reason;
}
```

An operation may return a value or any `PromiseLike` value. Its fulfilled value
and original rejection reason are preserved. A call rejected by the breaker
does not invoke the operation.

## State policy

### CLOSED

Calls are admitted normally. A rejection increments the consecutive-failure
counter only when `isFailure(reason)` returns `true`. A fulfilled operation
resets that counter to zero. A non-counted rejection is neutral: it neither
increments nor resets the streak.

Outcomes are ordered by settlement, not by invocation. This is the only
deterministic meaning of consecutive outcomes for concurrently running calls.
The circuit moves to `OPEN` when the counter reaches `failureThreshold`
exactly.

### OPEN

Calls are rejected with a `CircuitBreakerRejectedError` whose `reason` is
`"OPEN"`. The protected operation is not invoked.

The cooldown begins when the failure that opens or reopens the circuit is
classified. No timer is installed. On the first `execute()` or `getSnapshot()`
at which `clock.now() - openedAt >= cooldownMs`, the state moves lazily to
`HALF_OPEN`. This keeps time-dependent behaviour deterministic and avoids a
background timer that could outlive an otherwise idle breaker.

### HALF_OPEN

At most `halfOpenProbeLimit` probe promises may remain unsettled. The same
number of successful probes from one half-open generation is required to close
the circuit. Successful probes consume their place in that recovery cycle, so
the circuit cannot close while another counted outcome from the same cycle is
still pending.

One counted probe failure immediately moves the circuit back to `OPEN` and
starts a fresh cooldown. A non-counted probe error does not indicate dependency
health: it releases its slot and leaves the circuit `HALF_OPEN`, allowing a
replacement probe.

Calls beyond the available probe capacity reject with a
`CircuitBreakerRejectedError` whose `reason` is `"HALF_OPEN_LIMIT"`, without
invoking the operation.

The limited trial-call policy follows the recovery purpose described by the
[Microsoft Azure Circuit Breaker pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker).

## Concurrent callers and late results

Admission, probe reservation, and state updates contain no suspension point.
Within one JavaScript isolate, each execution job runs to completion before the
next job, as specified by the
[JavaScript execution model](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Execution_model#run-to-completion).
This makes those short check-and-update sections indivisible with respect to
other promise continuations in the same isolate.

Each admitted call captures an internal generation. When another result changes
the state, later results from the older generation still update lifetime
metrics but cannot change the current state or its recovery counters. This
prevents a late success from closing a newly opened circuit and prevents a late
failure from reopening a recovered one.

An unsettled probe retains its physical probe slot even after another probe
reopens the circuit. If the cooldown expires before that stale operation
settles, it still counts toward the global `halfOpenProbeLimit`. This strict
accounting prevents a new recovery generation from exceeding the configured
number of simultaneously executing probes.

The concurrency guarantee is local to one breaker instance in one JavaScript
isolate. It does not coordinate `worker_threads`, cluster workers, processes,
or hosts. Cross-process coordination would require shared infrastructure and is
outside this package's scope.

## Snapshot and metrics

`getSnapshot()` returns a new frozen object:

```ts
interface CircuitBreakerSnapshot {
  readonly state: "CLOSED" | "OPEN" | "HALF_OPEN";
  readonly consecutiveFailures: number;
  readonly halfOpenInFlight: number;
  readonly halfOpenSuccesses: number;
  readonly successfulCalls: number;
  readonly countedFailures: number;
  readonly nonCountedErrors: number;
  readonly rejectedCalls: number;
}
```

- `consecutiveFailures` is the current control counter. It resets on a closed
  success and when recovery begins or completes.
- `halfOpenInFlight` includes every unsettled probe still occupying physical
  capacity, including a probe from an older generation.
- `halfOpenSuccesses` belongs to the current recovery generation and is zero
  outside it.
- the last four fields are lifetime counters. `rejectedCalls` includes both
  open-state and probe-limit refusals.

Snapshots expose no mutable internal object and cannot be used to change the
breaker.

## Deterministic time

The default clock calls `Date.now()`. Tests and applications may inject:

```ts
const clock = { now: () => controlledMilliseconds };
```

The clock is read during construction, while checking an open cooldown, and
when a counted failure opens or reopens the circuit. Each reading must be a
finite number. An injected clock should be fast, synchronous, and
nondecreasing. The breaker does not correct a clock that moves backwards; the
cooldown remains pending until the configured time boundary is reached again.

## Validation and callback requirements

The constructor rejects invalid configuration synchronously:

- `failureThreshold`, `cooldownMs`, and `halfOpenProbeLimit` must be positive
  safe integers;
- `isFailure` must be a function and must return a boolean;
- `clock`, when supplied, must expose `now()` and return a finite number.

Configuration fields and callback references are captured during construction,
so later replacement of an option or `clock.now` property cannot change the
validated policy.

`isFailure` is called only after an admitted operation rejects. It should be a
fast, pure, synchronous classifier without I/O or breaker re-entry. If it
throws or returns a non-boolean value, that classifier error rejects the call
and breaker state is unchanged because the operation could not be classified.

## Operational limitations

- The breaker does not cancel, time out, retry, or terminate protected work.
- A probe that never settles retains one probe slot indefinitely. This is
  explicit rather than silently exceeding the physical concurrency bound.
- Synchronous CPU-bound work cannot be interrupted by the breaker.
- State and metrics are in memory and are not persisted or shared.
- There are no fallbacks, events, registries, manual reset controls, dynamic
  thresholds, sliding windows, HTTP adapters, Stellar clients, or database
  adapters.

These exclusions keep the package limited to the state machine requested by
the issue. Retry and circuit breaking serve different purposes, as the
[Azure reference](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker)
also notes, and no retry-policy dependency is introduced.
