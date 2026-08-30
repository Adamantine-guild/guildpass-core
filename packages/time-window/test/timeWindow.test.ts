/**
 * Unit tests for the deterministic time-window engine.
 *
 * All boundary tests use fixed, exact timestamps (no sleeps, no reliance on
 * wall-clock time except through the explicit injectable clock).
 */

import {
  isWithinWindow,
  isWithinWindows,
  isWindowActive,
  validateWindow,
  mergeWindows,
  InvalidTimeWindowError,
  systemClock,
  type TimeWindow,
  type Clock,
} from '../src';

/** Fixed UTC instants used across tests. */
const T0 = new Date('2026-06-01T12:00:00.000Z'); // window start
const T1 = new Date('2026-06-10T12:00:00.000Z'); // window end
const BEFORE = new Date('2026-05-01T00:00:00.000Z');
const MIDDLE = new Date('2026-06-05T12:00:00.000Z');
const AFTER = new Date('2026-07-01T00:00:00.000Z');

function window(overrides: Partial<TimeWindow> = {}): TimeWindow {
  return {
    startsAt: T0,
    endsAt: T1,
    startInclusive: true,
    endInclusive: true,
    ...overrides,
  };
}

describe('validateWindow', () => {
  test('accepts a well-formed window', () => {
    expect(() => validateWindow(window())).not.toThrow();
  });

  test('accepts a zero-length window (start equals end)', () => {
    expect(() =>
      validateWindow(window({ startsAt: T0, endsAt: new Date(T0.getTime()) })),
    ).not.toThrow();
  });

  test('rejects a reversed window (start after end)', () => {
    expect(() =>
      validateWindow(
        window({
          startsAt: T1,
          endsAt: T0,
        }),
      ),
    ).toThrow(InvalidTimeWindowError);
  });

  test('rejects invalid dates safely', () => {
    expect(() =>
      validateWindow(window({ startsAt: new Date('not-a-date') })),
    ).toThrow(InvalidTimeWindowError);
    expect(() =>
      validateWindow(window({ endsAt: new Date(NaN) })),
    ).toThrow(InvalidTimeWindowError);
  });

  test('rejects non-date values', () => {
    expect(() =>
      validateWindow(window({ startsAt: '2026-06-01T12:00:00.000Z' as unknown as Date })),
    ).toThrow(InvalidTimeWindowError);
    expect(() =>
      validateWindow(window({ endsAt: null as unknown as Date })),
    ).toThrow(InvalidTimeWindowError);
  });
});

describe('isWithinWindow — inclusive boundaries', () => {
  const w = window(); // both boundaries inclusive

  test('start boundary instant is inside', () => {
    expect(isWithinWindow(T0, w)).toBe(true);
  });

  test('end boundary instant is inside', () => {
    expect(isWithinWindow(T1, w)).toBe(true);
  });

  test('instant inside the window is inside', () => {
    expect(isWithinWindow(MIDDLE, w)).toBe(true);
  });

  test('instant before the window is outside', () => {
    expect(isWithinWindow(BEFORE, w)).toBe(false);
  });

  test('instant after the window is outside', () => {
    expect(isWithinWindow(AFTER, w)).toBe(false);
  });
});

describe('isWithinWindow — exclusive start boundary', () => {
  const w = window({ startInclusive: false });

  test('exact start instant is excluded', () => {
    expect(isWithinWindow(T0, w)).toBe(false);
  });

  test('one millisecond after start is included', () => {
    expect(isWithinWindow(new Date(T0.getTime() + 1), w)).toBe(true);
  });

  test('instant before start is still excluded', () => {
    expect(isWithinWindow(BEFORE, w)).toBe(false);
  });
});

describe('isWithinWindow — exclusive end boundary', () => {
  const w = window({ endInclusive: false });

  test('exact end instant is excluded', () => {
    expect(isWithinWindow(T1, w)).toBe(false);
  });

  test('one millisecond before end is included', () => {
    expect(isWithinWindow(new Date(T1.getTime() - 1), w)).toBe(true);
  });

  test('instant after end is still excluded', () => {
    expect(isWithinWindow(AFTER, w)).toBe(false);
  });
});

