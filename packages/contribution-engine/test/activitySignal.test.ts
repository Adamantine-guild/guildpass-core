import { ActivitySignal } from '../src/signals/activitySignal';
import type { SignalContext } from '../src/types';

function makeContext(overrides?: Partial<SignalContext>): SignalContext {
  return {
    wallet: '0xabc123',
    communityId: 'community-1',
    joinedAt: new Date(Date.now() - 10 * 7 * 24 * 60 * 60 * 1000),
    badgeCount: 3,
    attendanceCount: 5,
    roles: ['member'],
    ...overrides,
  };
}

describe('ActivitySignal', () => {
  it('should return 0 points for no attendance', () => {
    const signal = new ActivitySignal();
    const result = signal.compute(makeContext({ attendanceCount: 0 }));
    expect(result.type).toBe('activity');
    expect(result.points).toBe(0);
    expect(result.explanation).toMatch(/No attendance/);
  });

  it('should award points proportional to attendance count', () => {
    const signal = new ActivitySignal({ pointsPerEvent: 10, halfLifeDays: 30 });
    const ctx = makeContext({
      attendanceCount: 10,
      joinedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    const result = signal.compute(ctx);
    expect(result.points).toBeGreaterThan(0);
    expect(result.type).toBe('activity');
  });

  it('should apply time decay — longer tenure reduces average decay', () => {
    const signal = new ActivitySignal({ pointsPerEvent: 10, halfLifeDays: 30 });

    // Short tenure (7 days) — recent events, less decay
    const shortCtx = makeContext({
      attendanceCount: 5,
      joinedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    });
    const shortResult = signal.compute(shortCtx);

    // Long tenure (90 days) — older average events, more decay
    const longCtx = makeContext({
      attendanceCount: 5,
      joinedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
    });
    const longResult = signal.compute(longCtx);

    // Short tenure should score higher (less decayed) than long tenure
    expect(shortResult.points).toBeGreaterThan(longResult.points);
  });

  it('should respect maxEvents cap', () => {
    const signal = new ActivitySignal({ maxEvents: 3, pointsPerEvent: 10 });
    const result = signal.compute(makeContext({ attendanceCount: 20 }));
    // Should cap at 3 events — fewer points than 20
    expect(result.explanation).toMatch(/capped/);
  });

  it('should apply weight multiplier', () => {
    const base = new ActivitySignal({ weight: 1.0, pointsPerEvent: 10 });
    const weighted = new ActivitySignal({ weight: 2.0, pointsPerEvent: 10 });
    const ctx = makeContext({
      attendanceCount: 5,
      joinedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    const baseResult = base.compute(ctx);
    const weightedResult = weighted.compute(ctx);
    expect(weightedResult.points).toBeCloseTo(baseResult.points * 2, 1);
  });

  it('should handle same-day membership', () => {
    const signal = new ActivitySignal();
    const result = signal.compute(makeContext({
      attendanceCount: 5,
      joinedAt: new Date(),
    }));
    expect(result.points).toBeGreaterThan(0);
  });
});
