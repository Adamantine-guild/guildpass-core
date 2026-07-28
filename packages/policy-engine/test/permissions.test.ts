import { evaluate, resolveEffectivePermissions } from '../src';
import type {
  AccessPolicy,
  Permission,
  RoleContext,
  RoleDefinition,
} from '@guildpass/shared-types';

const policy = (
  ruleType: string,
  requiredPermissions?: Permission[],
): AccessPolicy => ({
  id: 'policy-1',
  communityId: 'community-1',
  resource: 'articles',
  ruleType,
  requiredPermissions,
});

const moderator: RoleDefinition = {
  id: 'moderator-id',
  name: 'moderator',
  communityId: 'community-1',
  permissions: ['resource:create', 'member:remove'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const moderatorContext: RoleContext = {
  assignments: [{
    role: 'member',
    roleDefinitionId: moderator.id,
    source: 'manual',
    active: true,
  }],
  membershipState: 'active',
};

describe('granular governance permissions', () => {
  it('allows when a custom role grants every required permission', () => {
    const decision = evaluate(
      policy('MEMBERS_ONLY', ['resource:create', 'member:remove']),
      moderatorContext,
      { roleDefinitions: [moderator] },
    );

    expect(decision.allowed).toBe(true);
    expect(decision.reasons.map((reason) => reason.code))
      .toContain('HAS_REQUIRED_PERMISSIONS');
  });

  it('denies when any required permission is missing', () => {
    const decision = evaluate(
      policy('MEMBERS_ONLY', ['resource:create', 'resource:archive']),
      moderatorContext,
      { roleDefinitions: [moderator] },
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasons.map((reason) => reason.code))
      .toContain('MISSING_REQUIRED_PERMISSIONS');
  });

  it('requires both the legacy rule and permissions', () => {
    const decision = evaluate(
      policy('ADMINS_ONLY', ['resource:create']),
      moderatorContext,
      { roleDefinitions: [moderator] },
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasons.map((reason) => reason.code)).toContain('NEEDS_ADMIN');
    expect(decision.reasons.map((reason) => reason.code))
      .toContain('HAS_REQUIRED_PERMISSIONS');
  });

  it('inherits permissions through a custom-role parent', () => {
    const editor: RoleDefinition = {
      ...moderator,
      id: 'editor-id',
      name: 'editor',
      parentRoleId: moderator.id,
      permissions: ['resource:archive'],
    };
    const context: RoleContext = {
      ...moderatorContext,
      assignments: [{
        role: 'member',
        roleDefinitionId: editor.id,
        source: 'manual',
        active: true,
      }],
    };

    expect(evaluate(
      policy('MEMBERS_ONLY', ['member:remove', 'resource:archive']),
      context,
      { roleDefinitions: [moderator, editor] },
    ).allowed).toBe(true);
  });

  it('accepts pre-resolved permissions from a context', () => {
    expect(evaluate(
      policy('PUBLIC', ['policy:manage']),
      {
        assignments: [],
        membershipState: 'expired',
        permissions: ['policy:manage'],
      },
    ).allowed).toBe(true);
  });

  it('keeps explicit access overrides as the highest precedence', () => {
    const decision = evaluate(
      policy('PUBLIC', ['member:remove']),
      {
        assignments: [],
        membershipState: 'expired',
        wallet: '0xabc',
        communityId: 'community-1',
        resource: 'articles',
        overrides: [{
          wallet: '0xabc',
          communityId: 'community-1',
          resource: 'articles',
          effect: 'ALLOW',
        }],
      },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reasons.map((reason) => reason.code)).toContain('OVERRIDE_ALLOW');
  });

  it('treats an empty persisted permission array as no requirement', () => {
    const decision = evaluate(
      { ...policy('PUBLIC'), requiredPermissions: [] },
      moderatorContext,
      { roleDefinitions: [moderator] },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reasons.map((reason) => reason.code)).toContain('RULE_PUBLIC');
  });

  it('deduplicates directly and role-resolved permissions', () => {
    expect(resolveEffectivePermissions(
      { ...moderatorContext, permissions: ['resource:create'] },
      ['moderator', 'member'],
      [moderator],
    )).toEqual(['member:remove', 'resource:create']);
  });
});

describe('legacy policy compatibility', () => {
  it.each([
    ['PUBLIC', { assignments: [], membershipState: 'expired' } as RoleContext, true],
    ['MEMBERS_ONLY', { assignments: [], membershipState: 'active' } as RoleContext, true],
    ['ADMINS_ONLY', {
      assignments: [{ role: 'admin', source: 'manual', active: true }],
      membershipState: 'active',
    } as RoleContext, true],
    ['CONTRIBUTORS_OR_ADMINS', {
      assignments: [{ role: 'contributor', source: 'manual', active: true }],
      membershipState: 'active',
    } as RoleContext, true],
  ])('%s remains unchanged when requiredPermissions is omitted', (rule, context, allowed) => {
    expect(evaluate(policy(rule), context).allowed).toBe(allowed);
  });
});
