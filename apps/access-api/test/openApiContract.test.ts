/**
 * openApiContract.test.ts
 *
 * Contract-test suite for the GuildPass Access API.
 *
 * Strategy
 * ────────
 * 1. Load `docs/openapi.json` — the single source of truth for the API contract.
 * 2. Resolve every `$ref` inline so AJV can compile schemas without a registry.
 * 3. Spin up a Fastify instance with fully-mocked services (app.inject(), no DB,
 *    no network, no Prisma) that returns representative fixture data for each route.
 * 4. For every documented /v1 route × response-code pair, send the documented
 *    request and validate the actual JSON body against the corresponding schema.
 * 5. Fail clearly (with full AJV error detail) when a response body diverges from
 *    its documented schema.
 *
 * How to run
 * ──────────
 *   npm run -w access-api test
 *
 * The test file deliberately covers every path/status combination in openapi.json.
 * When you add a new route:
 *   1. Regenerate docs/openapi.json (npm run -w access-api openapi:generate)
 *   2. Add the corresponding fixture + test block below.
 */

import * as fs from 'fs';
import * as path from 'path';
import Fastify, { type FastifyInstance } from 'fastify';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

// ---------------------------------------------------------------------------
// 1. OpenAPI spec loading + $ref resolution
// ---------------------------------------------------------------------------

const OPENAPI_PATH = path.resolve(__dirname, '../../../docs/openapi.json');

interface OpenApiSpec {
  openapi: string;
  components: { schemas: Record<string, unknown> };
  paths: Record<
    string,
    Record<
      string,
      {
        responses: Record<string, { content?: { 'application/json'?: { schema?: unknown } } }>;
      }
    >
  >;
}

function loadSpec(): OpenApiSpec {
  const raw = fs.readFileSync(OPENAPI_PATH, 'utf-8');
  return JSON.parse(raw) as OpenApiSpec;
}

/**
 * Recursively resolve `$ref` values of the form `#/components/schemas/<Name>`
 * by substituting the referenced schema in-place.
 * The spec uses no external $refs, so a simple recursive walk is sufficient.
 */
