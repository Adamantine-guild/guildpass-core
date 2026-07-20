/**
 * apiContractCompatibility.test.ts
 *
 * Contract-snapshot compatibility test suite.
 *
 * This test compares the current live API contract (extracted from Fastify
 * route schemas in schemas.ts) against the published versioned snapshot
 * checked into packages/shared-types/contracts/v1/schemas.json.
 *
 * If the test fails, it means an incompatible (breaking) change was introduced
 * without an accompanying version bump and new snapshot. See docs/API_VERSIONING.md
 * for the full stability policy.
 *
 * The intentionally-breaking test at the bottom demonstrates the mechanism:
 * it modifies a snapshot field to trigger a failure, proving the guard works.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  diffContracts,
  type ContractSnapshot,
  type EndpointContract,
  type JsonSchema,
} from '../../../packages/shared-types/src/contractDiff';
import {
  accessCheckSchema,
  getMembershipsSchema,
  getMemberProfileSchema,
  assignMemberRoleSchema,
  removeMemberRoleSchema,
  createAccessOverrideSchema,
  revokeAccessOverrideSchema,
  listCommunityMembersSchema,
} from '../src/schemas';

// ---------------------------------------------------------------------------
// Snapshot loading
// ---------------------------------------------------------------------------

const SNAPSHOT_PATH = path.resolve(
  __dirname,
  '../../../packages/shared-types/contracts/v1/schemas.json',
);

function loadSnapshot(): ContractSnapshot {
  const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf-8');
  return JSON.parse(raw) as ContractSnapshot;
}

// ---------------------------------------------------------------------------
// Schema extraction — produce a ContractSnapshot from Fastify route schemas
// ---------------------------------------------------------------------------

/**
 * Strip Fastify-only metadata (summary, tags, description) and return only
 * the pure JSON Schema shape.
 */
function extractPureJsonSchema(raw: Record<string, unknown>): JsonSchema {
  const result: Record<string, unknown> = {};
  const keys = [
    'type', 'required', 'properties', 'items', 'enum', 'nullable',
    'format', 'pattern', 'description', 'oneOf', 'additionalProperties',
    '$ref',
  ];
  for (const key of keys) {
    if (raw[key] !== undefined) result[key] = raw[key];
  }
  return result;
}

function extractSuccessResponse(
  responseMap: Record<string, unknown> | undefined,
): JsonSchema {
  if (!responseMap) return {};
  const schema200 = responseMap['200'] as Record<string, unknown> | undefined;
  if (schema200) return extractPureJsonSchema(schema200);
  return {};
}

function buildEndpoint(
  method: string,
  contractPath: string,
  schema: Record<string, unknown>,
): EndpointContract {
  const body = schema.body as Record<string, unknown> | undefined;
  const response = schema.response as Record<string, unknown> | undefined;

  const contract: EndpointContract = {
    method,
    path: contractPath,
    successResponse: extractSuccessResponse(response),
  };

  if (body) {
    contract.requestBody = extractPureJsonSchema(body);
  }

  return contract;
}

