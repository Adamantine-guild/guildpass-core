# Authentication and Identity in GuildPass Core V2

GuildPass Core V2 separates **identity**, **authentication**, and **authorization**.

These concepts are related, but they are not interchangeable:

```text
Identity
  │
  └── Who is this actor?

Authentication
  │
  └── Can they prove control of that identity?

Authorization
  │
  └── What are they allowed to do?
```

Keeping these concerns separate makes the system easier to reason about, test, and secure.

---

# 1. Current Direction

GuildPass Core V2 is **Stellar-first**.

The legacy V1 authentication assumptions around:

- SIWE;
- EIP-712;
- EVM wallets;
- Ethereum-specific signature flows;

should not be treated as the default architecture for V2.

Any EVM authentication support would require an explicit future architectural decision.

The current direction is to build authentication around GuildPass identities and Stellar-compatible ownership proofs where required.

---

# 2. Identity Model

GuildPass may recognise identities such as:

- application users;
- members;
- Stellar accounts;
- service identities;
- future delegated or machine identities.

Identity alone does not prove ownership.

For example:

```text
GA123...
```

is only an identifier.

It does not prove that the current caller controls the corresponding Stellar account.

---

# 3. Authentication Model

Authentication should establish that a caller controls or possesses a trusted credential associated with an identity.

Potential authentication mechanisms may include:

- wallet-signature challenges;
- short-lived application sessions;
- service tokens;
- signed capability tokens;
- API keys for trusted machine integrations.

Not every mechanism needs to exist immediately.

V2 should add them incrementally, with explicit security boundaries.

---

# 4. Authorization Comes After Authentication

Authentication should not directly decide access.

A caller can be authenticated and still be denied.

For example:

```text
Authenticated Stellar account
        │
        ▼
Resolve GuildPass membership
        │
        ▼
Resolve roles / permissions
        │
        ▼
Policy engine
        │
        ▼
AccessDecision
```

This keeps authentication separate from GuildPass authorization logic.

---

# 5. Wallet-Based Authentication

A future wallet authentication flow should use a challenge-response pattern.

Conceptually:

```text
Client requests challenge
        │
        ▼
Server issues one-time nonce
        │
        ▼
Client signs challenge
        │
        ▼
Server verifies signature
        │
        ▼
Nonce is consumed
        │
        ▼
Authenticated identity established
```

The challenge must be single-use and time-bounded.

---

# 6. Nonce Requirements

Authentication nonces should:

- be generated using cryptographically secure randomness;
- contain sufficient entropy;
- expire after a short period;
- be single-use;
- be bound to the intended authentication context;
- resist replay;
- be invalidated after successful consumption.

Avoid predictable values such as:

```text
timestamp
incrementing counter
user ID alone
```

as authentication nonces.

---

# 7. Replay Protection

Replay protection is critical for signed authentication flows.

A valid signature should not remain usable indefinitely.

A secure flow should bind the signature to values such as:

- nonce;
- account identifier;
- intended domain;
- issued time;
- expiration time;
- network;
- purpose.

Example conceptual challenge:

```text
GuildPass Authentication

Account: GA...
Network: Stellar Public Network
Nonce: 9f4c...
Issued At: 2026-08-27T10:00:00Z
Expires At: 2026-08-27T10:05:00Z
Purpose: login
```

The exact canonical message format must be documented before production use.

---

# 8. Canonical Signing Payloads

Signed payloads must be deterministic.

Do not construct signature payloads from loosely ordered JSON without canonicalisation.

The same logical authentication request must produce exactly the same bytes for signing and verification.

Canonicalisation should define:

- field ordering;
- encoding;
- newline handling;
- whitespace;
- timestamps;
- network identifiers;
- nonce representation.

---

# 9. Stellar Signature Verification

Stellar account ownership verification should use proper cryptographic verification.

Do not treat a valid Stellar address as proof of control.

Verification should include:

- valid StrKey parsing;
- supported account type;
- valid public key;
- signature verification against the exact challenge bytes;
- nonce validation;
- expiry validation.

No network request should be required merely to validate a standard account signature if all required key material is already present.

---

# 10. Network Binding

Authentication should be bound to the expected Stellar network where relevant.

For example:

```text
testnet
public
custom
```

A signature intended for one network should not automatically be accepted for another if the challenge includes network context.

This prevents ambiguous cross-environment authentication.

---

# 11. Domain Binding

Signed authentication challenges should include a clear domain or service identifier.

This reduces the risk of a valid signature created for one service being replayed against another.

