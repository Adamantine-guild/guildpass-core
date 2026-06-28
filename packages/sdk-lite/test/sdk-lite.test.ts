import { GuildPassApiError } from '../src/errors';
import { GuildPassClient } from '../src/index';
import { API_CONTRACT } from '../../shared-types/src/apiContract';

/**
 * Tiny in-memory Response stub so tests don't depend on undici/node-fetch.
 * Implements the slice of the Fetch API the client actually uses.
 */
class StubResponse {
  status: number;
  statusText: string;
  private _body: string;
  private _consumed = false;
  ok: boolean;
  headers: { get(name: string): string | null };

  constructor(opts: {
    status: number;
    statusText?: string;
    body?: string;
    contentType?: string;
  }) {
    this.status = opts.status;
    this.statusText = opts.statusText ?? '';
    this._body = opts.body ?? '';
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = {
      get: (name: string) => {
        if (name.toLowerCase() === 'content-type') {
          return opts.contentType ?? (this._body ? 'application/json' : null);
        }
        return null;
      },
    };
  }

  async text(): Promise<string> {
    if (this._consumed) return '';
    this._consumed = true;
    return this._body;
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }
}

function makeFetchStub(
  handler: (url: string, init: RequestInit) => StubResponse | Promise<StubResponse>,
): jest.Mock {
  const fn = jest.fn(async (url: string, init: RequestInit = {}) =>
    handler(url, init),
  );
  return fn;
}

