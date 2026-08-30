import * as assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  LeaseManager,
  type AcquireOutcome,
  type Clock,
  type ReleaseOutcome,
  type RenewOutcome,
} from "./index.js";

const DURATION_MS = 30_000;
const START_MS = 1_700_000_000_000;

interface TestClock extends Clock {
  set(value: number): void;
  advance(deltaMs: number): void;
}

/** Hand-driven clock, so every expiry assertion is exact rather than timed. */
function testClock(startMs: number = START_MS): TestClock {
  let current = startMs;
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

/** Asserts an outcome's status and narrows it to that variant. */
function expectStatus<O extends { status: string }, S extends O["status"]>(
  outcome: O,
  status: S
): Extract<O, { status: S }> {
  assert.equal(outcome.status, status);
  return outcome as Extract<O, { status: S }>;
}

/**
 * Queues `count` attempts as pending microtasks before any of them runs, so
 * every attempt is in flight simultaneously and their continuations interleave.
 * A check-and-set that suspends part-way through will be caught here.
 */
async function raceAttempts<T>(
  count: number,
  attempt: () => T | Promise<T>
): Promise<T[]> {
  const attempts: Array<Promise<T>> = [];

  for (let index = 0; index < count; index += 1) {
    attempts.push(
      (async () => {
        await Promise.resolve();
        return attempt();
      })()
    );
  }

  return Promise.all(attempts);
}

describe("leasing a free resource", () => {
  it("grants a lease bearing an ownership token and a computed expiry", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const outcome = expectStatus(manager.acquire("job:indexer"), "acquired");

    assert.equal(outcome.lease.resource, "job:indexer");
    assert.equal(typeof outcome.lease.ownerToken, "string");
    assert.ok(outcome.lease.ownerToken.length > 0);
    assert.equal(outcome.lease.acquiredAt, START_MS);
    assert.equal(outcome.lease.expiresAt, START_MS + DURATION_MS);
    assert.equal(manager.size(), 1);
  });

  it("leases distinct resources independently and with distinct tokens", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const first = expectStatus(manager.acquire("job:a"), "acquired");
    const second = expectStatus(manager.acquire("job:b"), "acquired");

    assert.notEqual(first.lease.ownerToken, second.lease.ownerToken);
    assert.equal(manager.size(), 2);
  });

  it("honours a per-acquisition duration override", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const outcome = expectStatus(manager.acquire("job:a", 500), "acquired");

    assert.equal(outcome.lease.expiresAt, START_MS + 500);
  });

  it("hands back a frozen lease that cannot be mutated to extend ownership", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const { lease } = expectStatus(manager.acquire("job:a"), "acquired");

    assert.ok(Object.isFrozen(lease));
    assert.throws(() => {
      (lease as { expiresAt: number }).expiresAt = START_MS + 10_000_000;
    }, TypeError);

    // The manager's own view of the expiry is unchanged by the attempt.
    clock.set(START_MS + DURATION_MS);
    expectStatus(manager.acquire("job:a"), "acquired");
  });
});

describe("a valid lease blocks competing acquisition", () => {
  it("reports busy and leaves the incumbent lease entirely untouched", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const held = expectStatus(manager.acquire("job:a"), "acquired");
    clock.advance(1_000);

    const blocked = expectStatus(manager.acquire("job:a"), "busy");

    assert.equal(blocked.heldUntil, held.lease.expiresAt);
    assert.equal(manager.size(), 1);

    // The incumbent's token still works, proving its lease was not overwritten
    // by the competing acquisition.
    const renewed = expectStatus(
      manager.renew("job:a", held.lease.ownerToken),
      "renewed"
    );
    assert.equal(renewed.lease.ownerToken, held.lease.ownerToken);
  });

  it("does not disclose the incumbent's token to the blocked caller", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const held = expectStatus(manager.acquire("job:a"), "acquired");
    const blocked = expectStatus(manager.acquire("job:a"), "busy");

    assert.deepStrictEqual(Object.keys(blocked).sort(), ["heldUntil", "status"]);
    assert.equal(
      JSON.stringify(blocked).includes(held.lease.ownerToken),
      false
    );
  });
});

