import { GuildPassApiError } from './errors';

declare const process: { env: Record<string, string | undefined> };

export interface AccessCheckResult {
  allowed: boolean;
  code?: string;
  membershipState?: string;
  reason?: string;
  reasons?: Array<{ code: string; message: string }>;
  effectiveRoles?: string[];
}

export interface MembershipSummary {
  wallet: string;
  communities: Array<{
    communityId: string;
    state: string;
    expiresAt: string | null;
  }>;
}

export interface MemberProfileResult {
  communityId: string;
  profile: {
    id: string;
    displayName: string;
    bio?: string;
    avatarUrl?: string;
  };
  membership: {
    state: string;
    expiresAt: string | null;
  };
  roles: string[];
}

export interface AccessCheckInput {
  wallet: string;
  communityId: string;
  resource: string;
}

export interface CommunityMembersResult {
  members: Array<{
    wallet: string;
    displayName?: string;
    state: string;
    roles: string[];
  }>;
}

export type CommunityRole = 'admin' | 'member' | 'contributor';

export interface RoleMutationInput {
  communityId: string;
  wallet: string;
  role: CommunityRole;
}

export interface RoleMutationResult {
  communityId: string;
  wallet: string;
  role: CommunityRole;
  assigned: boolean;
  removed: boolean;
  message?: string;
}

export interface GuildPassClientOptions {
  /** Base URL of the GuildPass API, e.g. `https://api.guildpass.example.com`. */
  baseUrl: string;

  /** Bearer token. Defaults to `process.env.GUILDPASS_TOKEN` when omitted. */
  token?: string;

  /** Override the global `fetch` (useful in tests and Node <18). */
  fetchImpl?: typeof fetch;

  /** Optional API version constraint to check against response headers. */
  expectedApiVersion?: string;
}

/** Maximum characters of a response body retained on a {@link GuildPassApiError}. */
const MAX_RESPONSE_BODY_CHARS = 500;

/** Shape of the standardised API error envelope. */
interface ApiErrorEnvelope {
  error: string;
  code: string;
  message: string;
  statusCode: number;
  details?: string | Record<string, unknown>;
}