function deref(node: unknown, components: Record<string, unknown>): unknown {
  if (node === null || typeof node !== 'object') return node;

  if (Array.isArray(node)) {
    return node.map((item) => deref(item, components));
  }

  const obj = node as Record<string, unknown>;

  if (typeof obj['$ref'] === 'string') {
    const refPath = obj['$ref'] as string; // e.g. "#/components/schemas/ErrorResponse"
    const schemaName = refPath.replace('#/components/schemas/', '');
    const resolved = components[schemaName];
    if (!resolved) {
      throw new Error(`Cannot resolve $ref: ${refPath}`);
    }
    return deref(resolved, components);
  }

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    result[key] = deref(obj[key], components);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 2. AJV validator factory
// ---------------------------------------------------------------------------

/**
 * Compile a JSON Schema (with $refs already resolved) into an AJV validator.
 *
 * AJV is configured to:
 *  - Understand `nullable: true` (OpenAPI 3.0 extension) — handled by strict:false
 *  - Validate `format: date-time` and `format: uuid` via ajv-formats
 *  - Be lenient about extra properties (only enforces what the spec declares required)
 *
 * Note: `strict: false` tells AJV 8 to silently ignore unknown OpenAPI keywords
 * such as `nullable`, `description`, and `tags` without throwing errors.
 * ajv-formats adds date-time/uuid format validators.
 */
function buildAjv(): Ajv {
  const ajv = new Ajv({
    allErrors: true,
    strict: false, // silently accept OpenAPI-specific keywords (nullable, description, etc.)
  });
  addFormats(ajv);
  return ajv;
}

/**
 * Returns an AJV-compiled validator for the given schema.
 * Throws a descriptive error if the schema is invalid.
 */
function compileSchema(ajv: Ajv, schema: unknown, label: string) {
  try {
    return ajv.compile(schema as object);
  } catch (err) {
    throw new Error(`Failed to compile schema for "${label}": ${(err as Error).message}`);
  }
}

/**
 * Assert that `body` conforms to `schema`.
 * On failure, formats AJV errors into a readable message and throws.
 */
function assertConformsToSchema(
  validate: ReturnType<Ajv['compile']>,
  body: unknown,
  label: string,
): void {
  // For nullable schemas: treat null as valid if the field is nullable
  const valid = validate(body);
  if (!valid) {
    const errors = validate.errors ?? [];
    const detail = errors
      .map((e) => `  • ${e.instancePath || '(root)'} ${e.message}${e.params ? ' — ' + JSON.stringify(e.params) : ''}`)
      .join('\n');
    throw new Error(
      `[Contract violation] Response body for "${label}" does not match its documented OpenAPI schema.\n` +
        `Schema errors:\n${detail}\n\n` +
        `Actual body: ${JSON.stringify(body, null, 2)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Shared fixtures
// ---------------------------------------------------------------------------

const WALLET = '0x1234567890abcdef1234567890abcdef12345678';
const COMMUNITY = 'community-1';
const RESOURCE = 'dashboard';
const DL_EVENT_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const NEW_EVENT_ID = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

const fixtures = {
  memberships200: {
    wallet: WALLET,
    communities: [{ communityId: COMMUNITY, state: 'active', expiresAt: null }],
  },
  error404: {
    error: 'NOT_FOUND',
    code: 'NOT_FOUND',
    message: 'Wallet not found',
    statusCode: 404,
  },
  memberProfile200: {
    communityId: COMMUNITY,
    profile: { id: 'p1', displayName: 'Alice', bio: null, avatarUrl: null },
    membership: { state: 'active', expiresAt: null },
    roles: ['admin'],
  },
  error400: {
    error: 'VALIDATION_ERROR',
    code: 'VALIDATION_ERROR',
    message: 'Validation failed',
    statusCode: 400,
  },
  memberNotFound404: {
    error: 'NOT_FOUND',
    code: 'NOT_FOUND',
    message: 'Member not found',
    statusCode: 404,
  },
  roleMutation200: {
    communityId: COMMUNITY,
    wallet: WALLET,
    role: 'admin',
    assigned: true,
    removed: false,
    message: 'Role assigned',
  },
  roleRemoved200: {
    communityId: COMMUNITY,
    wallet: WALLET,
    role: 'admin',
    assigned: false,
    removed: true,
    message: 'Role removed',
  },
  forbidden403: { error: 'Forbidden' },
  override200: {
    communityId: COMMUNITY,
    wallet: WALLET,
    resource: RESOURCE,
    effect: 'ALLOW',
    created: true,
    removed: false,
  },
  overrideRevoked200: {
    communityId: COMMUNITY,
    wallet: WALLET,
    resource: RESOURCE,
    effect: 'DENY',
    created: false,
    removed: true,
  },
  accessAllow200: {
    allowed: true,
    code: 'ALLOW',
    reasons: [{ code: 'ACTIVE_MEMBER', message: 'Wallet is an active member' }],
    effectiveRoles: ['admin'],
    membershipState: 'active',
  },
  communityMembers200: {
    members: [
      { wallet: '0x1111111111111111111111111111111111111111', displayName: 'Alice', state: 'active', roles: ['admin'] },
      { wallet: '0x2222222222222222222222222222222222222222', displayName: 'Bob', state: 'active', roles: ['member'] },
    ],
  },
  deadLetterEvents200: {
    events: [
      {
        id: DL_EVENT_ID,
        originalEventId: NEW_EVENT_ID,
        eventType: 'MEMBERSHIP_CREATED',
        entityId: null,
        entityType: null,
        communityId: COMMUNITY,
        payload: { key: 'value' },
        failureReason: 'Webhook timeout',
        retryCount: 3,
        status: 'pending',
        createdAt: '2024-01-15T10:30:00.000Z',
        resolvedAt: null,
      },
    ],
  },
  retryEvent200: { newEventId: NEW_EVENT_ID },
  deadLetterNotFound404: {
    error: 'NOT_FOUND',
    code: 'NOT_FOUND',
    message: 'Dead-letter event not found',
    statusCode: 404,
  },
  healthLive200: { status: 'ok', version: '1.0.0' },
  healthReady200: { status: 'ok', db: 'reachable' },
};

// ---------------------------------------------------------------------------
// 4. Contract test app (mocked services, no Prisma, no network)
// ---------------------------------------------------------------------------

/**
 * Build a Fastify instance where every documented route is registered with
 * a mock handler. Each handler's default response is the 200-case fixture.
 * To trigger an error code, the test sends a special trigger header or payload.
 *
 * Trigger conventions (to keep the app simple and deterministic):
 *   x-contract-trigger: 404   → return the 404 fixture for routes that document it
 *   x-contract-trigger: 400   → return the 400 fixture
 *   x-contract-trigger: 403   → return the 403 fixture
 *   x-contract-trigger: 404   → return the 404 fixture
 */
async function buildContractTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  function getTrigger(request: any): number | null {
    const h = request.headers['x-contract-trigger'];
    return h ? parseInt(h as string, 10) : null;
  }

  // --- Health routes ---

  app.get('/health/live', async (_req, reply) => {
    return reply.status(200).send(fixtures.healthLive200);
  });

  app.get('/health/ready', async (_req, reply) => {
    return reply.status(200).send(fixtures.healthReady200);
  });

  // --- GET /v1/communities/:communityId/memberships/:wallet ---

  app.get('/v1/communities/:communityId/memberships/:wallet', async (req, reply) => {
    const trigger = getTrigger(req);
    if (trigger === 404) return reply.status(404).send(fixtures.error404);
    return reply.status(200).send(fixtures.memberships200);
  });

  // --- GET /v1/communities/:communityId/members/:wallet ---

  app.get('/v1/communities/:communityId/members/:wallet', async (req, reply) => {
    const trigger = getTrigger(req);
    if (trigger === 400) return reply.status(400).send(fixtures.error400);
    if (trigger === 404) return reply.status(404).send(fixtures.memberNotFound404);
    return reply.status(200).send(fixtures.memberProfile200);
  });

  // --- POST /v1/communities/:communityId/members/:wallet/roles ---

  app.post('/v1/communities/:communityId/members/:wallet/roles', async (req, reply) => {
    const trigger = getTrigger(req);
    if (trigger === 400) return reply.status(400).send(fixtures.error400);
    if (trigger === 403) return reply.status(403).send(fixtures.forbidden403);
    return reply.status(200).send(fixtures.roleMutation200);
  });

  // --- DELETE /v1/communities/:communityId/members/:wallet/roles/:role ---

  app.delete('/v1/communities/:communityId/members/:wallet/roles/:role', async (req, reply) => {
    const trigger = getTrigger(req);
    if (trigger === 400) return reply.status(400).send(fixtures.error400);
    if (trigger === 403) return reply.status(403).send(fixtures.forbidden403);
    return reply.status(200).send(fixtures.roleRemoved200);
  });

  // --- POST /v1/communities/:communityId/overrides ---

  app.post('/v1/communities/:communityId/overrides', async (req, reply) => {
    const trigger = getTrigger(req);
    if (trigger === 400) return reply.status(400).send(fixtures.error400);
    if (trigger === 403) return reply.status(403).send(fixtures.forbidden403);
    return reply.status(200).send(fixtures.override200);
  });

  // --- DELETE /v1/communities/:communityId/overrides/:wallet/:resource ---

  app.delete('/v1/communities/:communityId/overrides/:wallet/:resource', async (req, reply) => {
    const trigger = getTrigger(req);
    if (trigger === 403) return reply.status(403).send(fixtures.forbidden403);
    return reply.status(200).send(fixtures.overrideRevoked200);
  });

  // --- POST /v1/access/check ---

  app.post('/v1/access/check', async (req, reply) => {
    const trigger = getTrigger(req);
    if (trigger === 400) return reply.status(400).send(fixtures.error400);
    return reply.status(200).send(fixtures.accessAllow200);
  });

  // --- GET /v1/communities/:communityId/members ---

  app.get('/v1/communities/:communityId/members', async (req, reply) => {
    const trigger = getTrigger(req);
    if (trigger === 403) return reply.status(403).send(fixtures.forbidden403);
    return reply.status(200).send(fixtures.communityMembers200);
  });

  // --- GET /v1/communities/:communityId/dead-letter-events ---

  app.get('/v1/communities/:communityId/dead-letter-events', async (req, reply) => {
    const trigger = getTrigger(req);
    if (trigger === 403) return reply.status(403).send(fixtures.forbidden403);
    return reply.status(200).send(fixtures.deadLetterEvents200);
  });

  // --- POST /v1/communities/:communityId/dead-letter-events/:id/retry ---

  app.post('/v1/communities/:communityId/dead-letter-events/:id/retry', async (req, reply) => {
    const trigger = getTrigger(req);
    if (trigger === 403) return reply.status(403).send(fixtures.forbidden403);
    if (trigger === 404) return reply.status(404).send(fixtures.deadLetterNotFound404);
    return reply.status(200).send(fixtures.retryEvent200);
  });

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// 5. Test suite
// ---------------------------------------------------------------------------

describe('OpenAPI Contract Tests — docs/openapi.json', () => {
  let spec: OpenApiSpec;
  let ajv: Ajv;
  let app: FastifyInstance;

  /**
   * Retrieve the response schema for a given path+method+statusCode from the spec,
   * with all $refs resolved inline.
   */
  function getSchema(
    openapiPath: string,
    method: string,
    statusCode: number,
  ): unknown {
    const pathItem = spec.paths[openapiPath];
    expect(pathItem).toBeDefined();

    const operation = pathItem[method.toLowerCase()];
    expect(operation).toBeDefined();

    const response = operation.responses[String(statusCode)];
    expect(response).toBeDefined();

    const content = response.content;
    if (!content || !content['application/json']) {
      // Route has no documented JSON body for this status (e.g. /metrics 200)
      return null;
    }

    const rawSchema = content['application/json'].schema;
    if (!rawSchema) return null;

    return deref(rawSchema, spec.components.schemas as Record<string, unknown>);
  }

  beforeAll(async () => {
    spec = loadSpec();
    ajv = buildAjv();
    app = await buildContractTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Spec integrity
  // ─────────────────────────────────────────────────────────────────────────

  describe('spec file', () => {
    test('docs/openapi.json exists and is valid', () => {
      expect(fs.existsSync(OPENAPI_PATH)).toBe(true);
      expect(spec.openapi).toMatch(/^3\./);
      expect(spec.paths).toBeDefined();
      expect(spec.components.schemas).toBeDefined();
    });

    test('spec documents all expected /v1 routes', () => {
      const expectedPaths = [
        '/v1/communities/{communityId}/memberships/{wallet}',
        '/v1/communities/{communityId}/members/{wallet}',
        '/v1/communities/{communityId}/members/{wallet}/roles',
        '/v1/communities/{communityId}/members/{wallet}/roles/{role}',
        '/v1/communities/{communityId}/overrides',
        '/v1/communities/{communityId}/overrides/{wallet}/{resource}',
        '/v1/access/check',
        '/v1/communities/{communityId}/members',
        '/v1/communities/{communityId}/dead-letter-events',
        '/v1/communities/{communityId}/dead-letter-events/{id}/retry',
      ];
      for (const p of expectedPaths) {
        expect(spec.paths[p]).toBeDefined();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Health routes
  // ─────────────────────────────────────────────────────────────────────────

  describe('GET /health/live', () => {
    test('200 — response body conforms to schema', async () => {
      const schema = getSchema('/health/live', 'get', 200);
      expect(schema).not.toBeNull();

      const res = await app.inject({ method: 'GET', url: '/health/live' });
      expect(res.statusCode).toBe(200);

      const validate = compileSchema(ajv, schema, 'GET /health/live 200');
      assertConformsToSchema(validate, res.json(), 'GET /health/live 200');
    });
  });

  describe('GET /health/ready', () => {
    test('200 — response body conforms to schema', async () => {
      const schema = getSchema('/health/ready', 'get', 200);
      expect(schema).not.toBeNull();

      const res = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(200);

      const validate = compileSchema(ajv, schema, 'GET /health/ready 200');
      assertConformsToSchema(validate, res.json(), 'GET /health/ready 200');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /v1/communities/{communityId}/memberships/{wallet}
  // ─────────────────────────────────────────────────────────────────────────

  describe('GET /v1/communities/{communityId}/memberships/{wallet}', () => {
    const SPEC_PATH = '/v1/communities/{communityId}/memberships/{wallet}';
    const URL = `/v1/communities/${COMMUNITY}/memberships/${WALLET}`;

    test('200 — membership summary conforms to schema', async () => {
      const schema = getSchema(SPEC_PATH, 'get', 200);
      expect(schema).not.toBeNull();

      const res = await app.inject({ method: 'GET', url: URL });
      expect(res.statusCode).toBe(200);

      const validate = compileSchema(ajv, schema, `GET ${SPEC_PATH} 200`);
      assertConformsToSchema(validate, res.json(), `GET ${SPEC_PATH} 200`);
    });

    test('404 — error response conforms to ErrorResponse schema', async () => {
      const schema = getSchema(SPEC_PATH, 'get', 404);
      expect(schema).not.toBeNull();

      const res = await app.inject({
        method: 'GET', url: URL,
        headers: { 'x-contract-trigger': '404' },
      });
      expect(res.statusCode).toBe(404);

      const validate = compileSchema(ajv, schema, `GET ${SPEC_PATH} 404`);
      assertConformsToSchema(validate, res.json(), `GET ${SPEC_PATH} 404`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /v1/communities/{communityId}/members/{wallet}
  // ─────────────────────────────────────────────────────────────────────────

  describe('GET /v1/communities/{communityId}/members/{wallet}', () => {
    const SPEC_PATH = '/v1/communities/{communityId}/members/{wallet}';
    const URL = `/v1/communities/${COMMUNITY}/members/${WALLET}`;

    test('200 — member profile conforms to schema', async () => {
      const schema = getSchema(SPEC_PATH, 'get', 200);
      expect(schema).not.toBeNull();

      const res = await app.inject({ method: 'GET', url: URL });
      expect(res.statusCode).toBe(200);

      const validate = compileSchema(ajv, schema, `GET ${SPEC_PATH} 200`);
      assertConformsToSchema(validate, res.json(), `GET ${SPEC_PATH} 200`);
    });

    test('400 — validation error conforms to ErrorResponse schema', async () => {
      const schema = getSchema(SPEC_PATH, 'get', 400);
      expect(schema).not.toBeNull();

      const res = await app.inject({
        method: 'GET', url: URL,
        headers: { 'x-contract-trigger': '400' },
      });
      expect(res.statusCode).toBe(400);

      const validate = compileSchema(ajv, schema, `GET ${SPEC_PATH} 400`);
      assertConformsToSchema(validate, res.json(), `GET ${SPEC_PATH} 400`);
    });

    test('404 — not-found error conforms to ErrorResponse schema', async () => {
      const schema = getSchema(SPEC_PATH, 'get', 404);
      expect(schema).not.toBeNull();

      const res = await app.inject({
        method: 'GET', url: URL,
        headers: { 'x-contract-trigger': '404' },
      });
      expect(res.statusCode).toBe(404);

      const validate = compileSchema(ajv, schema, `GET ${SPEC_PATH} 404`);
      assertConformsToSchema(validate, res.json(), `GET ${SPEC_PATH} 404`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /v1/communities/{communityId}/members/{wallet}/roles
  // ─────────────────────────────────────────────────────────────────────────

  describe('POST /v1/communities/{communityId}/members/{wallet}/roles', () => {
    const SPEC_PATH = '/v1/communities/{communityId}/members/{wallet}/roles';
    const URL = `/v1/communities/${COMMUNITY}/members/${WALLET}/roles`;

    test('200 — RoleMutationResult conforms to schema', async () => {
      const schema = getSchema(SPEC_PATH, 'post', 200);
      expect(schema).not.toBeNull();

      const res = await app.inject({
        method: 'POST', url: URL,
        payload: { role: 'admin' },
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
      });
      expect(res.statusCode).toBe(200);

      const validate = compileSchema(ajv, schema, `POST ${SPEC_PATH} 200`);
      assertConformsToSchema(validate, res.json(), `POST ${SPEC_PATH} 200`);
    });

    test('400 — validation error conforms to ErrorResponse schema', async () => {
      const schema = getSchema(SPEC_PATH, 'post', 400);
      expect(schema).not.toBeNull();

      const res = await app.inject({
        method: 'POST', url: URL,
        payload: { role: 'admin' },
        headers: { 'content-type': 'application/json', 'x-contract-trigger': '400' },
      });
      expect(res.statusCode).toBe(400);

      const validate = compileSchema(ajv, schema, `POST ${SPEC_PATH} 400`);
      assertConformsToSchema(validate, res.json(), `POST ${SPEC_PATH} 400`);
    });

    test('403 — forbidden error conforms to ForbiddenResponse schema', async () => {
      const schema = getSchema(SPEC_PATH, 'post', 403);
      expect(schema).not.toBeNull();

      const res = await app.inject({
        method: 'POST', url: URL,
        payload: { role: 'admin' },
        headers: { 'content-type': 'application/json', 'x-contract-trigger': '403' },
      });
      expect(res.statusCode).toBe(403);

      const validate = compileSchema(ajv, schema, `POST ${SPEC_PATH} 403`);
      assertConformsToSchema(validate, res.json(), `POST ${SPEC_PATH} 403`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /v1/communities/{communityId}/members/{wallet}/roles/{role}
  // ─────────────────────────────────────────────────────────────────────────

  describe('DELETE /v1/communities/{communityId}/members/{wallet}/roles/{role}', () => {
    const SPEC_PATH = '/v1/communities/{communityId}/members/{wallet}/roles/{role}';
    const URL = `/v1/communities/${COMMUNITY}/members/${WALLET}/roles/admin`;

    test('200 — RoleMutationResult conforms to schema', async () => {
      const schema = getSchema(SPEC_PATH, 'delete', 200);
      expect(schema).not.toBeNull();

      const res = await app.inject({ method: 'DELETE', url: URL });
      expect(res.statusCode).toBe(200);

      const validate = compileSchema(ajv, schema, `DELETE ${SPEC_PATH} 200`);
      assertConformsToSchema(validate, res.json(), `DELETE ${SPEC_PATH} 200`);
    });

    test('400 — validation error conforms to ErrorResponse schema', async () => {
      const schema = getSchema(SPEC_PATH, 'delete', 400);
      expect(schema).not.toBeNull();

      const res = await app.inject({
        method: 'DELETE', url: URL,
        headers: { 'x-contract-trigger': '400' },
      });
      expect(res.statusCode).toBe(400);

      const validate = compileSchema(ajv, schema, `DELETE ${SPEC_PATH} 400`);
      assertConformsToSchema(validate, res.json(), `DELETE ${SPEC_PATH} 400`);
    });

    test('403 — forbidden error conforms to ForbiddenResponse schema', async () => {
      const schema = getSchema(SPEC_PATH, 'delete', 403);
      expect(schema).not.toBeNull();

      const res = await app.inject({
        method: 'DELETE', url: URL,
        headers: { 'x-contract-trigger': '403' },
      });
      expect(res.statusCode).toBe(403);

      const validate = compileSchema(ajv, schema, `DELETE ${SPEC_PATH} 403`);
      assertConformsToSchema(validate, res.json(), `DELETE ${SPEC_PATH} 403`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /v1/communities/{communityId}/overrides
  // ─────────────────────────────────────────────────────────────────────────

  describe('POST /v1/communities/{communityId}/overrides', () => {
    const SPEC_PATH = '/v1/communities/{communityId}/overrides';
    const URL = `/v1/communities/${COMMUNITY}/overrides`;
    const PAYLOAD = { wallet: WALLET, resource: RESOURCE, effect: 'ALLOW' };

    test('200 — AccessOverrideMutationResult conforms to schema', async () => {
      const schema = getSchema(SPEC_PATH, 'post', 200);
      expect(schema).not.toBeNull();

      const res = await app.inject({
        method: 'POST', url: URL,
        payload: PAYLOAD,
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(200);

      const validate = compileSchema(ajv, schema, `POST ${SPEC_PATH} 200`);
      assertConformsToSchema(validate, res.json(), `POST ${SPEC_PATH} 200`);
    });

    test('400 — missing-fields error conforms to ErrorResponse schema', async () => {
      const schema = getSchema(SPEC_PATH, 'post', 400);
      expect(schema).not.toBeNull();

      const res = await app.inject({
        method: 'POST', url: URL,
        payload: PAYLOAD,
        headers: { 'content-type': 'application/json', 'x-contract-trigger': '400' },
      });
      expect(res.statusCode).toBe(400);

      const validate = compileSchema(ajv, schema, `POST ${SPEC_PATH} 400`);
      assertConformsToSchema(validate, res.json(), `POST ${SPEC_PATH} 400`);
    });

    test('403 — forbidden error conforms to ForbiddenResponse schema', async () => {
      const schema = getSchema(SPEC_PATH, 'post', 403);
      expect(schema).not.toBeNull();

      const res = await app.inject({
        method: 'POST', url: URL,
        payload: PAYLOAD,
        headers: { 'content-type': 'application/json', 'x-contract-trigger': '403' },
      });
      expect(res.statusCode).toBe(403);

      const validate = compileSchema(ajv, schema, `POST ${SPEC_PATH} 403`);
      assertConformsToSchema(validate, res.json(), `POST ${SPEC_PATH} 403`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /v1/communities/{communityId}/overrides/{wallet}/{resource}
  // ─────────────────────────────────────────────────────────────────────────

  describe('DELETE /v1/communities/{communityId}/overrides/{wallet}/{resource}', () => {
    const SPEC_PATH = '/v1/communities/{communityId}/overrides/{wallet}/{resource}';
    const URL = `/v1/communities/${COMMUNITY}/overrides/${WALLET}/${RESOURCE}`;

    test('200 — AccessOverrideMutationResult conforms to schema', async () => {
      const schema = getSchema(SPEC_PATH, 'delete', 200);
      expect(schema).not.toBeNull();

      const res = await app.inject({ method: 'DELETE', url: URL });
      expect(res.statusCode).toBe(200);

      const validate = compileSchema(ajv, schema, `DELETE ${SPEC_PATH} 200`);
      assertConformsToSchema(validate, res.json(), `DELETE ${SPEC_PATH} 200`);
    });

    test('403 — forbidden error conforms to ForbiddenResponse schema', async () => {
      const schema = getSchema(SPEC_PATH, 'delete', 403);
      expect(schema).not.toBeNull();

      const res = await app.inject({
        method: 'DELETE', url: URL,
        headers: { 'x-contract-trigger': '403' },
      });
      expect(res.statusCode).toBe(403);

      const validate = compileSchema(ajv, schema, `DELETE ${SPEC_PATH} 403`);
      assertConformsToSchema(validate, res.json(), `DELETE ${SPEC_PATH} 403`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /v1/access/check
  // ─────────────────────────────────────────────────────────────────────────

  describe('POST /v1/access/check', () => {
    const SPEC_PATH = '/v1/access/check';
    const URL = '/v1/access/check';
    const PAYLOAD = { wallet: WALLET, communityId: COMMUNITY, resource: RESOURCE };

    test('200 — AccessDecision (ALLOW) conforms to schema', async () => {
      const schema = getSchema(SPEC_PATH, 'post', 200);
      expect(schema).not.toBeNull();

      const res = await app.inject({
        method: 'POST', url: URL,
        payload: PAYLOAD,
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(200);

      const validate = compileSchema(ajv, schema, `POST ${SPEC_PATH} 200`);
      assertConformsToSchema(validate, res.json(), `POST ${SPEC_PATH} 200`);
    });

    test('400 — validation error conforms to ErrorResponse schema', async () => {
      const schema = getSchema(SPEC_PATH, 'post', 400);
      expect(schema).not.toBeNull();

      const res = await app.inject({
        method: 'POST', url: URL,
        payload: PAYLOAD,
        headers: { 'content-type': 'application/json', 'x-contract-trigger': '400' },
      });
      expect(res.statusCode).toBe(400);

      const validate = compileSchema(ajv, schema, `POST ${SPEC_PATH} 400`);
      assertConformsToSchema(validate, res.json(), `POST ${SPEC_PATH} 400`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /v1/communities/{communityId}/members
  // ─────────────────────────────────────────────────────────────────────────

  describe('GET /v1/communities/{communityId}/members', () => {
    const SPEC_PATH = '/v1/communities/{communityId}/members';
    const URL = `/v1/communities/${COMMUNITY}/members`;

    test('200 — member list conforms to schema', async () => {
      const schema = getSchema(SPEC_PATH, 'get', 200);
      expect(schema).not.toBeNull();

      const res = await app.inject({ method: 'GET', url: URL });
      expect(res.statusCode).toBe(200);

      const validate = compileSchema(ajv, schema, `GET ${SPEC_PATH} 200`);
      assertConformsToSchema(validate, res.json(), `GET ${SPEC_PATH} 200`);
    });

    test('403 — forbidden error conforms to ForbiddenResponse schema', async () => {
      const schema = getSchema(SPEC_PATH, 'get', 403);
      expect(schema).not.toBeNull();

      const res = await app.inject({
        method: 'GET', url: URL,
        headers: { 'x-contract-trigger': '403' },
      });
      expect(res.statusCode).toBe(403);

      const validate = compileSchema(ajv, schema, `GET ${SPEC_PATH} 403`);
      assertConformsToSchema(validate, res.json(), `GET ${SPEC_PATH} 403`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /v1/communities/{communityId}/dead-letter-events
  // ─────────────────────────────────────────────────────────────────────────

  describe('GET /v1/communities/{communityId}/dead-letter-events', () => {
    const SPEC_PATH = '/v1/communities/{communityId}/dead-letter-events';
    const URL = `/v1/communities/${COMMUNITY}/dead-letter-events`;

    test('200 — dead-letter events list conforms to schema', async () => {
      const schema = getSchema(SPEC_PATH, 'get', 200);
      expect(schema).not.toBeNull();

      const res = await app.inject({ method: 'GET', url: URL });
      expect(res.statusCode).toBe(200);

      const validate = compileSchema(ajv, schema, `GET ${SPEC_PATH} 200`);
      assertConformsToSchema(validate, res.json(), `GET ${SPEC_PATH} 200`);
    });

    test('403 — forbidden error conforms to ForbiddenResponse schema', async () => {
      const schema = getSchema(SPEC_PATH, 'get', 403);
      expect(schema).not.toBeNull();

      const res = await app.inject({
        method: 'GET', url: URL,
        headers: { 'x-contract-trigger': '403' },
      });
      expect(res.statusCode).toBe(403);

      const validate = compileSchema(ajv, schema, `GET ${SPEC_PATH} 403`);
      assertConformsToSchema(validate, res.json(), `GET ${SPEC_PATH} 403`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /v1/communities/{communityId}/dead-letter-events/{id}/retry
  // ─────────────────────────────────────────────────────────────────────────

  describe('POST /v1/communities/{communityId}/dead-letter-events/{id}/retry', () => {
    const SPEC_PATH = '/v1/communities/{communityId}/dead-letter-events/{id}/retry';
    const URL = `/v1/communities/${COMMUNITY}/dead-letter-events/${DL_EVENT_ID}/retry`;

    test('200 — retry result conforms to schema', async () => {
      const schema = getSchema(SPEC_PATH, 'post', 200);
      expect(schema).not.toBeNull();

      const res = await app.inject({ method: 'POST', url: URL });
      expect(res.statusCode).toBe(200);

      const validate = compileSchema(ajv, schema, `POST ${SPEC_PATH} 200`);
      assertConformsToSchema(validate, res.json(), `POST ${SPEC_PATH} 200`);
    });

    test('403 — forbidden error conforms to ForbiddenResponse schema', async () => {
      const schema = getSchema(SPEC_PATH, 'post', 403);
      expect(schema).not.toBeNull();

      const res = await app.inject({
        method: 'POST', url: URL,
        headers: { 'x-contract-trigger': '403' },
      });
      expect(res.statusCode).toBe(403);

      const validate = compileSchema(ajv, schema, `POST ${SPEC_PATH} 403`);
      assertConformsToSchema(validate, res.json(), `POST ${SPEC_PATH} 403`);
    });

    test('404 — not-found error conforms to ErrorResponse schema', async () => {
      const schema = getSchema(SPEC_PATH, 'post', 404);
      expect(schema).not.toBeNull();

      const res = await app.inject({
        method: 'POST', url: URL,
        headers: { 'x-contract-trigger': '404' },
      });
      expect(res.statusCode).toBe(404);

      const validate = compileSchema(ajv, schema, `POST ${SPEC_PATH} 404`);
      assertConformsToSchema(validate, res.json(), `POST ${SPEC_PATH} 404`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Failure demonstration — proves the guard actually works
  // ─────────────────────────────────────────────────────────────────────────

  describe('Contract guard — failure modes', () => {
    test('fails when a required field is missing from the response', () => {
      const schema = getSchema('/v1/access/check', 'post', 200);
      expect(schema).not.toBeNull();

      const validate = compileSchema(ajv, schema, 'access-check-failure-demo');

      // 'allowed' and 'code' are required — omitting them must fail validation
      const invalidBody = { membershipState: 'active' }; // missing required 'allowed' + 'code'
      const valid = validate(invalidBody);
      expect(valid).toBe(false);
      expect(validate.errors).not.toBeNull();
      expect(validate.errors!.some((e) => e.params && (e.params as any).missingProperty)).toBe(true);
    });

    test('fails when a field has the wrong type', () => {
      const schema = getSchema('/v1/access/check', 'post', 200);
      expect(schema).not.toBeNull();

      const validate = compileSchema(ajv, schema, 'access-check-type-failure-demo');

      // 'allowed' must be boolean — passing a string must fail
      const invalidBody = { allowed: 'yes', code: 'ALLOW' };
      const valid = validate(invalidBody);
      expect(valid).toBe(false);
      expect(validate.errors!.some((e) => e.instancePath.includes('allowed'))).toBe(true);
    });

    test('fails when an enum value is out-of-range', () => {
      const schema = getSchema('/v1/communities/{communityId}/members/{wallet}/roles', 'post', 200);
      expect(schema).not.toBeNull();

      const validate = compileSchema(ajv, schema, 'role-mutation-enum-failure-demo');

      // 'role' must be one of admin|member|contributor
      const invalidBody = {
        communityId: COMMUNITY,
        wallet: WALLET,
        role: 'super-admin', // invalid
        assigned: true,
        removed: false,
      };
      const valid = validate(invalidBody);
      expect(valid).toBe(false);
      expect(validate.errors!.some((e) => e.instancePath.includes('role'))).toBe(true);
    });
  });
});