describe("concurrent acquisition", () => {
  it("grants exactly one lease among many same-tick attempts", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const outcomes: AcquireOutcome[] = [];
    for (let index = 0; index < 100; index += 1) {
      outcomes.push(manager.acquire("job:contended"));
    }

    const acquired = outcomes.filter((o) => o.status === "acquired");
    const busy = outcomes.filter((o) => o.status === "busy");

    assert.equal(acquired.length, 1);
    assert.equal(busy.length, 99);
    assert.equal(manager.size(), 1);
  });

  it("grants exactly one lease among attempts racing as interleaved microtasks", async () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const outcomes = await raceAttempts(100, () =>
      manager.acquire("job:contended")
    );

    const acquired = outcomes.filter((o) => o.status === "acquired");
    assert.equal(acquired.length, 1);
    assert.equal(
      outcomes.filter((o) => o.status === "busy").length,
      99
    );

    // The single winner's token is the one the manager will honour.
    const winner = expectStatus(acquired[0]!, "acquired");
    expectStatus(manager.renew("job:contended", winner.lease.ownerToken), "renewed");
  });

  it("detects a check-and-set that suspends between its read and its write", async () => {
    // Control for the two tests above: the same harness, run against a manager
    // whose only defect is a suspension point inside the critical section. If
    // the harness could not actually interleave attempts, this would report a
    // single winner too, and the tests above would prove nothing.
    class RaceProneManager {
      private readonly leases = new Map<string, number>();

      constructor(
        private readonly clock: Clock,
        private readonly durationMs: number
      ) {}

      public async acquire(resource: string): Promise<"acquired" | "busy"> {
        const now = this.clock.now();
        const expiresAt = this.leases.get(resource);

        if (expiresAt !== undefined && expiresAt > now) {
          return "busy";
        }

        await Promise.resolve(); // the defect
        this.leases.set(resource, now + this.durationMs);
        return "acquired";
      }
    }

    const raceProne = new RaceProneManager(testClock(), DURATION_MS);
    const outcomes = await raceAttempts(100, () =>
      raceProne.acquire("job:contended")
    );

    assert.ok(
      outcomes.filter((o) => o === "acquired").length > 1,
      "harness failed to interleave attempts, so it cannot prove atomicity"
    );
  });
});

describe("ownership token strength", () => {
  function tokensFrom(count: number): string[] {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });
    const tokens: string[] = [];

    for (let index = 0; index < count; index += 1) {
      const outcome = expectStatus(manager.acquire(`job:${index}`), "acquired");
      tokens.push(outcome.lease.ownerToken);
      // Release so the manager's resource cap is never the thing under test.
      manager.release(`job:${index}`, outcome.lease.ownerToken);
    }

    return tokens;
  }

  it("is generated with node:crypto randomBytes and never Math.random", () => {
    // Uniqueness alone cannot separate a CSPRNG from Math.random, so assert on
    // the generation call itself in the compiled module.
    const compiled = readFileSync(new URL("./index.js", import.meta.url), "utf8");

    assert.match(compiled, /import\s*\{[^}]*randomBytes[^}]*\}\s*from\s*"node:crypto"/);
    assert.match(compiled, /randomBytes\(\s*TOKEN_BYTE_LENGTH\s*\)/);
    assert.equal(compiled.includes("Math.random"), false);
  });

  it("renders 32 bytes of entropy as a 43-character base64url token", () => {
    for (const token of tokensFrom(50)) {
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(Buffer.from(token, "base64url").length, 32);
    }
  });

  it("never repeats a token across a large sample", () => {
    const tokens = tokensFrom(10_000);
    assert.equal(new Set(tokens).size, tokens.length);
  });

  it("produces evenly balanced token bits", () => {
    // Catches a truncated, constant-prefixed, or otherwise low-entropy source
    // that a uniqueness check would still pass. Over 2,000 tokens the set-bit
    // ratio sits within roughly 0.0007 of 0.5, so a 0.01 tolerance is far from
    // flaky while still failing loudly on a degenerate generator.
    let setBits = 0;
    let totalBits = 0;

    for (const token of tokensFrom(2_000)) {
      for (const byte of Buffer.from(token, "base64url")) {
        setBits += (byte.toString(2).match(/1/g) ?? []).length;
        totalBits += 8;
      }
    }

    const ratio = setBits / totalBits;
    assert.ok(
      Math.abs(ratio - 0.5) < 0.01,
      `set-bit ratio ${ratio} is not consistent with a uniform source`
    );
  });
});