export class GuildPassClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly expectedApiVersion: string | undefined;

  constructor(opts: GuildPassClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token ?? process.env.GUILDPASS_TOKEN;
    this.expectedApiVersion = opts.expectedApiVersion;
    this.fetchImpl =
      opts.fetchImpl ??
      (typeof fetch !== 'undefined'
        ? fetch.bind(globalThis)
        : (() => {
            throw new Error(
              'No fetch implementation available. Pass `fetchImpl` or upgrade to Node 18+.',
            );
          })());
  }

  /**
   * Fetch all membership communities for a wallet.
   *
   * @throws {GuildPassApiError} when the request fails, the response is not
   *   JSON, or a successful response carries an unexpected shape.
   */
  async getMemberships(wallet: string): Promise<MembershipSummary> {
    return this._request<MembershipSummary>(
      `/v1/memberships/${encodePathSegment(wallet)}`,
      { method: 'GET' },
    );
  }

  /**
   * Fetch a member profile, membership snapshot, and roles for a wallet.
   *
   * @throws {GuildPassApiError} when the request fails, the response is not
   *   JSON, or a successful response carries an unexpected shape.
   */
  async getMemberProfile(wallet: string): Promise<MemberProfileResult> {
    return this._request<MemberProfileResult>(
      `/v1/members/${encodePathSegment(wallet)}`,
      { method: 'GET' },
    );
  }

  /**
   * Check whether a wallet may access a resource inside a community.
   *
   * @throws {GuildPassApiError} when the request fails, the response is not
   *   JSON, or a successful response carries an unexpected shape.
   */
  async checkAccess(input: AccessCheckInput): Promise<AccessCheckResult> {
    return this._request<AccessCheckResult>('/v1/access/check', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /**
   * List members for a community, optionally filtering by role.
   *
   * @throws {GuildPassApiError} when the request fails, the response is not
   *   JSON, or a successful response carries an unexpected shape.
   */
  async listCommunityMembers(
    communityId: string,
    options: { role?: string } = {},
  ): Promise<CommunityMembersResult> {
    const query = options.role
      ? `?role=${encodeURIComponent(options.role)}`
      : '';
    return this._request<CommunityMembersResult>(
      `/v1/communities/${encodePathSegment(communityId)}/members${query}`,
      { method: 'GET' },
    );
  }

  /**
   * Assign a role to a member in a community.
   */
  async assignMemberRole(
    input: RoleMutationInput,
    options: { requesterWallet?: string } = {},
  ): Promise<RoleMutationResult> {
    const headers = options.requesterWallet
      ? { 'x-wallet': options.requesterWallet }
      : undefined;
    return this._request<RoleMutationResult>(
      `/v1/communities/${encodePathSegment(input.communityId)}/members/${encodePathSegment(input.wallet)}/roles`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ role: input.role }),
      },
    );
  }

  /**
   * Remove a role from a member in a community.
   */
  async removeMemberRole(
    input: RoleMutationInput,
    options: { requesterWallet?: string } = {},
  ): Promise<RoleMutationResult> {
    const headers = options.requesterWallet
      ? { 'x-wallet': options.requesterWallet }
      : undefined;
    return this._request<RoleMutationResult>(
      `/v1/communities/${encodePathSegment(input.communityId)}/members/${encodePathSegment(input.wallet)}/roles/${encodePathSegment(input.role)}`,
      {
        method: 'DELETE',
        headers,
      },
    );
  }

  /**
   * Internal request helper. Centralises URL building, headers, error mapping,
   * JSON parsing, and empty-body handling.
   */
  private async _request<T>(path: string, init: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, headers });
    } catch (err) {
      throw new GuildPassApiError({
        statusCode: 0,
        path,
        message: `Network error contacting GuildPass API: ${
          err instanceof Error ? err.message : String(err)
        }`,
        responseBody: '',
      });
    }

    if (this.expectedApiVersion) {
      const apiVersion = res.headers.get('x-guildpass-api-version');
      if (apiVersion && apiVersion !== this.expectedApiVersion) {
        console.warn(
          `[GuildPassClient] API version mismatch for ${path}. Expected ${this.expectedApiVersion}, got ${apiVersion}`,
        );
      }
    }

    if (!res.ok) {
      const body = await safeReadText(res);
      const truncated =
        body.length > MAX_RESPONSE_BODY_CHARS
          ? `${body.slice(0, MAX_RESPONSE_BODY_CHARS)}…[truncated]`
          : body;
      const { message, code, details } = parseErrorEnvelope(body);
      throw new GuildPassApiError({
        statusCode: res.status,
        path,
        message: message ?? buildHttpErrorMessage(res.status, res.statusText, body),
        responseBody: truncated,
        code: code ?? String(res.status),
        details,
      });
    }

    // Successful but empty body — return `undefined as T` so callers can
    // distinguish `void` responses from real payloads. Per the issue's
    // acceptance criteria we surface this explicitly rather than guessing.
    const raw = await safeReadText(res);
    if (raw.length === 0) {
      throw new GuildPassApiError({
        statusCode: res.status,
        path,
        message: 'GuildPass API returned an empty success response',
        responseBody: '',
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new GuildPassApiError({
        statusCode: res.status,
        path,
        message: `GuildPass API returned a non-JSON success response: ${
          err instanceof Error ? err.message : String(err)
        }`,
        responseBody: raw.slice(0, MAX_RESPONSE_BODY_CHARS),
      });
    }

    return parsed as T;
  }
}

/** Reads a response body as text without throwing if the stream is already consumed. */
async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** Attempt to parse the standardised API error envelope from a response body. */
function parseErrorEnvelope(body: string): {
  message?: string;
  code?: string;
  details?: string | Record<string, unknown>;
} {
  try {
    const parsed = JSON.parse(body) as Partial<ApiErrorEnvelope>;
    // Only trust the envelope when both `error` and `message` are present
    // (avoids treating unrelated JSON as an error envelope).
    if (typeof parsed.error === 'string' && typeof parsed.message === 'string') {
      return {
        message: parsed.message,
        code: parsed.error,
        details: parsed.details,
      };
    }
  } catch {
    // Not JSON — caller will fall back to raw-body message building.
  }
  return {};
}

function buildHttpErrorMessage(
  status: number,
  statusText: string,
  body: string,
): string {
  const base = `GuildPass API request failed (HTTP ${status}${
    statusText ? ` ${statusText}` : ''
  })`;
  if (body.length === 0) return base;

  // Try to surface a structured `message` / `error` field from the API.
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const detail =
      typeof parsed.message === 'string'
        ? parsed.message
        : typeof parsed.error === 'string'
        ? parsed.error
        : undefined;
    if (detail) return `${base}: ${detail}`;
  } catch {
    // Not JSON — fall through to the raw-body branch.
  }

  return `${base}: ${body}`;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

export { GuildPassApiError } from './errors';