describe('isWithinWindow — both boundaries exclusive', () => {
  const w = window({ startInclusive: false, endInclusive: false });

  test('both exact boundary instants are excluded', () => {
    expect(isWithinWindow(T0, w)).toBe(false);
    expect(isWithinWindow(T1, w)).toBe(false);
  });

  test('strictly interior instants are included', () => {
    expect(isWithinWindow(MIDDLE, w)).toBe(true);
  });
});

describe('isWithinWindow — zero-length window', () => {
  test('inclusive on both ends contains exactly its single instant', () => {
    const w = window({ startsAt: T0, endsAt: new Date(T0.getTime()) });
    expect(isWithinWindow(T0, w)).toBe(true);
    expect(isWithinWindow(new Date(T0.getTime() + 1), w)).toBe(false);
  });

  test('exclusive on either end contains nothing', () => {
    const startExcl = window({
      startsAt: T0,
      endsAt: new Date(T0.getTime()),
      startInclusive: false,
    });
    const endExcl = window({
      startsAt: T0,
      endsAt: new Date(T0.getTime()),
      endInclusive: false,
    });
    expect(isWithinWindow(T0, startExcl)).toBe(false);
    expect(isWithinWindow(T0, endExcl)).toBe(false);
  });
});

describe('isWithinWindow — validation is enforced on evaluation', () => {
  test('reversed window is rejected during evaluation', () => {
    expect(() =>
      isWithinWindow(MIDDLE, window({ startsAt: T1, endsAt: T0 })),
    ).toThrow(InvalidTimeWindowError);
  });

  test('invalid instant date is rejected safely', () => {
    expect(() => isWithinWindow(new Date('nope'), window())).toThrow(
      InvalidTimeWindowError,
    );
  });
});

describe('UTC normalisation', () => {
  // Three different representations of the exact same instant:
  //  1. UTC ISO string
  //  2. Date.UTC numeric components
  //  3. ISO string with an explicit -04:00 offset
  const viaUtcString = new Date('2026-06-05T12:00:00.000Z');
  const viaDateUtc = new Date(Date.UTC(2026, 5, 5, 12, 0, 0, 0));
  const viaOffsetString = new Date('2026-06-05T08:00:00.000-04:00');

  test('different representations denote the same epoch instant', () => {
    expect(viaUtcString.getTime()).toBe(viaDateUtc.getTime());
    expect(viaUtcString.getTime()).toBe(viaOffsetString.getTime());
  });

  test('same instant evaluates identically regardless of representation', () => {
    const w = window({ startInclusive: false, endInclusive: false });
    expect(isWithinWindow(viaUtcString, w)).toBe(true);
    expect(isWithinWindow(viaDateUtc, w)).toBe(true);
    expect(isWithinWindow(viaOffsetString, w)).toBe(true);
  });

  test('boundary instants expressed with offsets behave identically', () => {
    // 2026-06-01T12:00:00Z expressed as 08:00-04:00
    const startViaOffset = new Date('2026-06-01T08:00:00.000-04:00');
    const inclusive = window();
    const startExclusive = window({ startInclusive: false });

    expect(isWithinWindow(startViaOffset, inclusive)).toBe(true);
    expect(isWithinWindow(startViaOffset, startExclusive)).toBe(false);
  });

  test('window edges defined with offsets compare as UTC instants', () => {
    const w: TimeWindow = {
      startsAt: new Date('2026-06-01T00:00:00.000-08:00'), // 08:00Z
      endsAt: new Date('2026-06-01T12:00:00.000+01:00'), // 11:00Z
      startInclusive: true,
      endInclusive: true,
    };
    expect(isWithinWindow(new Date('2026-06-01T08:00:00.000Z'), w)).toBe(true); // exactly start
    expect(isWithinWindow(new Date('2026-06-01T11:00:00.000Z'), w)).toBe(true); // exactly end
    expect(isWithinWindow(new Date('2026-06-01T11:00:00.001Z'), w)).toBe(false);
    expect(isWithinWindow(new Date('2026-06-01T07:59:59.999Z'), w)).toBe(false);
  });
});

