import { buildApp } from '../src/app';

describe('API Versioning and Compatibility', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgresql://dummy:5432/db';
    app = await buildApp();
    
    // Add a deprecated route for testing before injecting
    app.get('/v1/deprecated-test', {
      schema: {
        deprecated: true,
      }
    }, async (_req, reply) => {
      return reply.send({ status: 'ok' });
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('should include x-guildpass-api-version on health endpoints', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-guildpass-api-version']).toBe('1.0.0');
    
    const payload = JSON.parse(response.payload);
    expect(payload.version).toBe('1.0.0');
  });

  it('should include x-guildpass-api-version on business routes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/members/0x0000000000000000000000000000000000000000',
    });

    // Header should be there regardless of 404 or 500 error
    expect(response.headers['x-guildpass-api-version']).toBe('1.0.0');
  });

  it('should add deprecation headers if a route is deprecated', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/deprecated-test',
    });

    expect(response.headers['x-guildpass-api-version']).toBe('1.0.0');
    expect(response.headers['deprecation']).toBe('true');
  });
});
