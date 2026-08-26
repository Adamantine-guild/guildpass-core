# Webhook Signature Verification

`@guildpass/webhook-verification` is a provider-neutral security primitive for
verifying inbound HMAC-signed webhook payloads. It has no HTTP framework,
persistence, Prisma or Redis dependency.

## Signing contract

The verifier uses HMAC-SHA256. The authenticated message is the byte sequence:

```text
UTF8(timestamp) || UTF8(".") || rawBodyBytes
```

`timestamp` is a canonical, non-negative Unix timestamp in whole seconds. It
must contain decimal digits only, without whitespace, a sign, a fraction, an
exponent or leading zeroes. The exact timestamp string supplied to `verify` is
used when calculating the HMAC.

String secrets and string bodies are encoded as UTF-8. A `Uint8Array` body is
authenticated byte-for-byte and must never be decoded, parsed or reserialized
before verification. The supplied signature is a 64-character hexadecimal
HMAC-SHA256 digest after removal of any configured exact prefix.

## Usage

```typescript
import { createWebhookVerifier } from '@guildpass/webhook-verification';

const verifier = createWebhookVerifier({
  secret: process.env.WEBHOOK_SECRET!,
  toleranceSeconds: 300,
  signaturePrefix: 'sha256=',
});

const result = verifier.verify({
  rawBody,
  signature,
  timestamp,
});
```

The caller is responsible for obtaining the original request bytes before an
HTTP framework parses the body and for reading the provider's signature and
timestamp fields. The package intentionally has no knowledge of headers,
routes, providers or environment-variable names.

Invalid request-controlled signature or timestamp input returns a typed result
instead of throwing. Invalid verifier configuration and an invalid `rawBody`
type are caller programming errors and throw at the API boundary.

## Timestamp policy and replay limitation

`toleranceSeconds` is applied independently in both directions:

- a timestamp older than the tolerance returns `TIMESTAMP_EXPIRED`;
- a timestamp farther in the future than the tolerance returns
  `TIMESTAMP_IN_FUTURE`;
- a timestamp exactly on either boundary remains valid.

The signature is checked before timestamp freshness. Consequently, an
unauthenticated request with a syntactically valid signature returns
`SIGNATURE_MISMATCH` without revealing whether its timestamp falls inside the
configured window.

Timestamp enforcement bounds the replay window; it does not provide single-use
delivery. A correctly signed request can still be replayed within the accepted
window. Preventing that requires a provider event identifier and durable
deduplication, which are deliberately outside this package's scope.

## Failure codes

- `MISSING_SIGNATURE`
- `INVALID_SIGNATURE_FORMAT`
- `MISSING_TIMESTAMP`
- `INVALID_TIMESTAMP_FORMAT`
- `SIGNATURE_MISMATCH`
- `TIMESTAMP_EXPIRED`
- `TIMESTAMP_IN_FUTURE`

## Secret handling

Secrets are supplied explicitly by the consumer and are never embedded in this
package. Use a randomly generated integration secret from a secret manager or
runtime configuration. Do not log verifier configuration, signatures or secret
material.
