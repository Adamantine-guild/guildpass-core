import { TenureSignal } from '../src/signals/tenureSignal';
import type { SignalContext } from '../src/types';

function makeContext(weeksAgo: number): SignalContext {
  return {
    wallet: '0xabc123',
    communityId: 'community-1',
    joinedAt: new Date(Date.now() - weeksAgo * 7 * 24 * 60 * 60 * 1000),
    badgeCount: 0,
    attendanceCount: 0,
    roles: ['member'],
  };
}

describe('TenureSignal', () => {
  it('should compute zero points for a brand-new member', () => {
    const signal = new TenureSignal();
    const result = signal.compute(makeContext(0));
    expect(result.type).toBe('tenure');
    expect(result.points).toBe(0);
  });

  it('should compute 1 point per week (default)', () => {
    const signal = new TenureSignal();
    const result = signal.compute(makeContext(10));
    expect(result.points).toBe(10);
  });

  it('should cap at maxWeeks (default 52)', () => {
    const signal = new TenureSignal();
    const result = signal.compute(makeContext(100));
    expect(result.points).toBe(52);
  });

  it('should respect custom pointsPerWeek', () => {
    const signal = new TenureSignal({ pointsPerWeek: 2 });
    const result = signal.compute(makeContext(10));
    expect(result.points).toBe(20);
  });

  it('should apply weight multiplier', () => {
    const signal = new TenureSignal({ weight: 1.5 });
    const result = signal.compute(makeContext(10));
    expect(result.points).toBe(15);
  });

  it('should respect custom maxWeeks', () => {
    const signal = new TenureSignal({ maxWeeks: 4 });
    const result = signal.compute(makeContext(10));
    expect(result.points).toBe(4);
  });

  it('should handle future join date', () => {
    const signal = new TenureSignal();
    const ctx = makeContext(0);
    ctx.joinedAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const result = signal.compute(ctx);
    expect(result.points).toBe(0);
  });
});
