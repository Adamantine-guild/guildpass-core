import { Buffer } from "node:buffer";
import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Number of random bytes behind each ownership token. 32 bytes is 256 bits of
 * CSPRNG output, rendered as 43 base64url characters.
 */
const TOKEN_BYTE_LENGTH = 32;

/**
 * Upper bound on any lease duration. Matches the bound the async task pool
 * applies to its timeouts, and keeps `now + durationMs` inside the safe integer
 * range for any plausible wall clock, so an expiry can never silently lose
 * precision and read as already elapsed.
 */
const MAX_LEASE_DURATION_MS = 2_147_483_647;

/** Default ceiling on the number of tracked resources. */
const DEFAULT_MAX_RESOURCES = 10_000;

/** Default minimum spacing between time-triggered sweeps of expired leases. */
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

/**
 * Source of the current time in milliseconds.
 *
 * Injecting a clock is what makes expiry behaviour testable without sleeping or
 * patching globals. The clock is supplied once, to the manager's constructor,
 * and never per call: if individual callers could pass their own clock, any one
 * of them could present a timestamp earlier than the one that issued a live
 * lease, observe that lease as expired, and take it over. Mutual exclusion would
 * then depend on every caller agreeing about time, which is not enforceable.
 */
export interface Clock {
  /** Current time in milliseconds. Must return a finite number. */
  now(): number;
}

/**
 * A time-bounded claim on a resource.
 *
 * Instances handed to callers are frozen snapshots of the manager's internal
 * state, not live views: they do not update when the lease is renewed, and
 * mutating one cannot affect what the manager holds. Re-read validity through
 * the manager rather than trusting a snapshot's `expiresAt` after time has
 * passed.
 */
export interface Lease {
  /** The resource this lease covers. */
  readonly resource: string;
  /** Secret proving ownership. Required to renew or release, and never disclosed to other callers. */
  readonly ownerToken: string;
  /** Time at which the lease was granted. */
  readonly acquiredAt: number;
  /** Time at which the lease lapses. The lease is valid while `expiresAt > now`. */
  readonly expiresAt: number;
}

/** The resource was free (or its previous lease had lapsed) and is now held. */
export interface AcquiredOutcome {
  readonly status: "acquired";
  readonly lease: Lease;
}

/**
 * A valid lease is already held by someone else.
 *
 * Only the incumbent's expiry is disclosed, so a caller can back off until the
 * resource can next be taken. The incumbent's token is deliberately withheld:
 * returning it here would hand ownership to the caller being denied.
 */
export interface BusyOutcome {
  readonly status: "busy";
  readonly heldUntil: number;
}

/**
 * The manager is already tracking `maxResources` resources, all under leases
 * that are still valid, so a new resource cannot be admitted.
 *
 * Evicting a valid lease to make room would silently break mutual exclusion for
 * whichever resource was evicted, so the acquisition is refused instead.
 */
export interface CapacityExhaustedOutcome {
  readonly status: "capacity-exhausted";
  readonly maxResources: number;
}

/** Terminal outcome of an acquisition attempt. */
export type AcquireOutcome =
  | AcquiredOutcome
  | BusyOutcome
  | CapacityExhaustedOutcome;

/** The caller owned the live lease and its expiry has been extended. */
export interface RenewedOutcome {
  readonly status: "renewed";
  readonly lease: Lease;
}

/** No lease for this resource is being tracked at all. */
export interface NotFoundOutcome {
  readonly status: "not-found";
}

/**
 * A lease for this resource existed but had already lapsed, so nobody owns it.
 *
 * Reported without inspecting the caller's token, because an expired lease has
 * no owner to match against. Renewal does not resurrect it: the caller must
 * decide to `acquire` again, and must treat any work it performed while
 * believing it held the lease as unprotected.
 */
export interface ExpiredOutcome {
  readonly status: "expired";
}

/**
 * A different, still-valid lease covers this resource.
 *
 * This is the outcome a stale owner receives after its lease lapsed and another
 * caller acquired the resource.
 */
export interface OwnershipMismatchOutcome {
  readonly status: "ownership-mismatch";
}

/** Terminal outcome of a renewal attempt. */
export type RenewOutcome =
  | RenewedOutcome
  | NotFoundOutcome
  | ExpiredOutcome
  | OwnershipMismatchOutcome;

