import { BadgeSignal } from '../src/signals/badgeSignal';
import type { SignalContext } from '../src/types';

function makeContext(badgeCount: number): SignalContext {
  return {
    wallet: '0xabc123',
    communityId: 'community-1',
    joinedAt: new Date(Date.now() - 52 * 7 * 24 * 60 * 60 * 1000),
    badgeCount,
    attendanceCount: 0,
    roles: ['member'],
  };
}

describe('BadgeSignal', () => {
  it('should compute zero points for no badges', () => {
    const signal = new BadgeSignal();
    const result = signal.compute(makeContext(0));
    expect(result.type).toBe('badge_count');
    expect(result.points).toBe(0);
  });

  it('should compute 5 points per badge (default)', () => {
    const signal = new BadgeSignal();
    const result = signal.compute(makeContext(3));
    expect(result.points).toBe(15);
  });

  it('should apply weight multiplier', () => {
    const signal = new BadgeSignal({ weight: 2.0 });
    const result = signal.compute(makeContext(3));
    expect(result.points).toBe(30);
  });

  it('should respect custom pointsPerBadge', () => {
    const signal = new BadgeSignal({ pointsPerBadge: 10 });
    const result = signal.compute(makeContext(2));
    expect(result.points).toBe(20);
  });

  it('should cap at maxBadges when configured', () => {
    const signal = new BadgeSignal({ maxBadges: 5 });
    const result = signal.compute(makeContext(10));
    expect(result.points).toBe(25);
  });

  it('should produce correct explanation for zero badges', () => {
    const signal = new BadgeSignal();
    const result = signal.compute(makeContext(0));
    expect(result.explanation).toBe('No badges yet');
  });

  it('should produce correct explanation for multiple badges', () => {
    const signal = new BadgeSignal();
    const result = signal.compute(makeContext(3));
    expect(result.explanation).toContain('3 badge(s)');
  });
});
