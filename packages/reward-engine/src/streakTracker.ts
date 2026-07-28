import type { StreakPeriod, StreakState } from "./types";

const DAY_MS = 86_400_000;

function dayNumber(date: Date): number {
  return Math.floor(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  ) / DAY_MS);
}

export function periodIndex(date: Date, period: StreakPeriod): number {
  if (period === "daily") return dayNumber(date);
  if (period === "weekly") {
    // ISO-style weeks anchored to Monday 1970-01-05.
    return Math.floor((dayNumber(date) - 4) / 7);
  }
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

export function periodKey(date: Date, period: StreakPeriod): string {
  return `${period}:${periodIndex(date, period)}`;
}

export class StreakTracker {
  constructor(readonly period: StreakPeriod = "weekly") {}

  record(previous: StreakState | null, occurredAt: Date): StreakState {
    const nextIndex = periodIndex(occurredAt, this.period);
    const nextKey = periodKey(occurredAt, this.period);
    if (!previous || previous.lastPeriodKey === null) {
      return { period: this.period, current: 1, longest: 1, lastPeriodKey: nextKey };
    }
    const previousIndex = Number(previous.lastPeriodKey.split(":")[1]);
    if (nextIndex <= previousIndex) return previous;
    const current = nextIndex === previousIndex + 1 ? previous.current + 1 : 1;
    return {
      period: this.period,
      current,
      longest: Math.max(previous.longest, current),
      lastPeriodKey: nextKey,
    };
  }
}
