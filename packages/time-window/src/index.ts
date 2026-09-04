/**
 * Deterministic time-window eligibility engine.
 *
 * A pure rule-evaluation primitive: evaluates whether an instant falls inside
 * one or more configured windows with explicit, deterministic boundary
 * semantics. No database, API, or domain dependencies.
 */

export interface TimeWindow {
  startsAt: Date;
  endsAt: Date;
  startInclusive: boolean;
  endInclusive: boolean;
}

export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

export class InvalidTimeWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTimeWindowError';
  }
}

function assertValidDate(d: unknown, label: string): Date {
  if (!(d instanceof Date) || isNaN(d.getTime())) {
    throw new InvalidTimeWindowError(`${label} is not a valid Date`);
  }
  return d;
}

/**
 * Validate a window. Throws InvalidTimeWindowError when:
 * - startsAt or endsAt is missing/invalid
 * - startsAt is strictly after endsAt (zero-length windows are allowed)
 */
export function validateWindow(w: TimeWindow): TimeWindow {
  if (!w || typeof w !== 'object') {
    throw new InvalidTimeWindowError('window must be an object');
  }
  const start = assertValidDate(w.startsAt, 'startsAt');
  const end = assertValidDate(w.endsAt, 'endsAt');
  if (start.getTime() > end.getTime()) {
    throw new InvalidTimeWindowError('startsAt must not be after endsAt');
  }
  return w;
}

function afterStart(t: number, w: TimeWindow): boolean {
  const s = w.startsAt.getTime();
  return w.startInclusive ? t >= s : t > s;
}

function beforeEnd(t: number, w: TimeWindow): boolean {
  const e = w.endsAt.getTime();
  return w.endInclusive ? t <= e : t < e;
}

/**
 * True if the instant t falls inside the window, honoring boundary flags.
 */
export function isWithinWindow(t: Date, w: TimeWindow): boolean {
  validateWindow(w);
  const time = assertValidDate(t, 'instant').getTime();
  return afterStart(time, w) && beforeEnd(time, w);
}

export type MultiWindowMode = 'any' | 'all';

/**
 * Evaluate an instant against multiple windows.
 * mode 'any': inside at least one window.
 * mode 'all': inside every window.
 * An empty list evaluates to true (vacuous for 'all', no window excludes for 'any').
 */
export function isWithinWindows(
  t: Date,
  windows: TimeWindow[],
  mode: MultiWindowMode = 'any',
): boolean {
  if (!Array.isArray(windows)) {
    throw new InvalidTimeWindowError('windows must be an array');
  }
  const time = assertValidDate(t, 'instant').getTime();
  if (windows.length === 0) {
    return true;
  }
  if (mode === 'all') {
    return windows.every((w) => {
      validateWindow(w);
      return afterStart(time, w) && beforeEnd(time, w);
    });
  }
  return windows.some((w) => {
    validateWindow(w);
    return afterStart(time, w) && beforeEnd(time, w);
  });
}

/**
 * True if the current time (per the provided clock) falls inside the window.
 */
export function isWindowActive(w: TimeWindow, clock: Clock = systemClock): boolean {
  return isWithinWindow(clock(), w);
}

/**
 * Merge overlapping or touching windows into a minimal set of maximal
 * non-overlapping windows. Edges of merged windows are inclusive if either
 * merged window was inclusive at that edge. Windows are validated first;
 * input order is irrelevant; output is sorted by start time.
 */
export function mergeWindows(windows: TimeWindow[]): TimeWindow[] {
  if (!Array.isArray(windows)) {
    throw new InvalidTimeWindowError('windows must be an array');
  }
  windows.forEach(validateWindow);

  const sorted = [...windows].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.endsAt.getTime() - b.endsAt.getTime(),
  );

  const merged: TimeWindow[] = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && overlapsOrTouch(last, w)) {
      if (w.endsAt.getTime() > last.endsAt.getTime()) {
        last.endsAt = w.endsAt;
        last.endInclusive = w.endInclusive;
      } else if (w.endsAt.getTime() === last.endsAt.getTime()) {
        last.endInclusive = last.endInclusive || w.endInclusive;
      }
      if (w.startsAt.getTime() === last.startsAt.getTime()) {
        last.startInclusive = last.startInclusive || w.startInclusive;
      }
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

function overlapsOrTouch(a: TimeWindow, b: TimeWindow): boolean {
  const aEnd = a.endsAt.getTime();
  const bStart = b.startsAt.getTime();

  if (bStart < aEnd) return true;
  if (bStart === aEnd) {
    // touching: they share a point only if inclusive on either side
    return a.endInclusive || b.startInclusive;
  }
  return false;
}