describe('isWithinWindows — multiple-window semantics', () => {
  const first = window({ startsAt: T0, endsAt: T1 });
  const second = window({
    startsAt: new Date('2026-07-01T12:00:00.000Z'),
    endsAt: new Date('2026-07-10T12:00:00.000Z'),
  });

  test("'any' mode: inside at least one window", () => {
    expect(isWithinWindows(MIDDLE, [first, second], 'any')).toBe(true);
    expect(
      isWithinWindows(new Date('2026-07-05T12:00:00.000Z'), [first, second], 'any'),
    ).toBe(true);
    expect(isWithinWindows(BEFORE, [first, second], 'any')).toBe(false);
  });

  test("'any' mode is the default", () => {
    expect(isWithinWindows(MIDDLE, [first, second])).toBe(true);
    expect(isWithinWindows(BEFORE, [first, second])).toBe(false);
  });

  test("'all' mode: inside every window", () => {
    const overlapping = window({ startsAt: T0, endsAt: new Date('2026-06-20T12:00:00.000Z') });
    const wider = window({ startsAt: BEFORE, endsAt: AFTER });

    expect(isWithinWindows(MIDDLE, [overlapping, wider], 'all')).toBe(true);
    expect(isWithinWindows(AFTER, [overlapping, wider], 'all')).toBe(false);
  });

  test("'all' mode is false when even one window excludes the instant", () => {
    const a = window();
    const b = window({ startsAt: AFTER, endsAt: new Date('2026-08-01T00:00:00.000Z') });
    expect(isWithinWindows(MIDDLE, [a, b], 'all')).toBe(false);
  });

  test('empty window list: true for both modes (deterministic)', () => {
    expect(isWithinWindows(MIDDLE, [], 'any')).toBe(true);
    expect(isWithinWindows(MIDDLE, [], 'all')).toBe(true);
  });

  test('boundary handling stays exact in multi-window mode', () => {
    const exclusive = window({ startInclusive: false });
    expect(isWithinWindows(T0, [exclusive], 'any')).toBe(false);
    expect(isWithinWindows(T0, [exclusive], 'all')).toBe(false);
  });

  test('validates every window it evaluates', () => {
    const reversed = window({ startsAt: T1, endsAt: T0 });
    expect(() => isWithinWindows(MIDDLE, [reversed], 'any')).toThrow(
      InvalidTimeWindowError,
    );
    expect(() => isWithinWindows(MIDDLE, [reversed], 'all')).toThrow(
      InvalidTimeWindowError,
    );
  });
});

describe('isWindowActive — injectable clock', () => {
  test('uses the injected clock for current-time evaluation', () => {
    const w = window();
    const during: Clock = () => MIDDLE;
    const before: Clock = () => BEFORE;
    const after: Clock = () => AFTER;

    expect(isWindowActive(w, during)).toBe(true);
    expect(isWindowActive(w, before)).toBe(false);
    expect(isWindowActive(w, after)).toBe(false);
  });

  test('fixed clock avoids real time entirely (no sleeps needed)', () => {
    const w = window();
    const fixed: Clock = () => T1;
    // Deterministic: repeated evaluation cannot drift with a fixed clock.
    expect(isWindowActive(w, fixed)).toBe(true);
    expect(isWindowActive(w, fixed)).toBe(true);
  });

  test('respects boundary flags with the injected clock', () => {
    const w = window({ endInclusive: false });
    const atEnd: Clock = () => T1;
    expect(isWindowActive(w, atEnd)).toBe(false);
  });

  test('defaults to the system clock', () => {
    const farFuture = window({
      startsAt: new Date(systemClock().getTime() + 365 * 24 * 60 * 60 * 1000),
      endsAt: new Date(systemClock().getTime() + 366 * 24 * 60 * 60 * 1000),
    });
    expect(isWindowActive(farFuture)).toBe(false);
  });
});