For example:

```text
Domain: api.guildpass.example
```

The exact domain-binding strategy should be documented when wallet authentication is implemented.

---

# 12. Session Authentication

If GuildPass introduces sessions, sessions should be separate from wallet signatures.

A typical flow is:

```text
Wallet proof
    │
    ▼
Authentication succeeds
    │
    ▼
Short-lived session issued
    │
    ▼
Application uses session
```

This avoids requiring a wallet signature for every request.

---

# 13. Session Requirements

A future session mechanism should define:

- creation;
- expiration;
- renewal;
- invalidation;
- replay behaviour;
- rotation;
- logout semantics;
- multi-device behaviour.

Sessions should be short-lived enough to reduce exposure while remaining usable.

---

# 14. Session Identifiers

Session IDs must:

- be unpredictable;
- come from cryptographically secure randomness;
- not encode secrets unnecessarily;
- not expose internal database IDs directly if avoidable.

---

# 15. Token-Based Authentication

If signed tokens are introduced, they should have explicit:

- subject;
- audience;
- issued time;
- expiration;
- version;
- scopes or capabilities;
- nonce or unique identifier where needed.

Tokens should never be treated as valid solely because they decode successfully.

Signature verification is mandatory.

---

# 16. Capability Tokens

Capability tokens may be useful for short-lived internal authorization between trusted components.

They are not automatically a replacement for user authentication.

A capability token should answer:

```text
What may this caller do?
```

rather than:

```text
Who is this human user?
```

Those concerns should remain separate.

---

# 17. API Keys

API keys may be appropriate for machine-to-machine integrations.

If introduced, API keys should:

- be generated securely;
- be stored hashed where possible;
- support rotation;
- support revocation;
- be scoped;
- avoid appearing in logs;
- use constant-time comparison where applicable.

---

# 18. Secret Handling

Authentication code must never log:

- raw private keys;
- Stellar secret seeds;
- signing secrets;
- API keys;
- access tokens;
- refresh tokens;
- session secrets.

Diagnostic logs may use non-reversible fingerprints where useful, but should not expose the original value.

---

# 19. Header Handling

If authentication credentials are supplied through headers, header processing should:

- validate names and values;
- reject newline injection;
- handle casing consistently;
- avoid copying authentication headers into generic logs;
- prevent accidental override of protected headers.

---

# 20. Error Handling

Authentication errors should be structured.

Prefer machine-readable codes such as:

```text
INVALID_SIGNATURE
EXPIRED_CHALLENGE
UNKNOWN_NONCE
NONCE_ALREADY_USED
INVALID_ACCOUNT
NETWORK_MISMATCH
SESSION_EXPIRED
UNAUTHENTICATED
```

Do not expose sensitive cryptographic or internal details in public error messages.

---

# 21. Authentication vs Membership

A caller can be authenticated without being a GuildPass member.

For example:

```text
Valid Stellar account
        │
        ▼
Authentication succeeds
        │
        ▼
No membership found
        │
        ▼
Access denied
```

This is expected behaviour.

Authentication proves identity.

Membership determines community relationship.

---

# 22. Authentication vs Roles

Authentication should not assign roles.

Roles should come from GuildPass domain state.

Avoid logic such as:

```text
wallet authenticated
→ automatically admin
```

unless explicitly configured through a secure administrative mechanism.

---

# 23. Authentication vs Policy

The policy engine should receive already-resolved identity and domain state.

For example:

```text
Authentication layer
        │
        ▼
Authenticated actor
        │
        ▼
Application service
        │
        ▼
Membership + roles + resource
        │
        ▼
Policy engine
```

The policy engine should not verify wallet signatures itself.

---

# 24. Authentication Boundary

The trust boundary can be visualised as:

```text
Untrusted client
      │
      ▼
Authentication validation
      │
      ▼
Authenticated identity
      │
      ▼
Application logic
      │
      ▼
Authorization
```

Data should not be treated as trusted simply because it originated from an authenticated caller.

Input validation still applies.

---

# 25. Input Validation

Authentication endpoints should validate:

- account IDs;
- signatures;
- nonces;
- timestamps;
- challenge versions;
- network identifiers;
- domains;
- token structure.

Malformed inputs should fail safely.

---

# 26. Timing Attacks

Where authentication involves comparing secret-derived values, use timing-safe comparison where practical.

Examples include:

- HMAC signatures;
- opaque token signatures;
- secret fingerprints;
- API-key hashes.