describe("renewal by the valid owner", () => {
  it("extends the expiry to a full duration measured from the renewal time", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const held = expectStatus(manager.acquire("job:a"), "acquired");
    assert.equal(held.lease.expiresAt, START_MS + DURATION_MS);

    clock.advance(10_000);
    const renewed = expectStatus(
      manager.renew("job:a", held.lease.ownerToken),
      "renewed"
    );

    // Measured from now, not stacked onto the previous expiry: repeated
    // renewals must not push the lease further and further into the future.
    assert.equal(renewed.lease.expiresAt, START_MS + 10_000 + DURATION_MS);
    assert.notEqual(renewed.lease.expiresAt, held.lease.expiresAt + DURATION_MS);
    assert.equal(renewed.lease.ownerToken, held.lease.ownerToken);
    assert.equal(renewed.lease.acquiredAt, START_MS);
  });

  it("keeps the lease alive past its original expiry", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const held = expectStatus(manager.acquire("job:a"), "acquired");

    clock.advance(DURATION_MS - 1);
    expectStatus(manager.renew("job:a", held.lease.ownerToken), "renewed");

    clock.advance(DURATION_MS - 1);
    expectStatus(manager.acquire("job:a"), "busy");
  });

  it("honours a per-renewal duration override", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const held = expectStatus(manager.acquire("job:a"), "acquired");
    clock.advance(1_000);

    const renewed = expectStatus(
      manager.renew("job:a", held.lease.ownerToken, 5_000),
      "renewed"
    );
    assert.equal(renewed.lease.expiresAt, START_MS + 1_000 + 5_000);
  });

  it("reports not-found for a resource that was never leased", () => {
    const manager = new LeaseManager({
      leaseDurationMs: DURATION_MS,
      clock: testClock(),
    });

    expectStatus(manager.renew("job:never", "a".repeat(43)), "not-found");
  });

  it("reports expired rather than silently reacquiring a lapsed lease", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const held = expectStatus(manager.acquire("job:a"), "acquired");
    clock.advance(DURATION_MS);

    expectStatus(manager.renew("job:a", held.lease.ownerToken), "expired");

    // Renewal must not have resurrected the lease: the resource is free, and
    // the old token no longer refers to anything.
    const reacquired = expectStatus(manager.acquire("job:a"), "acquired");
    assert.notEqual(reacquired.lease.ownerToken, held.lease.ownerToken);
  });
});

describe("rejecting invalid owners", () => {
  it("rejects renewal with a wrong token and leaves the expiry unchanged", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const held = expectStatus(manager.acquire("job:a"), "acquired");
    // A token of identical length from a genuine acquisition, so the constant
    // time comparison is exercised rather than the length shortcut.
    const impostor = expectStatus(manager.acquire("job:b"), "acquired");

    clock.advance(1_000);
    expectStatus(
      manager.renew("job:a", impostor.lease.ownerToken),
      "ownership-mismatch"
    );

    const blocked = expectStatus(manager.acquire("job:a"), "busy");
    assert.equal(blocked.heldUntil, held.lease.expiresAt);
  });

  it("rejects release with a wrong token and leaves the lease held", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const held = expectStatus(manager.acquire("job:a"), "acquired");
    const impostor = expectStatus(manager.acquire("job:b"), "acquired");

    expectStatus(
      manager.release("job:a", impostor.lease.ownerToken),
      "ownership-mismatch"
    );

    const blocked = expectStatus(manager.acquire("job:a"), "busy");
    assert.equal(blocked.heldUntil, held.lease.expiresAt);

    // Only the true owner can give it up.
    expectStatus(manager.release("job:a", held.lease.ownerToken), "released");
    expectStatus(manager.acquire("job:a"), "acquired");
  });

  it("rejects tokens of the wrong length without throwing", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    expectStatus(manager.acquire("job:a"), "acquired");

    expectStatus(manager.renew("job:a", "short"), "ownership-mismatch");
    expectStatus(manager.release("job:a", "short"), "ownership-mismatch");
  });

  it("reports not-found for releasing a resource with no lease", () => {
    const manager = new LeaseManager({
      leaseDurationMs: DURATION_MS,
      clock: testClock(),
    });

    expectStatus(manager.release("job:never", "a".repeat(43)), "not-found");
  });

  it("reports a double release distinctly from a successful one", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const held = expectStatus(manager.acquire("job:a"), "acquired");

    expectStatus(manager.release("job:a", held.lease.ownerToken), "released");
    expectStatus(manager.release("job:a", held.lease.ownerToken), "not-found");
  });
});