describe('mergeWindows', () => {
  test('returns an empty array for an empty input', () => {
    expect(mergeWindows([])).toEqual([]);
  });

  test('returns a single window unchanged', () => {
    const w = window();
    expect(mergeWindows([w])).toEqual([w]);
  });

  test('merges overlapping windows into one maximal window', () => {
    const a = window({ startsAt: T0, endsAt: new Date('2026-06-05T00:00:00.000Z') });
    const b = window({
      startsAt: new Date('2026-06-04T00:00:00.000Z'),
      endsAt: new Date('2026-06-08T00:00:00.000Z'),
    });
    const merged = mergeWindows([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0].startsAt.getTime()).toBe(T0.getTime());
    expect(merged[0].endsAt.getTime()).toBe(new Date('2026-06-08T00:00:00.000Z').getTime());
  });

  test('merges windows that touch when the shared edge is inclusive', () => {
    const a = window({
      startsAt: T0,
      endsAt: T1,
      endInclusive: true,
    });
    const b = window({
      startsAt: T1,
      endsAt: new Date('2026-06-20T00:00:00.000Z'),
      startInclusive: true,
    });
    const merged = mergeWindows([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0].endsAt.getTime()).toBe(new Date('2026-06-20T00:00:00.000Z').getTime());
  });

  test('does not merge windows that touch when both shared edges are exclusive', () => {
    const a = window({ endsAt: T1, endInclusive: false });
    const b = window({ startsAt: T1, startInclusive: false });
    const merged = mergeWindows([a, b]);
    expect(merged).toHaveLength(2);
  });

  test('leaves disjoint windows unmerged, sorted by start', () => {
    const late = window({
      startsAt: new Date('2026-08-01T00:00:00.000Z'),
      endsAt: new Date('2026-08-02T00:00:00.000Z'),
    });
    const early = window();
    const merged = mergeWindows([late, early]);
    expect(merged).toHaveLength(2);
    expect(merged[0].startsAt.getTime()).toBe(early.startsAt.getTime());
    expect(merged[1].startsAt.getTime()).toBe(late.startsAt.getTime());
  });

  test('keeps the union when one window fully contains another', () => {
    const outer = window({ startsAt: T0, endsAt: T1 });
    const inner = window({
      startsAt: new Date('2026-06-03T00:00:00.000Z'),
      endsAt: new Date('2026-06-06T00:00:00.000Z'),
    });
    const merged = mergeWindows([outer, inner, outer]);
    expect(merged).toHaveLength(1);
    expect(merged[0].startsAt.getTime()).toBe(T0.getTime());
    expect(merged[0].endsAt.getTime()).toBe(T1.getTime());
  });

  test('merged edges are inclusive if either contributing edge was inclusive', () => {
    const a = window({
      startsAt: T0,
      endsAt: new Date('2026-06-05T00:00:00.000Z'),
      endInclusive: true,
    });
    const b = window({
      startsAt: new Date('2026-06-05T00:00:00.000Z'),
      endsAt: new Date('2026-06-08T00:00:00.000Z'),
      endInclusive: false,
    });
    const merged = mergeWindows([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0].endInclusive).toBe(false); // later end wins with its own flag
    expect(merged[0].startsAt.getTime()).toBe(T0.getTime());
  });

  test('rejects invalid windows before merging', () => {
    const reversed = window({ startsAt: T1, endsAt: T0 });
    expect(() => mergeWindows([reversed])).toThrow(InvalidTimeWindowError);
  });

  test('merged result contains exactly the points of the input union', () => {
    // Property-style check across a few configurations: a probe instant is
    // inside some input window iff it is inside some merged window.
    const inputs = [
      window({ startsAt: T0, endsAt: T1, startInclusive: true, endInclusive: false }),
      window({
        startsAt: new Date('2026-06-10T12:00:00.000Z'),
        endsAt: new Date('2026-06-15T00:00:00.000Z'),
        startInclusive: true,
        endInclusive: true,
      }),
      window({
        startsAt: new Date('2026-07-01T00:00:00.000Z'),
        endsAt: new Date('2026-07-02T00:00:00.000Z'),
      }),
    ];
    const merged = mergeWindows(inputs);

    const probes = [
      new Date('2026-05-31T23:59:59.999Z'),
      T0,
      MIDDLE,
      new Date(T1.getTime() - 1),
      T1,
      new Date(T1.getTime() + 1),
      new Date('2026-06-14T23:59:59.999Z'),
      new Date('2026-06-15T00:00:00.000Z'),
      new Date('2026-06-15T00:00:00.001Z'),
      new Date('2026-07-01T00:00:00.000Z'),
      new Date('2026-07-02T00:00:00.000Z'),
      new Date('2026-07-02T00:00:00.001Z'),
    ];

    for (const p of probes) {
      const before = inputs.some((w) => isWithinWindow(p, w));
      const after = merged.some((w) => isWithinWindow(p, w));
      expect(after).toBe(before);
    }
  });
});