/** The caller owned the live lease and it has been given up. */
export interface ReleasedOutcome {
  readonly status: "released";
}

/** Terminal outcome of a release attempt. */
export type ReleaseOutcome =
  | ReleasedOutcome
  | NotFoundOutcome
  | ExpiredOutcome
  | OwnershipMismatchOutcome;

/** Construction options for {@link LeaseManager}. */
export interface LeaseManagerOptions {
  /** Default lifetime granted by `acquire` and `renew`, in milliseconds. */
  readonly leaseDurationMs: number;
  /** Time source. Defaults to `Date.now`. */
  readonly clock?: Clock;
  /** Hard ceiling on tracked resources. Defaults to 10,000. */
  readonly maxResources?: number;
  /** Minimum spacing between time-triggered sweeps. Defaults to 30,000 ms. */
  readonly sweepIntervalMs?: number;
}

/** Internal, mutable counterpart of {@link Lease}. Never handed to callers. */
interface LeaseRecord {
  readonly resource: string;
  readonly ownerToken: string;
  readonly acquiredAt: number;
  expiresAt: number;
}

function validateResource(resource: string): string {
  if (typeof resource !== "string" || resource.length === 0) {
    throw new TypeError("resource must be a non-empty string");
  }
  return resource;
}

function validateOwnerToken(ownerToken: string): string {
  if (typeof ownerToken !== "string" || ownerToken.length === 0) {
    throw new TypeError("ownerToken must be a non-empty string");
  }
  return ownerToken;
}

function validateDurationMs(durationMs: number, label: string): number {
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    durationMs > MAX_LEASE_DURATION_MS
  ) {
    throw new TypeError(
      `${label} must be a positive safe integer no greater than ${MAX_LEASE_DURATION_MS}`
    );
  }
  return durationMs;
}