function extractCurrentContract(): ContractSnapshot {
  const sharedComponents: Record<string, JsonSchema> = {
    WalletAddress: {
      type: 'string',
      pattern: '^0x[0-9a-fA-F]{40}$',
    },
    MembershipState: {
      type: 'string',
      enum: ['invited', 'active', 'expired', 'suspended'],
    },
    Role: {
      type: 'string',
      enum: ['admin', 'member', 'contributor'],
    },
    ErrorResponse: {
      type: 'object',
      required: ['error', 'code', 'message', 'statusCode'],
      properties: {
        error: { type: 'string' },
        code: { type: 'string' },
        message: { type: 'string' },
        statusCode: { type: 'integer' },
        details: {
          oneOf: [{ type: 'string' }, { type: 'object' }],
        },
      },
    },
    ForbiddenResponse: {
      type: 'object',
      required: ['error'],
      properties: {
        error: { type: 'string' },
      },
    },
  };

  const endpoints: Record<string, EndpointContract> = {
    'POST /v1/access/check': buildEndpoint(
      'POST',
      '/v1/access/check',
      accessCheckSchema as unknown as Record<string, unknown>,
    ),
    'GET /v1/communities/:communityId/memberships/:wallet': buildEndpoint(
      'GET',
      '/v1/communities/{communityId}/memberships/{wallet}',
      getMembershipsSchema as unknown as Record<string, unknown>,
    ),
    'GET /v1/communities/:communityId/members/:wallet': buildEndpoint(
      'GET',
      '/v1/communities/{communityId}/members/{wallet}',
      getMemberProfileSchema as unknown as Record<string, unknown>,
    ),
    'POST /v1/communities/:communityId/members/:wallet/roles': buildEndpoint(
      'POST',
      '/v1/communities/{communityId}/members/{wallet}/roles',
      assignMemberRoleSchema as unknown as Record<string, unknown>,
    ),
    'DELETE /v1/communities/:communityId/members/:wallet/roles/:role': buildEndpoint(
      'DELETE',
      '/v1/communities/{communityId}/members/{wallet}/roles/{role}',
      removeMemberRoleSchema as unknown as Record<string, unknown>,
    ),
    'POST /v1/communities/:communityId/overrides': buildEndpoint(
      'POST',
      '/v1/communities/{communityId}/overrides',
      createAccessOverrideSchema as unknown as Record<string, unknown>,
    ),
    'DELETE /v1/communities/:communityId/overrides/:wallet/:resource': buildEndpoint(
      'DELETE',
      '/v1/communities/{communityId}/overrides/{wallet}/{resource}',
      revokeAccessOverrideSchema as unknown as Record<string, unknown>,
    ),
    'GET /v1/communities/:communityId/members': buildEndpoint(
      'GET',
      '/v1/communities/{communityId}/members',
      listCommunityMembersSchema as unknown as Record<string, unknown>,
    ),
  };

  return {
    version: '1.0.0',
    snapshotDate: new Date().toISOString().slice(0, 10),
    description: 'Extracted from current Fastify route schemas',
    sharedComponents,
    endpoints,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('API Contract Compatibility', () => {
  let snapshot: ContractSnapshot;
  let current: ContractSnapshot;

  beforeAll(() => {
    snapshot = loadSnapshot();
    current = extractCurrentContract();
  });

  test('snapshot file exists and is valid JSON', () => {
    expect(fs.existsSync(SNAPSHOT_PATH)).toBe(true);
    expect(snapshot.version).toBe('1.0.0');
    expect(snapshot.sharedComponents).toBeDefined();
    expect(snapshot.endpoints).toBeDefined();
  });

  test('current contract has all expected endpoints', () => {
    const expectedEndpoints = [
      'POST /v1/access/check',
      'GET /v1/communities/:communityId/memberships/:wallet',
      'GET /v1/communities/:communityId/members/:wallet',
      'POST /v1/communities/:communityId/members/:wallet/roles',
      'DELETE /v1/communities/:communityId/members/:wallet/roles/:role',
      'POST /v1/communities/:communityId/overrides',
      'DELETE /v1/communities/:communityId/overrides/:wallet/:resource',
      'GET /v1/communities/:communityId/members',
    ];
    for (const ep of expectedEndpoints) {
      expect(current.endpoints[ep]).toBeDefined();
    }
  });

  test('current contract is backward-compatible with the published snapshot', () => {
    const result = diffContracts(snapshot, current);

    if (result.breaking.length > 0) {
      const summary = result.breaking
        .map((b) => `  - [${b.type}] ${b.path}: ${b.detail}`)
        .join('\n');
      fail(
        `Breaking API contract changes detected without a version bump:\n${summary}\n\n` +
          'To fix: either revert the change, or bump the version and create a new snapshot.\n' +
          'See docs/API_VERSIONING.md for the stability policy.',
      );
    }
  });

  test('reports additive changes (informational)', () => {
    const result = diffContracts(snapshot, current);
    // Additive changes are expected and logged for visibility
    if (result.additive.length > 0) {
      const summary = result.additive
        .map((a) => `  - [${a.type}] ${a.path}: ${a.detail}`)
        .join('\n');
      // This is informational — additive changes are allowed without a bump
      console.log(`Additive contract changes detected:\n${summary}`);
    }
    // The test passes — additive changes are fine
    expect(true).toBe(true);
  });

  test('snapshot and current have matching endpoint keys', () => {
    const snapshotKeys = Object.keys(snapshot.endpoints).sort();
    const currentKeys = Object.keys(current.endpoints).sort();

    const removed = snapshotKeys.filter((k) => !currentKeys.includes(k));
    const added = currentKeys.filter((k) => !snapshotKeys.includes(k));

    if (removed.length > 0) {
      fail(
        `Endpoints present in snapshot but missing from current contract:\n${removed.join('\n')}`,
      );
    }

    if (added.length > 0) {
      // New endpoints are additive — just log them
      console.log(`New endpoints not yet in snapshot: ${added.join(', ')}`);
    }
  });

  test('access check response shape matches snapshot', () => {
    const snapshotAccessCheck = snapshot.endpoints['POST /v1/access/check'];
    const currentAccessCheck = current.endpoints['POST /v1/access/check'];

    expect(snapshotAccessCheck).toBeDefined();
    expect(currentAccessCheck).toBeDefined();

    // Verify the critical AccessDecision fields are present
    const snapResp = snapshotAccessCheck.successResponse as Record<string, unknown>;
    const currResp = currentAccessCheck.successResponse as Record<string, unknown>;
    const snapProps = snapResp.properties as Record<string, unknown>;
    const currProps = currResp.properties as Record<string, unknown>;

    // Core fields that external systems depend on
    for (const field of ['allowed', 'code', 'reasons', 'membershipState']) {
      expect(currProps[field]).toBeDefined();
      expect(snapProps[field]).toBeDefined();
    }
  });

  test('role mutation result shape matches snapshot', () => {
    const snapshotAssignRole = snapshot.endpoints['POST /v1/communities/:communityId/members/:wallet/roles'];
    const currentAssignRole = current.endpoints['POST /v1/communities/:communityId/members/:wallet/roles'];

    expect(snapshotAssignRole).toBeDefined();
    expect(currentAssignRole).toBeDefined();

    const snapResp = snapshotAssignRole.successResponse as Record<string, unknown>;
    const currResp = currentAssignRole.successResponse as Record<string, unknown>;
    const snapProps = snapResp.properties as Record<string, unknown>;
    const currProps = currResp.properties as Record<string, unknown>;

    for (const field of ['communityId', 'wallet', 'role', 'assigned', 'removed']) {
      expect(currProps[field]).toBeDefined();
      expect(snapProps[field]).toBeDefined();
    }
  });

  test('access override mutation result shape matches snapshot', () => {
    const snapshotOverride = snapshot.endpoints['POST /v1/communities/:communityId/overrides'];
    const currentOverride = current.endpoints['POST /v1/communities/:communityId/overrides'];

    expect(snapshotOverride).toBeDefined();
    expect(currentOverride).toBeDefined();

    const snapResp = snapshotOverride.successResponse as Record<string, unknown>;
    const currResp = currentOverride.successResponse as Record<string, unknown>;
    const snapProps = snapResp.properties as Record<string, unknown>;
    const currProps = currResp.properties as Record<string, unknown>;

    for (const field of ['communityId', 'wallet', 'resource', 'effect', 'created', 'removed']) {
      expect(currProps[field]).toBeDefined();
      expect(snapProps[field]).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Intentionally-breaking test — demonstrates the contract guard works
// ---------------------------------------------------------------------------

describe('API Contract Compatibility — Breaking Change Detection', () => {
  test('detects a removed required response field as breaking', () => {
    const snapshot = loadSnapshot();
    const current = extractCurrentContract();

    // Simulate removing the 'allowed' field from access check response
    // This would be a breaking change for any consumer
    const accessCheck = current.endpoints['POST /v1/access/check'];
    const resp = accessCheck.successResponse as Record<string, unknown>;
    const props = resp.properties as Record<string, unknown>;
    delete props.allowed;

    const result = diffContracts(snapshot, current);

    expect(result.isCompatible).toBe(false);
    expect(
      result.breaking.some(
        (b) => b.type === 'removed_field' && b.path.includes('allowed'),
      ),
    ).toBe(true);
  });

  test('detects a type change as breaking', () => {
    const snapshot = loadSnapshot();
    const current = extractCurrentContract();

    // Simulate changing 'allowed' from boolean to string
    const accessCheck = current.endpoints['POST /v1/access/check'];
    const resp = accessCheck.successResponse as Record<string, unknown>;
    const props = resp.properties as Record<string, unknown>;
    (props.allowed as Record<string, unknown>).type = 'string';

    const result = diffContracts(snapshot, current);

    expect(result.isCompatible).toBe(false);
    expect(
      result.breaking.some(
        (b) => b.type === 'type_changed' && b.path.includes('allowed'),
      ),
    ).toBe(true);
  });

  test('detects an enum narrowing as breaking', () => {
    const snapshot = loadSnapshot();
    const current = extractCurrentContract();

    // Simulate removing 'DENY' from the access code enum
    const accessCheck = current.endpoints['POST /v1/access/check'];
    const resp = accessCheck.successResponse as Record<string, unknown>;
    const props = resp.properties as Record<string, unknown>;
    const codeSchema = props.code as Record<string, unknown>;
    codeSchema.enum = ['ALLOW']; // removed 'DENY'

    const result = diffContracts(snapshot, current);

    expect(result.isCompatible).toBe(false);
    expect(
      result.breaking.some(
        (b) => b.type === 'enum_narrowed' && b.path.includes('code'),
      ),
    ).toBe(true);
  });

  test('detects a new required request field as breaking', () => {
    const snapshot = loadSnapshot();
    const current = extractCurrentContract();

    // Simulate adding a new required field to access check request
    const accessCheck = current.endpoints['POST /v1/access/check'];
    const body = accessCheck.requestBody as Record<string, unknown>;
    const bodyRequired = body.required as string[];
    bodyRequired.push('extraField');

    const bodyProps = body.properties as Record<string, unknown>;
    bodyProps.extraField = { type: 'string' };

    const result = diffContracts(snapshot, current);

    expect(result.isCompatible).toBe(false);
    expect(
      result.breaking.some(
        (b) => b.type === 'request_required_added' && b.detail.includes('extraField'),
      ),
    ).toBe(true);
  });

  test('detects a removed endpoint as breaking', () => {
    const snapshot = loadSnapshot();
    const current = extractCurrentContract();

    // Simulate removing an endpoint
    delete current.endpoints['POST /v1/access/check'];

    const result = diffContracts(snapshot, current);

    expect(result.isCompatible).toBe(false);
    expect(
      result.breaking.some(
        (b) => b.type === 'removed_endpoint' && b.path.includes('access/check'),
      ),
    ).toBe(true);
  });

  test('allows adding new optional response fields (additive)', () => {
    const snapshot = loadSnapshot();
    const current = extractCurrentContract();

    // Simulate adding a new optional field
    const accessCheck = current.endpoints['POST /v1/access/check'];
    const resp = accessCheck.successResponse as Record<string, unknown>;
    const props = resp.properties as Record<string, unknown>;
    props.debugInfo = { type: 'string', nullable: true };

    const result = diffContracts(snapshot, current);

    expect(result.isCompatible).toBe(true);
    expect(
      result.additive.some(
        (a) => a.type === 'added_optional_field' && a.path.includes('debugInfo'),
      ),
    ).toBe(true);
  });

  test('allows adding new enum values (additive)', () => {
    const snapshot = loadSnapshot();
    const current = extractCurrentContract();

    // Simulate adding a new role value
    const roleComponent = current.sharedComponents.Role;
    const roleEnum = roleComponent.enum as string[];
    roleEnum.push('moderator');

    const result = diffContracts(snapshot, current);

    expect(result.isCompatible).toBe(true);
    expect(
      result.additive.some(
        (a) => a.type === 'enum_widened' && a.detail.includes('moderator'),
      ),
    ).toBe(true);
  });

  test('allows adding new endpoints (additive)', () => {
    const snapshot = loadSnapshot();
    const current = extractCurrentContract();

    // Simulate adding a new endpoint
    current.endpoints['GET /v1/communities/:communityId/badges'] = {
      method: 'GET',
      path: '/v1/communities/{communityId}/badges',
      successResponse: {
        type: 'object',
        required: ['badges'],
        properties: {
          badges: { type: 'array', items: { type: 'object' } },
        },
      },
    };

    const result = diffContracts(snapshot, current);

    expect(result.isCompatible).toBe(true);
    expect(
      result.additive.some(
        (a) => a.type === 'added_endpoint' && a.path.includes('badges'),
      ),
    ).toBe(true);
  });
});