Do not use ordinary string equality where timing resistance is required.

---

# 27. Expiration Handling

Authentication artifacts should use explicit UTC timestamps.

Avoid ambiguous local-time parsing.

Prefer:

```text
issuedAt
expiresAt
```

rather than only:

```text
ttl
```

when auditability matters.

---

# 28. Clock Skew

Where signed timestamps are used, allow only a small documented clock-skew tolerance.

Do not accept arbitrarily future-dated challenges or tokens.

---

# 29. Rate Limiting

Authentication endpoints are good candidates for rate limiting.

Examples include:

- challenge issuance;
- signature verification;
- token exchange;
- API-key validation.

Rate limiting should not become the sole security control, but it can reduce abuse.

---

# 30. Audit Events

Security-relevant authentication actions may be auditable.

Examples:

```text
AuthenticationSucceeded
AuthenticationFailed
SessionIssued
SessionRevoked
ApiKeyRotated
```

Audit events must not contain raw secrets.

---

# 31. Database Storage

If authentication state is persisted, store only what is necessary.

Examples may include:

- hashed credentials;
- session metadata;
- nonce status;
- expiry timestamps;
- revocation state.

Avoid storing raw secrets when verification can be performed against a hash.

---

# 32. Redis Use

Redis may be useful for:

- short-lived nonce state;
- rate limiting;
- temporary session metadata;
- replay protection.

Critical authentication behaviour should still have explicit failure semantics if Redis becomes unavailable.

---

# 33. Failure Modes

Authentication systems should define behaviour when dependencies fail.

For example:

```text
Redis unavailable
Database unavailable
Clock invalid
Malformed signature
Unknown account type
```

Fail closed for security-sensitive authentication decisions unless there is a clearly documented alternative.

---

# 34. Testing Requirements

Authentication-related tests should cover:

- valid proof;
- invalid signature;
- wrong account;
- wrong network;
- expired challenge;
- future-dated challenge;
- reused nonce;
- malformed nonce;
- malformed account;
- malformed signature;
- concurrent nonce consumption;
- replay attempts.

---

# 35. Concurrency

Nonce consumption and session state changes must be safe under concurrency.

Avoid:

```text
check nonce exists
then later mark used
```

if two requests can race.

The consume operation should be atomic.

---

# 36. Browser and Client Considerations

Authentication payloads should be compatible with SDK consumers.

Avoid requiring server-only constructs in payload formats.

The SDK may eventually help:

- request challenges;
- construct canonical signing payloads;
- submit signatures;
- manage session tokens.

The SDK should never request or handle a user's Stellar secret seed directly.

Signing should remain in the user's wallet or trusted signer.

---

# 37. Smart Contract Authentication

Soroban authorization is separate from HTTP authentication.

A Soroban contract should enforce its own authorization requirements.

Do not assume that because the backend authenticated a caller, a contract invocation is automatically authorised.

On-chain authorization must remain independently enforceable.

---

# 38. Administrative Authentication

Administrative functionality should use stronger controls than ordinary public access where appropriate.

Examples may include:

- privileged service credentials;
- explicit administrative roles;
- short-lived credentials;
- additional audit requirements.

Avoid hidden administrator bypasses.

---

# 39. Legacy V1 Authentication

V1 authentication mechanisms such as SIWE and EIP-712 are historical context only.

They should not be restored into V2 by default.

If EVM authentication is ever reintroduced, it should be implemented through an explicit architecture decision and isolated from Stellar authentication.

---

# 40. Recommended Authentication Flow

A future Stellar-based GuildPass authentication flow should conceptually look like:

```text
Client
  │
  │ 1. Request challenge
  ▼
GuildPass API
  │
  │ 2. Generate secure nonce
  │
  │ 3. Return canonical challenge
  ▼
Client Wallet
  │
  │ 4. Sign exact challenge bytes
  ▼
GuildPass API
  │
  │ 5. Validate challenge
  │ 6. Verify signature
  │ 7. Atomically consume nonce
  │
  ▼
Authenticated Identity
  │
  │ 8. Resolve membership / roles
  ▼
Authorization
```

---

# 41. Summary

GuildPass Core V2 treats authentication as one part of a larger trust model:

```text
Identity
    +
Proof of control
    =
Authentication

Authentication
    +
Membership
    +
Roles
    +
Policy
    =
Authorization
```

Authentication code should remain:

- explicit;
- replay-resistant;
- deterministic;
- minimally privileged;
- independently testable;
- separate from GuildPass authorization logic.