describe('GuildPassClient', () => {
  describe('request plumbing', () => {
    it('sends a bearer token and JSON content-type by default', async () => {
      const fetchSpy = makeFetchStub((_url, _init) =>
        new StubResponse({ status: 200, body: '{"allowed":true}' }),
      );
      const client = new GuildPassClient({
        baseUrl: 'https://api.example.com/',
        token: 'tok-123',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      await client.checkAccess(API_CONTRACT.accessCheck.requestBody);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = fetchSpy.mock.calls[0]!;
      expect(calledUrl).toBe('https://api.example.com/v1/access/check');
      const headers = (calledInit.headers ?? {}) as Record<string, string>;
      expect(headers.authorization).toBe('Bearer tok-123');
      expect(headers['content-type']).toBe('application/json');
      expect(calledInit.method).toBe('POST');
      expect(calledInit.body).toBe(
        JSON.stringify(API_CONTRACT.accessCheck.requestBody),
      );
    });

    it('strips trailing slashes from the base URL', async () => {
      const fetchSpy = makeFetchStub((_url) =>
        new StubResponse({ status: 200, body: '{"allowed":true}' }),
      );
      const client = new GuildPassClient({
        baseUrl: 'https://api.example.com///',
        token: 't',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      await client.checkAccess(API_CONTRACT.accessCheck.requestBody);
      const [calledUrl] = fetchSpy.mock.calls[0]!;
      expect(calledUrl).toBe('https://api.example.com/v1/access/check');
    });

    it('falls back to GUILDPASS_TOKEN env var when token is omitted', async () => {
      process.env.GUILDPASS_TOKEN = 'env-tok';
      const fetchSpy = makeFetchStub(() =>
        new StubResponse({ status: 200, body: '{"allowed":true}' }),
      );
      const client = new GuildPassClient({
        baseUrl: 'https://api.example.com',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      await client.checkAccess(API_CONTRACT.accessCheck.requestBody);
      const headers = (fetchSpy.mock.calls[0]![1].headers ??
        {}) as Record<string, string>;
      expect(headers.authorization).toBe('Bearer env-tok');
      delete process.env.GUILDPASS_TOKEN;
    });
  });

  describe('API contract coverage', () => {
    it('matches the membership lookup contract', async () => {
      const fetchSpy = makeFetchStub((_url, _init) =>
        new StubResponse({
          status: API_CONTRACT.membershipsByWallet.successStatus,
          body: JSON.stringify(API_CONTRACT.membershipsByWallet.successResponse),
        }),
      );
      const client = new GuildPassClient({
        baseUrl: 'https://api.example.com',
        token: 't',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      const result = await client.getMemberships(
        API_CONTRACT.membershipsByWallet.successResponse.wallet,
      );

      expect(result).toEqual(API_CONTRACT.membershipsByWallet.successResponse);
      const [calledUrl, calledInit] = fetchSpy.mock.calls[0]!;
      expect(calledUrl).toBe(
        `https://api.example.com${API_CONTRACT.membershipsByWallet.samplePath}`,
      );
      expect(calledInit.method).toBe(API_CONTRACT.membershipsByWallet.method);
    });

    it('matches the member profile lookup contract', async () => {
      const fetchSpy = makeFetchStub((_url, _init) =>
        new StubResponse({
          status: API_CONTRACT.memberProfileByWallet.successStatus,
          body: JSON.stringify(API_CONTRACT.memberProfileByWallet.successResponse),
        }),
      );
      const client = new GuildPassClient({
        baseUrl: 'https://api.example.com',
        token: 't',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      const result = await client.getMemberProfile(
        '0x1234567890abcdef1234567890abcdef12345678',
      );

      expect(result).toEqual(API_CONTRACT.memberProfileByWallet.successResponse);
      const [calledUrl, calledInit] = fetchSpy.mock.calls[0]!;
      expect(calledUrl).toBe(
        `https://api.example.com${API_CONTRACT.memberProfileByWallet.samplePath}`,
      );
      expect(calledInit.method).toBe(API_CONTRACT.memberProfileByWallet.method);
    });

    it('matches the access check contract', async () => {
      const fetchSpy = makeFetchStub((_url, _init) =>
        new StubResponse({
          status: API_CONTRACT.accessCheck.successStatus,
          body: JSON.stringify(API_CONTRACT.accessCheck.successResponse),
        }),
      );
      const client = new GuildPassClient({
        baseUrl: 'https://api.example.com',
        token: 't',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      const result = await client.checkAccess(API_CONTRACT.accessCheck.requestBody);

      expect(result).toEqual(API_CONTRACT.accessCheck.successResponse);
      const [calledUrl, calledInit] = fetchSpy.mock.calls[0]!;
      expect(calledUrl).toBe(
        `https://api.example.com${API_CONTRACT.accessCheck.samplePath}`,
      );
      expect(calledInit.method).toBe(API_CONTRACT.accessCheck.method);
      expect(calledInit.body).toBe(
        JSON.stringify(API_CONTRACT.accessCheck.requestBody),
      );
    });

    it('matches the community member listing contract', async () => {
      const fetchSpy = makeFetchStub((_url, _init) =>
        new StubResponse({
          status: API_CONTRACT.communityMembers.successStatus,
          body: JSON.stringify(API_CONTRACT.communityMembers.successResponse),
        }),
      );
      const client = new GuildPassClient({
        baseUrl: 'https://api.example.com',
        token: 't',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      const result = await client.listCommunityMembers('community-1', {
        role: 'admin',
      });

      expect(result).toEqual(API_CONTRACT.communityMembers.successResponse);
      const [calledUrl, calledInit] = fetchSpy.mock.calls[0]!;
      expect(calledUrl).toBe(
        `https://api.example.com${API_CONTRACT.communityMembers.samplePathWithRole}`,
      );
      expect(calledInit.method).toBe(API_CONTRACT.communityMembers.method);
    });
  });

  describe('error mapping', () => {
    it('throws GuildPassApiError with status + path on HTTP failure', async () => {
      const fetchSpy = makeFetchStub(
        () =>
          new StubResponse({
            status: 403,
            statusText: 'Forbidden',
            body: '{"message":"insufficient role"}',
          }),
      );
      const client = new GuildPassClient({
        baseUrl: 'https://api.example.com',
        token: 't',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      await expect(
        client.checkAccess({
          wallet: '0x1234567890abcdef1234567890abcdef12345678',
          communityId: 'community-1',
          resource: 'secret',
        }),
      ).rejects.toMatchObject({
        name: 'GuildPassApiError',
        statusCode: 403,
        path: '/v1/access/check',
        message: expect.stringContaining('insufficient role'),
      });
    });

    it('handles non-JSON error bodies without losing the status code', async () => {
      const fetchSpy = makeFetchStub(
        () =>
          new StubResponse({
            status: 502,
            statusText: 'Bad Gateway',
            body: '<html>upstream is down</html>',
            contentType: 'text/html',
          }),
      );
      const client = new GuildPassClient({
        baseUrl: 'https://api.example.com',
        token: 't',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      const err = (await client
        .checkAccess(API_CONTRACT.accessCheck.requestBody)
        .catch((e: unknown) => e)) as GuildPassApiError;
      expect(err).toBeInstanceOf(GuildPassApiError);
      expect(err.statusCode).toBe(502);
      expect(err.path).toBe('/v1/access/check');
      expect(err.responseBody).toContain('upstream is down');
      expect(err.message).toContain('502');
    });

    it('handles empty error bodies', async () => {
      const fetchSpy = makeFetchStub(
        () => new StubResponse({ status: 500, body: '' }),
      );
      const client = new GuildPassClient({
        baseUrl: 'https://api.example.com',
        token: 't',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      const err = (await client
        .checkAccess(API_CONTRACT.accessCheck.requestBody)
        .catch((e: unknown) => e)) as GuildPassApiError;
      expect(err.statusCode).toBe(500);
      expect(err.responseBody).toBe('');
      expect(err.message).toContain('500');
    });

    it('maps network failures to statusCode 0', async () => {
      const fetchSpy = jest.fn(async () => {
        throw new Error('ECONNREFUSED');
      });
      const client = new GuildPassClient({
        baseUrl: 'https://api.example.com',
        token: 't',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      const err = (await client
        .checkAccess(API_CONTRACT.accessCheck.requestBody)
        .catch((e: unknown) => e)) as GuildPassApiError;
      expect(err).toBeInstanceOf(GuildPassApiError);
      expect(err.statusCode).toBe(0);
      expect(err.message).toContain('ECONNREFUSED');
    });

    it('handles empty successful responses as an error', async () => {
      const fetchSpy = makeFetchStub(
        () => new StubResponse({ status: 204, body: '' }),
      );
      const client = new GuildPassClient({
        baseUrl: 'https://api.example.com',
        token: 't',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      const err = (await client
        .checkAccess(API_CONTRACT.accessCheck.requestBody)
        .catch((e: unknown) => e)) as GuildPassApiError;
      expect(err.statusCode).toBe(204);
      expect(err.message).toContain('empty');
    });

    it('handles non-JSON successful responses as an error', async () => {
      const fetchSpy = makeFetchStub(
        () =>
          new StubResponse({
            status: 200,
            body: 'ok',
            contentType: 'text/plain',
          }),
      );
      const client = new GuildPassClient({
        baseUrl: 'https://api.example.com',
        token: 't',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      const err = (await client
        .checkAccess(API_CONTRACT.accessCheck.requestBody)
        .catch((e: unknown) => e)) as GuildPassApiError;
      expect(err.statusCode).toBe(200);
      expect(err.message).toMatch(/non-JSON/);
    });

    it('truncates large response bodies in messages', async () => {
      const huge = 'x'.repeat(2000);
      const fetchSpy = makeFetchStub(
        () =>
          new StubResponse({
            status: 500,
            body: `{"message":"${huge}"}`,
          }),
      );
      const client = new GuildPassClient({
        baseUrl: 'https://api.example.com',
        token: 't',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      const err = (await client
        .checkAccess(API_CONTRACT.accessCheck.requestBody)
        .catch((e: unknown) => e)) as GuildPassApiError;
      // Body is truncated at 500 chars + truncation marker regardless of payload size.
      expect(err.responseBody.length).toBeLessThanOrEqual(520);
      expect(err.responseBody).toContain('truncated');
    });
  });

  describe('success parsing', () => {
    it('returns the parsed JSON body on success', async () => {
      const fetchSpy = makeFetchStub(
        () =>
          new StubResponse({
            status: 200,
            body: JSON.stringify(API_CONTRACT.accessCheck.successResponse),
          }),
      );
      const client = new GuildPassClient({
        baseUrl: 'https://api.example.com',
        token: 't',
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      const result = await client.checkAccess(API_CONTRACT.accessCheck.requestBody);
      expect(result).toEqual(API_CONTRACT.accessCheck.successResponse);
    });
  });

  describe('GuildPassApiError', () => {
    it('preserves the prototype chain so instanceof works', () => {
      const err = new GuildPassApiError({
        statusCode: 404,
        path: '/x',
        message: 'nope',
      });
      expect(err).toBeInstanceOf(GuildPassApiError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('GuildPassApiError');
    });
  });
});