describe("reacquisition after expiry", () => {
  it("lets a lapsed resource be reacquired with a fresh token", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const first = expectStatus(manager.acquire("job:a"), "acquired");

    clock.advance(DURATION_MS + 1);

    const second = expectStatus(manager.acquire("job:a"), "acquired");

    assert.notEqual(second.lease.ownerToken, first.lease.ownerToken);
    assert.equal(second.lease.acquiredAt, START_MS + DURATION_MS + 1);
    assert.equal(
      second.lease.expiresAt,
      START_MS + DURATION_MS + 1 + DURATION_MS
    );
    assert.equal(manager.size(), 1);
  });

  it("reports expired when releasing a lapsed lease nobody has reclaimed", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const held = expectStatus(manager.acquire("job:a"), "acquired");
    clock.advance(DURATION_MS + 1);

    expectStatus(manager.release("job:a", held.lease.ownerToken), "expired");
    assert.equal(manager.size(), 0);
  });
});

describe("stale owners cannot disturb a replacement lease", () => {
  /** Acquire, let it lapse, let a second caller take over. */
  function afterHandover(): {
    clock: TestClock;
    manager: LeaseManager;
    stale: string;
    current: { ownerToken: string; expiresAt: number };
  } {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const first = expectStatus(manager.acquire("job:a"), "acquired");
    clock.advance(DURATION_MS + 1);
    const second = expectStatus(manager.acquire("job:a"), "acquired");

    assert.notEqual(second.lease.ownerToken, first.lease.ownerToken);

    return {
      clock,
      manager,
      stale: first.lease.ownerToken,
      current: {
        ownerToken: second.lease.ownerToken,
        expiresAt: second.lease.expiresAt,
      },
    };
  }

  it("rejects a stale token's release and leaves the replacement lease intact", () => {
    const { manager, stale, current } = afterHandover();

    expectStatus(manager.release("job:a", stale), "ownership-mismatch");

    // The replacement must be untouched: still held, still the same expiry,
    // still renewable by its own owner.
    const blocked = expectStatus(manager.acquire("job:a"), "busy");
    assert.equal(blocked.heldUntil, current.expiresAt);
    assert.equal(manager.size(), 1);

    const renewed = expectStatus(
      manager.renew("job:a", current.ownerToken),
      "renewed"
    );
    assert.equal(renewed.lease.ownerToken, current.ownerToken);
  });

  it("rejects a stale token's renewal and does not extend the replacement lease", () => {
    const { manager, stale, current } = afterHandover();

    expectStatus(manager.renew("job:a", stale), "ownership-mismatch");

    const blocked = expectStatus(manager.acquire("job:a"), "busy");
    assert.equal(blocked.heldUntil, current.expiresAt);
  });

  it("detects a release that deletes by resource without checking the owner", () => {
    // Control for the two tests above. This is the classic defect the stale
    // owner criterion exists to catch: a release keyed only on the resource
    // name silently destroys whichever lease is current. If the assertions
    // above were vacuous, they would pass against this too.
    class OwnerBlindManager {
      private readonly leases = new Map<string, string>();

      public acquire(resource: string, token: string): void {
        this.leases.set(resource, token);
      }

      public release(resource: string, _ownerToken: string): void {
        this.leases.delete(resource); // the defect
      }

      public isHeld(resource: string): boolean {
        return this.leases.has(resource);
      }
    }

    const blind = new OwnerBlindManager();
    blind.acquire("job:a", "token-b");
    blind.release("job:a", "stale-token-a");

    assert.equal(
      blind.isHeld("job:a"),
      false,
      "control did not exhibit the defect, so the assertions above prove nothing"
    );
  });
});

