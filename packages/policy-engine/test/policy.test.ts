import { evaluate, resolveEffectiveRoles } from '../src';
import type { AccessPolicy, DecisionReason, RoleContext } from '@guildpass/shared-types';

const reasonCodes = (d: { reasons: DecisionReason[] }): string[] =>
  d.reasons.map((r) => r.code);

const baseCtx: RoleContext = {
  assignments: [{ role: 'admin', source: 'manual', active: true }],
  membershipState: 'active',
};

const policy = (rule: AccessPolicy['rule'], id = 'p1'): AccessPolicy => ({
  id,
  communityId: 'c1',
  resource: 'r1',
  rule,
});

describe('policy engine', () => {
  test('PUBLIC allows anyone', () => {
    const d = evaluate(policy('PUBLIC'), baseCtx);
    expect(d.allowed).toBe(true);
    expect(d.code).toBe('ALLOW');
  });

  test('ADMINS_ONLY denies non-admin', () => {
    const d = evaluate(policy('ADMINS_ONLY'), {
      ...baseCtx,
      assignments: [],
    });
    expect(d.allowed).toBe(false);
  });

  test('resolveEffectiveRoles adds member when active', () => {
    const roles = resolveEffectiveRoles(baseCtx);
    expect(roles).toContain('member');
    expect(roles).toContain('admin');
  });
});

describe('PUBLIC access', () => {
  test('allows with no roles and no membership', () => {
    const d = evaluate(policy('PUBLIC'), {
      assignments: [],
      membershipState: 'expired',
    });
    expect(d.allowed).toBe(true);
    expect(d.code).toBe('ALLOW');
    expect(reasonCodes(d)).toContain('RULE_PUBLIC');
  });

  test('still allows when user is suspended', () => {
    const d = evaluate(policy('PUBLIC'), {
      assignments: [{ role: 'member', source: 'auto', active: true }],
      membershipState: 'suspended',
    });
    expect(d.allowed).toBe(true);
  });
});