function validateBound(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function validateClock(clock: Clock): Clock {
  if (
    clock === null ||
    typeof clock !== "object" ||
    typeof clock.now !== "function"
  ) {
    throw new TypeError("clock must be an object exposing a now() method");
  }
  return clock;
}

/**
 * Generates a fresh ownership token.
 *
 * Uses the synchronous form of `randomBytes`, which draws from the platform
 * CSPRNG. The synchronous form matters twice over: the token must be
 * unguessable, and generating it must not suspend, because it happens inside
 * the check-and-set window that `acquire` relies on being indivisible.
 */
function generateOwnerToken(): string {
  return randomBytes(TOKEN_BYTE_LENGTH).toString("base64url");
}

/**
 * Compares a caller-supplied token against a stored one in constant time with
 * respect to their contents.
 *
 * Tokens are fixed length, so the early length check reveals nothing an
 * attacker does not already know, and it is required because `timingSafeEqual`
 * throws on mismatched lengths.
 */
function tokensMatch(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");

  if (candidateBytes.length !== expectedBytes.length) {
    return false;
  }

  return timingSafeEqual(candidateBytes, expectedBytes);
}

/** Produces the frozen public view of an internal record. */
function snapshot(record: LeaseRecord): Lease {
  return Object.freeze({
    resource: record.resource,
    ownerToken: record.ownerToken,
    acquiredAt: record.acquiredAt,
    expiresAt: record.expiresAt,
  });
}

/**
 * In-memory manager for time-bounded, token-owned leases over named resources.
 *
 * ## Ownership and expiry semantics
 *
 * A resource carries at most one lease. `acquire` grants one only when no
 * *valid* lease exists, and returns a secret `ownerToken` that is the sole proof
 * of ownership: `renew` and `release` take effect only when presented with the
 * token of the lease that is live at the moment of the call.
 *
 * Validity is always computed, never stored. A lease is valid exactly while
 * `expiresAt > clock.now()`, evaluated afresh on every operation, so the
 * interval is half-open: at exactly `expiresAt` the lease has already lapsed.
 * There is no cached "active" flag that could disagree with the clock, and a
 * lease needs no explicit cleanup to stop being valid.
 *
 * Expiry is unilateral. When a lease lapses the resource becomes acquirable by
 * anyone, and the previous holder is not notified. A holder that keeps working
 * past `expiresAt` has no protection, which is why `renew` refuses to resurrect
 * a lapsed lease — it reports `expired` and leaves reacquisition to a
 * deliberate `acquire`. A stale holder that later calls `renew` or `release`
 * against a lease someone else has since acquired receives `ownership-mismatch`
 * and cannot disturb the new holder.
 *
 * ## Concurrency: what is and is not guaranteed
 *
 * Every method is synchronous and completes without suspending. JavaScript runs
 * these calls on a single thread and never preempts a synchronous execution
 * turn, so the check-and-set inside `acquire` — reading the current lease and
 * writing the new one — is indivisible with respect to every other job in this
 * isolate. Any number of `acquire` calls racing in the same tick, or from
 * interleaved promise continuations, therefore yield exactly one `acquired`.
 *
 * **This guarantee stops at the isolate boundary.** The manager holds its state
 * in an ordinary `Map` on one heap. It provides *no* mutual exclusion across
 * `worker_threads`, across `cluster` workers, or across separate processes or
 * hosts: each has its own heap and its own manager, and all of them will
 * happily grant the same lease at the same time. Coordinating beyond a single
 * isolate requires a shared store, which is deliberately outside this
 * primitive's scope.
 *
 * ## Memory
 *
 * State is bounded by `maxResources` at all times; see {@link sweep} and
 * {@link size}.
 */
export class LeaseManager {
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly clock: Clock;
  private readonly leaseDurationMs: number;
  private readonly maxResources: number;
  private readonly sweepIntervalMs: number;
  private lastSweepAt: number;

  constructor(options: LeaseManagerOptions) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("options must be an object");
    }

    this.leaseDurationMs = validateDurationMs(
      options.leaseDurationMs,
      "leaseDurationMs"
    );
    this.clock =
      options.clock === undefined
        ? { now: () => Date.now() }
        : validateClock(options.clock);
    this.maxResources = validateBound(
      options.maxResources ?? DEFAULT_MAX_RESOURCES,
      "maxResources"
    );
    this.sweepIntervalMs = validateBound(
      options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
      "sweepIntervalMs"
    );

    // Reading the clock here both anchors the sweep interval to construction
    // and rejects an unusable clock immediately rather than at first acquire.
    this.lastSweepAt = this.readClock();
  }

  /**
   * Claims `resource` if no valid lease covers it.
   *
   * Succeeds when the resource has never been leased, or when its lease has
   * lapsed — in which case the lapsed lease is replaced and its token stops
   * being accepted. Returns `busy` without modifying anything if a valid lease
   * is held, and `capacity-exhausted` if admitting a new resource would exceed
   * `maxResources` and no expired entry can be reclaimed to make room.
   *
   * @param resource Non-empty resource name.
   * @param leaseDurationMs Lifetime for this lease; defaults to the manager's.
   * @throws {TypeError} On an empty resource or an out-of-range duration.
   */
  public acquire(resource: string, leaseDurationMs?: number): AcquireOutcome {
    const key = validateResource(resource);
    const durationMs =
      leaseDurationMs === undefined
        ? this.leaseDurationMs
        : validateDurationMs(leaseDurationMs, "leaseDurationMs");
    const now = this.readClock();

    // Amortised, access-triggered cleanup. Runs before the critical section and
    // only ever removes leases that have already lapsed, so it cannot influence
    // the decision below for any resource that is still validly held.
    if (now - this.lastSweepAt >= this.sweepIntervalMs) {
      this.sweepExpired(now);
    }

    // --- Check-and-set. Nothing between the read and the write may suspend:
    // no await, no callback, no I/O. This is what makes the claim atomic. ---
    const existing = this.leases.get(key);

    if (existing !== undefined && existing.expiresAt > now) {
      return { status: "busy", heldUntil: existing.expiresAt };
    }

    if (existing === undefined && this.leases.size >= this.maxResources) {
      // Admitting this resource would cross the cap. Reclaim lapsed entries
      // first; if every slot is a valid lease, refuse rather than evict one.
      this.sweepExpired(now);

      if (this.leases.size >= this.maxResources) {
        return {
          status: "capacity-exhausted",
          maxResources: this.maxResources,
        };
      }
    }

    const record: LeaseRecord = {
      resource: key,
      ownerToken: generateOwnerToken(),
      acquiredAt: now,
      expiresAt: now + durationMs,
    };

    this.leases.set(record.resource, record);
    // --- End of the critical section. ---

    return { status: "acquired", lease: snapshot(record) };
  }

  /**
   * Extends the lease on `resource`, if `ownerToken` owns the lease that is
   * live right now.
   *
   * The new expiry is measured from the current time, not from the previous
   * expiry, so repeated renewals cannot accumulate a lease further and further
   * into the future.
   *
   * Returns `not-found` when nothing is tracked for the resource, `expired`
   * when the lease has lapsed (renewal never resurrects it — reacquire
   * explicitly), and `ownership-mismatch` when a different valid lease is held.
   * Only `renewed` changes any state.
   *
   * @throws {TypeError} On an empty resource or token, or an out-of-range duration.
   */
  public renew(
    resource: string,
    ownerToken: string,
    leaseDurationMs?: number
  ): RenewOutcome {
    const key = validateResource(resource);
    const token = validateOwnerToken(ownerToken);
    const durationMs =
      leaseDurationMs === undefined
        ? this.leaseDurationMs
        : validateDurationMs(leaseDurationMs, "leaseDurationMs");
    const now = this.readClock();

    const existing = this.leases.get(key);

    if (existing === undefined) {
      return { status: "not-found" };
    }

    // Validity is checked before ownership: a lapsed lease has no owner, so
    // there is nothing to match a token against, and reporting `expired`
    // regardless of the token avoids disclosing anything about the lease that
    // used to be there.
    if (!(existing.expiresAt > now)) {
      this.leases.delete(key);
      return { status: "expired" };
    }

    if (!tokensMatch(token, existing.ownerToken)) {
      return { status: "ownership-mismatch" };
    }

    existing.expiresAt = now + durationMs;
    return { status: "renewed", lease: snapshot(existing) };
  }

  /**
   * Gives up the lease on `resource`, if `ownerToken` owns the lease that is
   * live right now.
   *
   * Deliberately not silently idempotent: `not-found` and `expired` are
   * reported distinctly from `released` so that double releases and releases
   * after expiry are visible to the caller instead of looking like success. A
   * caller that wants idempotent behaviour can ignore those variants.
   *
   * A token whose lease has lapsed and been reacquired by someone else yields
   * `ownership-mismatch` and leaves the new holder's lease untouched.
   *
   * @throws {TypeError} On an empty resource or token.
   */
  public release(resource: string, ownerToken: string): ReleaseOutcome {
    const key = validateResource(resource);
    const token = validateOwnerToken(ownerToken);
    const now = this.readClock();

    const existing = this.leases.get(key);

    if (existing === undefined) {
      return { status: "not-found" };
    }

    if (!(existing.expiresAt > now)) {
      this.leases.delete(key);
      return { status: "expired" };
    }

    if (!tokensMatch(token, existing.ownerToken)) {
      return { status: "ownership-mismatch" };
    }

    this.leases.delete(key);
    return { status: "released" };
  }

  /**
   * Drops every lease that has already lapsed and reports how many were
   * removed.
   *
   * Called automatically by `acquire`, both on a timer-free interval check and
   * unconditionally before admitting a resource that would cross
   * `maxResources`. Exposed so that a process holding a long-idle manager can
   * reclaim memory without waiting for the next acquisition.
   */
  public sweep(): number {
    return this.sweepExpired(this.readClock());
  }

  /**
   * Number of resources currently tracked, valid and lapsed-but-unswept alike.
   *
   * Never exceeds `maxResources`, because the cap is enforced before insertion
   * rather than corrected afterwards.
   */
  public size(): number {
    return this.leases.size;
  }

  /**
   * Reads the injected clock, rejecting a reading that cannot be compared
   * meaningfully.
   *
   * A clock returning `NaN` would make every `expiresAt > now` comparison false
   * and so make every lease in the manager look expired at once — a silent loss
   * of mutual exclusion. Failing loudly is the only safe response.
   */
  private readClock(): number {
    const now = this.clock.now();

    if (typeof now !== "number" || !Number.isFinite(now)) {
      throw new TypeError("clock.now() must return a finite number");
    }

    return now;
  }

  /** Removes lapsed leases as of `now`. Valid leases are never evicted. */
  private sweepExpired(now: number): number {
    this.lastSweepAt = now;
    let removed = 0;

    for (const [key, record] of this.leases) {
      if (!(record.expiresAt > now)) {
        this.leases.delete(key);
        removed += 1;
      }
    }

    return removed;
  }
}