describe("expiry boundary under the injected clock", () => {
  it("treats a lease as valid one millisecond before its expiry", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const held = expectStatus(manager.acquire("job:a"), "acquired");

    clock.set(held.lease.expiresAt - 1);

    expectStatus(manager.acquire("job:a"), "busy");
    expectStatus(manager.renew("job:a", held.lease.ownerToken), "renewed");
  });

  it("treats a lease as already lapsed at exactly its expiry", () => {
    // Validity is `expiresAt > now`, so the interval is half-open: the instant
    // named by expiresAt is outside the lease.
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const held = expectStatus(manager.acquire("job:a"), "acquired");

    clock.set(held.lease.expiresAt);

    expectStatus(manager.renew("job:a", held.lease.ownerToken), "expired");

    const reacquired = expectStatus(manager.acquire("job:a"), "acquired");
    assert.notEqual(reacquired.lease.ownerToken, held.lease.ownerToken);
  });

  it("treats a lease as lapsed one millisecond after its expiry", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const held = expectStatus(manager.acquire("job:a"), "acquired");

    clock.set(held.lease.expiresAt + 1);

    expectStatus(manager.release("job:a", held.lease.ownerToken), "expired");
    expectStatus(manager.acquire("job:a"), "acquired");
  });

  it("re-reads the clock on every operation rather than caching validity", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const held = expectStatus(manager.acquire("job:a"), "acquired");

    clock.set(held.lease.expiresAt);
    expectStatus(manager.acquire("job:a"), "acquired");

    // Rewinding the clock must not resurrect the original lease; validity is
    // recomputed against the live reading, and the entry now holds a new lease.
    clock.set(START_MS);
    expectStatus(manager.renew("job:a", held.lease.ownerToken), "ownership-mismatch");
  });
});