describe('MEMBERS_ONLY access', () => {
  test('allows active membership', () => {
    const d = evaluate(policy('MEMBERS_ONLY'), {
      ...baseCtx,
      assignments: [],
      membershipState: 'active',
    });
    expect(d.allowed).toBe(true);
    expect(d.code).toBe('ALLOW');
    expect(reasonCodes(d)).toContain('HAS_ACTIVE_MEMBERSHIP');
  });

  test('denies expired membership with predictable reason', () => {
    const d = evaluate(policy('MEMBERS_ONLY'), {
      ...baseCtx,
      assignments: [],
      membershipState: 'expired',
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('DENY');
    expect(reasonCodes(d)).toContain('NEEDS_ACTIVE');
  });

  test('denies invited membership with predictable reason', () => {
    const d = evaluate(policy('MEMBERS_ONLY'), {
      ...baseCtx,
      assignments: [],
      membershipState: 'invited',
    });
    expect(d.allowed).toBe(false);
    expect(reasonCodes(d)).toContain('NEEDS_ACTIVE');
  });

  test('denies suspended membership with predictable reason', () => {
    const d = evaluate(policy('MEMBERS_ONLY'), {
      ...baseCtx,
      assignments: [],
      membershipState: 'suspended',
    });
    expect(d.allowed).toBe(false);
    expect(reasonCodes(d)).toContain('NEEDS_ACTIVE');
  });
});

describe('ADMINS_ONLY access', () => {
  test('allows admin role', () => {
    const d = evaluate(policy('ADMINS_ONLY'), baseCtx);
    expect(d.allowed).toBe(true);
    expect(d.code).toBe('ALLOW');
    expect(reasonCodes(d)).toContain('HAS_ADMIN');
  });

  test('denies member-only with predictable reason', () => {
    const d = evaluate(policy('ADMINS_ONLY'), {
      ...baseCtx,
      assignments: [{ role: 'member', source: 'auto', active: true }],
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('DENY');
    expect(reasonCodes(d)).toContain('NEEDS_ADMIN');
  });

  test('denies contributor without admin', () => {
    const d = evaluate(policy('ADMINS_ONLY'), {
      ...baseCtx,
      assignments: [{ role: 'contributor', source: 'manual', active: true }],
    });
    expect(d.allowed).toBe(false);
    expect(reasonCodes(d)).toContain('NEEDS_ADMIN');
  });

  test('denies inactive admin assignment', () => {
    const d = evaluate(policy('ADMINS_ONLY'), {
      ...baseCtx,
      assignments: [{ role: 'admin', source: 'manual', active: false }],
    });
    expect(d.allowed).toBe(false);
  });
});

describe('CONTRIBUTORS_OR_ADMINS access', () => {
  test('allows contributor role', () => {
    const d = evaluate(policy('CONTRIBUTORS_OR_ADMINS'), {
      ...baseCtx,
      assignments: [{ role: 'contributor', source: 'manual', active: true }],
    });
    expect(d.allowed).toBe(true);
    expect(reasonCodes(d)).toContain('HAS_REQUIRED_ROLE');
  });

  test('allows admin role', () => {
    const d = evaluate(policy('CONTRIBUTORS_OR_ADMINS'), {
      ...baseCtx,
      assignments: [{ role: 'admin', source: 'manual', active: true }],
    });
    expect(d.allowed).toBe(true);
    expect(reasonCodes(d)).toContain('HAS_REQUIRED_ROLE');
  });

  test('denies member-only with predictable reason', () => {
    const d = evaluate(policy('CONTRIBUTORS_OR_ADMINS'), {
      ...baseCtx,
      assignments: [{ role: 'member', source: 'auto', active: true }],
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('DENY');
    expect(reasonCodes(d)).toContain('NEEDS_CONTRIBUTOR_OR_ADMIN');
  });

  test('denies no roles at all', () => {
    const d = evaluate(policy('CONTRIBUTORS_OR_ADMINS'), {
      assignments: [],
      membershipState: 'active',
    });
    expect(d.allowed).toBe(false);
    expect(reasonCodes(d)).toContain('NEEDS_CONTRIBUTOR_OR_ADMIN');
  });
});

describe('resolveEffectiveRoles', () => {
  test('returns empty array when no assignments and not active member', () => {
    const roles = resolveEffectiveRoles({
      assignments: [],
      membershipState: 'expired',
    });
    expect(roles).toEqual([]);
  });

  test('adds member when membership is active', () => {
    const roles = resolveEffectiveRoles({
      assignments: [],
      membershipState: 'active',
    });
    expect(roles).toEqual(['member']);
  });

  test('excludes inactive assignments', () => {
    const roles = resolveEffectiveRoles({
      assignments: [
        { role: 'admin', source: 'manual', active: false },
        { role: 'contributor', source: 'manual', active: true },
      ],
      membershipState: 'active',
    });
    expect(roles).toContain('contributor');
    expect(roles).toContain('member');
    expect(roles).not.toContain('admin');
  });

  test('deduplicates repeated roles', () => {
    const roles = resolveEffectiveRoles({
      assignments: [
        { role: 'admin', source: 'manual', active: true },
        { role: 'admin', source: 'auto', active: true },
      ],
      membershipState: 'active',
    });
    expect(roles.filter((r) => r === 'admin').length).toBe(1);
  });
});

describe('unknown rule fallback', () => {
  test('denies and reports RULE_UNHANDLED for unknown rule', () => {
    const unknownPolicy = {
      id: 'p1',
      communityId: 'c1',
      resource: 'r1',
      rule: 'NONEXISTENT_RULE',
    } as unknown as AccessPolicy;

    const d = evaluate(unknownPolicy, baseCtx);
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('DENY');
    expect(reasonCodes(d)).toContain('RULE_UNHANDLED');
  });
});
