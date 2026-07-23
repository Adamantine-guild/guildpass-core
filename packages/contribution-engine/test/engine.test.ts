import { ContributionEngine } from '../src/engine';
import type { ContributionSignal, SignalContext, SignalResult } from '../src/types';

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

function fakeSignal(type: string, points: number, weight = 1.0): ContributionSignal {
  return {
    type,
    weight,
    compute(_ctx: SignalContext): SignalResult {
      return { type, points, explanation: `${type}=${points}` };
    },
  };
}

describe('ContributionEngine', () => {
  it('should start with no signals', () => {
    const engine = new ContributionEngine();
    expect(engine.listSignalTypes()).toEqual([]);
  });

  it('should register and retrieve signals', () => {
    const engine = new ContributionEngine();
    const sig = fakeSignal('test', 10);
    engine.register(sig);
    expect(engine.listSignalTypes()).toEqual(['test']);
    expect(engine.getSignal('test')).toBe(sig);
  });

  it('should prevent duplicate signal registration', () => {
    const engine = new ContributionEngine();
    engine.register(fakeSignal('dup', 10));
    expect(() => engine.register(fakeSignal('dup', 20))).toThrow(
      /already registered/,
    );
  });

  it('should unregister signals', () => {
    const engine = new ContributionEngine();
    engine.register(fakeSignal('removable', 10));
    expect(engine.unregister('removable')).toBe(true);
    expect(engine.listSignalTypes()).toEqual([]);
  });

  it('should return false when unregistering unknown signal', () => {
    const engine = new ContributionEngine();
    expect(engine.unregister('nonexistent')).toBe(false);
  });

  it('should aggregate scores from multiple signals', () => {
    const engine = new ContributionEngine();
    engine.register(fakeSignal('a', 10));
    engine.register(fakeSignal('b', 20));

    const result = engine.computeScore(makeContext());
    expect(result.total).toBe(30);
    expect(result.breakdown).toEqual({ a: 10, b: 20 });
    expect(result.explanations).toEqual({ a: 'a=10', b: 'b=20' });
  });

  it('should handle zero signals', () => {
    const engine = new ContributionEngine();
    const result = engine.computeScore(makeContext());
    expect(result.total).toBe(0);
    expect(result.breakdown).toEqual({});
    expect(result.explanations).toEqual({});
  });

  it('should handle single signal', () => {
    const engine = new ContributionEngine();
    engine.register(fakeSignal('solo', 42));
    const result = engine.computeScore(makeContext());
    expect(result.total).toBe(42);
    expect(result.breakdown).toEqual({ solo: 42 });
  });

  it('should create default engine with tenure and badge_count signals', () => {
    const engine = createDefaultEngine();
    const types = engine.listSignalTypes();
    expect(types).toContain('tenure');
    expect(types).toContain('badge_count');
  });
});

// Import createDefaultEngine at the top (circular-safe: it's lazy inside the function)
import { createDefaultEngine } from '../src/engine';