describe("bounded memory", () => {
  it("never lets the tracked resource count exceed maxResources", () => {
    const clock = testClock();
    const manager = new LeaseManager({
      leaseDurationMs: DURATION_MS,
      clock,
      maxResources: 50,
      sweepIntervalMs: 1_000_000,
    });

    for (let index = 0; index < 50; index += 1) {
      expectStatus(manager.acquire(`job:${index}`), "acquired");
    }

    assert.equal(manager.size(), 50);

    const refused = expectStatus(manager.acquire("job:overflow"), "capacity-exhausted");
    assert.equal(refused.maxResources, 50);
    assert.equal(manager.size(), 50);
  });

  it("refuses a new resource rather than evicting a valid lease", () => {
    const clock = testClock();
    const manager = new LeaseManager({
      leaseDurationMs: DURATION_MS,
      clock,
      maxResources: 3,
      sweepIntervalMs: 1_000_000,
    });

    const held = [0, 1, 2].map((index) =>
      expectStatus(manager.acquire(`job:${index}`), "acquired")
    );

    expectStatus(manager.acquire("job:overflow"), "capacity-exhausted");

    // Every incumbent still holds its lease under its original token.
    for (const [index, outcome] of held.entries()) {
      const renewed = expectStatus(
        manager.renew(`job:${index}`, outcome.lease.ownerToken),
        "renewed"
      );
      assert.equal(renewed.lease.ownerToken, outcome.lease.ownerToken);
    }
  });

  it("reclaims lapsed entries to admit a new resource at the cap", () => {
    const clock = testClock();
    const manager = new LeaseManager({
      leaseDurationMs: DURATION_MS,
      clock,
      maxResources: 50,
      sweepIntervalMs: 1_000_000, // long enough that only the forced sweep can fire
    });

    for (let index = 0; index < 50; index += 1) {
      expectStatus(manager.acquire(`job:${index}`), "acquired");
    }

    clock.advance(DURATION_MS);

    // The pre-insertion sweep reclaims all 50 lapsed entries, so the new
    // resource is admitted and the map shrinks to just it.
    expectStatus(manager.acquire("job:fresh"), "acquired");
    assert.equal(manager.size(), 1);
  });

  it("reclaims lapsed entries on the interval during ordinary acquisitions", () => {
    const clock = testClock();
    const manager = new LeaseManager({
      leaseDurationMs: DURATION_MS,
      clock,
      maxResources: 10_000,
      sweepIntervalMs: 30_000,
    });

    for (let index = 0; index < 1_000; index += 1) {
      expectStatus(manager.acquire(`job:${index}`), "acquired");
    }
    assert.equal(manager.size(), 1_000);

    // Nowhere near the cap, so only the interval trigger can reclaim these.
    clock.advance(DURATION_MS + 30_000);
    expectStatus(manager.acquire("job:fresh"), "acquired");

    assert.equal(manager.size(), 1);
  });

  it("does not sweep before the interval has elapsed", () => {
    const clock = testClock();
    const manager = new LeaseManager({
      leaseDurationMs: 1_000,
      clock,
      sweepIntervalMs: 30_000,
    });

    expectStatus(manager.acquire("job:a"), "acquired");
    clock.advance(2_000); // lapsed, but the sweep interval has not elapsed

    expectStatus(manager.acquire("job:b"), "acquired");
    assert.equal(manager.size(), 2); // the lapsed entry is still resident

    // It is nonetheless treated as lapsed, because validity never depends on
    // whether cleanup has run yet.
    expectStatus(manager.acquire("job:a"), "acquired");
  });

  it("reports how many lapsed leases an explicit sweep removed", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    for (let index = 0; index < 10; index += 1) {
      expectStatus(manager.acquire(`job:${index}`), "acquired");
    }

    assert.equal(manager.sweep(), 0);
    assert.equal(manager.size(), 10);

    clock.advance(DURATION_MS);

    assert.equal(manager.sweep(), 10);
    assert.equal(manager.size(), 0);
  });

  it("never removes a valid lease during a sweep", () => {
    const clock = testClock();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS, clock });

    const shortLived = expectStatus(manager.acquire("job:short", 1_000), "acquired");
    const longLived = expectStatus(manager.acquire("job:long", 60_000), "acquired");

    clock.advance(2_000);

    assert.equal(manager.sweep(), 1);
    assert.equal(manager.size(), 1);

    expectStatus(manager.renew("job:long", longLived.lease.ownerToken), "renewed");
    expectStatus(manager.renew("job:short", shortLived.lease.ownerToken), "not-found");
  });
});

