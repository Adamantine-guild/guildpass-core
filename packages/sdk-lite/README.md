# @guildpass/sdk-lite

Minimal, dependency-free TypeScript client for the [GuildPass API](https://github.com/Adamantine-guild/guildpass-core).
Designed for scripts, bots, and CI jobs that need the core access API endpoints and want zero transitive dependencies.

## Install

```bash
pnpm add @guildpass/sdk-lite
```

## Usage

```ts
import { GuildPassClient } from '@guildpass/sdk-lite';

// `token` is optional — falls back to the `GUILDPASS_TOKEN` env var.
const client = new GuildPassClient({
  baseUrl: 'https://api.guildpass.example.com',
  token: process.env.GUILDPASS_TOKEN,
});

const result = await client.checkAccess({
  wallet: '0x1234567890abcdef1234567890abcdef12345678',
  communityId: 'community-1',
  resource: 'channel_42',
});

if (result.allowed) {
  console.log(`Access allowed with code ${result.code}`);
} else {
  console.warn(`Denied: ${result.reason}`);
}
```

## Error handling

All non-success responses (network errors, HTTP failures, empty bodies, non-JSON payloads) throw a `GuildPassApiError`:

```ts
import { GuildPassClient, GuildPassApiError } from '@guildpass/sdk-lite';

try {
  await client.checkAccess({
    wallet: '0x1234567890abcdef1234567890abcdef12345678',
    communityId: 'community-1',
    resource: 'dashboard',
  });
} catch (err) {
  if (err instanceof GuildPassApiError) {
    console.error(`${err.statusCode} ${err.path}: ${err.message}`);
    // err.responseBody is capped at 500 chars so logs stay bounded.
  } else {
    throw err;
  }
}
```

`GuildPassApiError` carries:

| field           | type     | notes                                                          |
| --------------- | -------- | -------------------------------------------------------------- |
| `statusCode`    | `number` | `0` for network errors, otherwise the HTTP status              |
| `path`          | `string` | The request path (e.g. `/v1/access/check`)                     |
| `message`       | `string` | Human-readable summary, with structured `message`/`error` surfaced when present |
| `responseBody`  | `string` | Truncated to ≤ 500 chars with a `[truncated]` marker          |

## API surface

### `new GuildPassClient({ baseUrl, token?, fetchImpl? })`

- `baseUrl` — trailing slashes are stripped.
- `token` — optional. Defaults to `process.env.GUILDPASS_TOKEN`.
- `fetchImpl` — optional. Override the global `fetch` (useful in tests, or on Node <18).

### `client.getMemberships(wallet)`

`GET /v1/memberships/:wallet` -> `{ wallet, communities }`.

### `client.getMemberProfile(wallet)`

`GET /v1/members/:wallet` -> `{ communityId, profile, membership, roles }`.

### `client.checkAccess({ wallet, communityId, resource })`

`POST /v1/access/check` -> `{ allowed: boolean, code?: string, membershipState?: string }`.

### `client.listCommunityMembers(communityId, { role? })`

`GET /v1/communities/:communityId/members` -> `{ members }`.

Throws `GuildPassApiError` on any failure path (network, non-2xx, empty body, non-JSON body, JSON parse error).

## Compatibility

- Node ≥ 18 (uses global `fetch`).
- Browsers with `fetch` support.
- TypeScript ≥ 5.0. Ships with bundled `.d.ts` types.

## License

Same as the parent [`guildpass-core`](https://github.com/Adamantine-guild/guildpass-core) repository.
