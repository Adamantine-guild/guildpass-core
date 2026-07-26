# Threat Model: GuildPass Access API

This document establishes the threat model, trust boundaries, and authentication requirements for the GuildPass Access API.

## Actors & Roles

1. **End User**: A Web3 user who controls an Ethereum wallet (private key). They interact with the system to prove membership or link secondary wallets to their primary identity.
2. **Integrating Application (Client/Frontend)**: A client-side application (e.g., a dApp running in a browser) acting on behalf of the End User. It cannot be trusted with secrets (like API keys) and must use user-authenticated sessions.
3. **Integrating Application (Server/Backend)**: A trusted backend service that interacts with the Access API to check access decisions, manage community rules, assign roles, or retry webhook deliveries. It can store secrets securely.
4. **Access API**: The core service managing membership states, evaluating access policies, and executing governance rules.

---

## Trust Boundaries

```mermaid
flowchart TD
    subgraph Untrusted Zone
        User[End User / Browser]
        ClientApp[Integrating Frontend dApp]
    end

    subgraph Trust Boundary 1 (User Session / SIWE)
        User -- "Sign SIWE Message" --> ClientApp
        ClientApp -- "Session Token (Bearer)" --> AccessAPI
    end

    subgraph Trust Boundary 2 (Server Credentials / API Key)
        Backend[Integrating Backend Service] -- "API Key (x-api-key)" --> AccessAPI
    end

    subgraph Trusted Zone
        AccessAPI -- "Prisma" --> DB[(PostgreSQL)]
        AccessAPI -- "Webhooks" --> WebhookSubscribers[Webhook Subscribers]
    end
```

1. **End User ↔ Integrating Frontend**: The frontend is running in the user's environment. The user must sign cryptographic challenges to prove wallet ownership.
2. **Integrating Frontend ↔ Access API**: Gated by a short-lived **SIWE Session Token** issued upon successful signature verification.
3. **Integrating Backend ↔ Access API**: Gated by a server-to-server **API Key** passed in the `x-api-key` header.
4. **Access API ↔ Internal Infrastructure**: Access API communicates with PostgreSQL and Redis within a secure VPC boundary.

---

## Threat Vectors & Abuse Cases

### 1. Wallet Spoofing (Client-Side Header Injection)
* **Threat**: A malicious caller spoofing their identity by setting the `x-wallet` (or `x-user-wallet`/`x-requester-wallet`) header to an arbitrary admin's or member's wallet address, escalating privileges or acting on their behalf.
* **Mitigation (implemented — #240)**:
  - Admin/mutation routes run the `requireSiweSession` preHandler, which resolves the requester wallet from a verified SIWE session (Bearer token issued by `/v1/auth/verify`) and sets `request.authenticatedWallet`. Under `SIWE_ENFORCED`, a request without a valid, unexpired session is rejected with `401`, and `getRequesterWallet` no longer trusts the `x-wallet`/`x-user-wallet`/`x-requester-wallet` headers.
  - `x-api-key` still authenticates the calling service (server-to-server), but it no longer substitutes for a verified requester identity in admin authorization decisions.
  - Migration: `SIWE_ENFORCED` defaults to `false` so existing header-based integrators keep working; deployments flip it on once clients present sessions. (This is the `/v1`-compatible migration path — a flag rather than a new `/v2`.)

### 2. Challenge Replay Attacks
* **Threat**: An attacker intercepting a valid challenge signature and re-submitting it to link wallets or authenticate a session.
* **Mitigation**:
  - Store nonces with an expiration timestamp.
  - Mark nonces/challenges as `used` immediately upon verification to prevent replay.

### 3. Session Hijacking & Expiry
* **Threat**: An attacker acquiring a user's session token and using it indefinitely.
* **Mitigation**:
  - Session tokens are short-lived (e.g., 2 hours max).
  - Sessions can be revoked or expired automatically.

---

## Endpoint Authentication Matrix

| Endpoint | Method | Authentication Required | Proof Mechanism |
|---|---|---|---|
| `/v1/auth/nonce` | `POST` | Public | None |
| `/v1/auth/verify` | `POST` | Public (Requires valid signature) | EIP-4361 Signature |
| `/v1/wallets/:primaryWallet/challenges` | `POST` | Public | None |
| `/v1/wallets/:primaryWallet/link` | `POST` | Wallet Proof of Ownership | EIP-191 Challenge Signature |
| `/v1/wallets/:primaryWallet/linked` | `GET` | Public / API Key / Session | None / Optional |
| `/v1/communities/:communityId/memberships/:wallet` | `GET` | Public / API Key / Session | None (Read-only query) |
| `/v1/communities/:communityId/members/:wallet` | `GET` | Public / API Key / Session | None (Read-only query) |
| `/v1/communities/:communityId/members/:wallet/roles` | `POST` | Admin / Server-to-Server | API Key (`x-api-key`) + verified SIWE session (under `SIWE_ENFORCED`) |
| `/v1/communities/:communityId/members/:wallet/roles/:role` | `DELETE` | Admin / Server-to-Server | API Key (`x-api-key`) + verified SIWE session (under `SIWE_ENFORCED`) |
| `/v1/communities/:communityId/overrides` | `POST` | Admin / Server-to-Server | API Key (`x-api-key`) + verified SIWE session (under `SIWE_ENFORCED`) |
| `/v1/communities/:communityId/overrides/:wallet/:resource` | `DELETE` | Admin / Server-to-Server | API Key (`x-api-key`) + verified SIWE session (under `SIWE_ENFORCED`) |
| `/v1/communities/:communityId/members` | `GET` | Admin / Server-to-Server | API Key (`x-api-key`) + verified SIWE session (under `SIWE_ENFORCED`) |
| `/v1/communities/:communityId/dead-letter-events` | `GET` | Admin / Server-to-Server | API Key (`x-api-key`) + verified SIWE session (under `SIWE_ENFORCED`) |
| `/v1/communities/:communityId/dead-letter-events/:id/retry` | `POST` | Admin / Server-to-Server | API Key (`x-api-key`) + verified SIWE session (under `SIWE_ENFORCED`) |
| `/v1/access/check` | `POST` | Public / API Key | None (Policy engine query) |