describe("input validation", () => {
  it("rejects an unusable resource name", () => {
    const manager = new LeaseManager({
      leaseDurationMs: DURATION_MS,
      clock: testClock(),
    });

    for (const resource of ["", null, undefined, 7] as unknown as string[]) {
      assert.throws(() => manager.acquire(resource), /resource must be a non-empty string/);
    }
  });

  it("rejects an unusable owner token", () => {
    const manager = new LeaseManager({
      leaseDurationMs: DURATION_MS,
      clock: testClock(),
    });

    for (const token of ["", null, undefined] as unknown as string[]) {
      assert.throws(
        () => manager.release("job:a", token),
        /ownerToken must be a non-empty string/
      );
    }
  });

  it("rejects durations that could not produce a usable expiry", () => {
    const invalid = [0, -1, 1.5, Number.NaN, Infinity, 2_147_483_648];

    for (const leaseDurationMs of invalid) {
      assert.throws(
        () => new LeaseManager({ leaseDurationMs, clock: testClock() }),
        /leaseDurationMs must be a positive safe integer/
      );
    }

    const manager = new LeaseManager({
      leaseDurationMs: DURATION_MS,
      clock: testClock(),
    });
    for (const leaseDurationMs of invalid) {
      assert.throws(
        () => manager.acquire("job:a", leaseDurationMs),
        /leaseDurationMs must be a positive safe integer/
      );
    }
  });

  it("rejects unusable bounds and clocks at construction", () => {
    assert.throws(
      () => new LeaseManager({ leaseDurationMs: DURATION_MS, maxResources: 0 }),
      /maxResources must be a positive safe integer/
    );
    assert.throws(
      () => new LeaseManager({ leaseDurationMs: DURATION_MS, sweepIntervalMs: -1 }),
      /sweepIntervalMs must be a positive safe integer/
    );
    assert.throws(
      () =>
        new LeaseManager({
          leaseDurationMs: DURATION_MS,
          clock: {} as unknown as Clock,
        }),
      /clock must be an object exposing a now\(\) method/
    );
  });

  it("rejects a clock reading that would make every lease look lapsed", () => {
    // A NaN reading makes `expiresAt > now` false everywhere, which would drop
    // mutual exclusion across every resource at once. It must fail loudly.
    let reading = START_MS;
    const manager = new LeaseManager({
      leaseDurationMs: DURATION_MS,
      clock: { now: () => reading },
    });

    const held = expectStatus(manager.acquire("job:a"), "acquired");

    reading = Number.NaN;
    assert.throws(
      () => manager.acquire("job:a"),
      /clock.now\(\) must return a finite number/
    );
    assert.throws(
      () => manager.renew("job:a", held.lease.ownerToken),
      /clock.now\(\) must return a finite number/
    );

    reading = START_MS + 1_000;
    expectStatus(manager.acquire("job:a"), "busy");
  });

  it("defaults to Date.now when no clock is injected", () => {
    const before = Date.now();
    const manager = new LeaseManager({ leaseDurationMs: DURATION_MS });
    const held = expectStatus(manager.acquire("job:a"), "acquired");
    const after = Date.now();

    assert.ok(held.lease.acquiredAt >= before && held.lease.acquiredAt <= after);
    assert.equal(held.lease.expiresAt, held.lease.acquiredAt + DURATION_MS);
  });

  it("treats prototype-shaped resource names as ordinary keys", () => {
    const manager = new LeaseManager({
      leaseDurationMs: DURATION_MS,
      clock: testClock(),
    });

    expectStatus(manager.acquire("__proto__"), "acquired");
    expectStatus(manager.acquire("constructor"), "acquired");
    expectStatus(manager.acquire("__proto__"), "busy");
    assert.equal(manager.size(), 2);
  });
});

describe("outcome typing", () => {
  it("supports exhaustive discrimination by status", () => {
    function describeAcquire(outcome: AcquireOutcome): string {
      switch (outcome.status) {
        case "acquired":
          return outcome.lease.ownerToken;
        case "busy":
          return String(outcome.heldUntil);
        case "capacity-exhausted":
          return String(outcome.maxResources);
        default: {
          const unreachable: never = outcome;
          return unreachable;
        }
      }
    }

    function describeRenew(outcome: RenewOutcome): string {
      switch (outcome.status) {
        case "renewed":
          return outcome.lease.ownerToken;
        case "not-found":
        case "expired":
        case "ownership-mismatch":
          return outcome.status;
        default: {
          const unreachable: never = outcome;
          return unreachable;
        }
      }
    }

    function describeRelease(outcome: ReleaseOutcome): string {
      switch (outcome.status) {
        case "released":
        case "not-found":
        case "expired":
        case "ownership-mismatch":
          return outcome.status;
        default: {
          const unreachable: never = outcome;
          return unreachable;
        }
      }
    }

    const manager = new LeaseManager({
      leaseDurationMs: DURATION_MS,
      clock: testClock(),
    });
    const held = expectStatus(manager.acquire("job:a"), "acquired");

    assert.equal(describeAcquire(manager.acquire("job:a")), String(held.lease.expiresAt));
    assert.equal(
      describeRenew(manager.renew("job:a", held.lease.ownerToken)),
      held.lease.ownerToken
    );
    assert.equal(describeRelease(manager.release("job:a", held.lease.ownerToken)), "released");
  });
});
