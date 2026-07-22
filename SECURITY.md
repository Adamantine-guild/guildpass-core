# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 0.1.x (main) | ✅ Yes |

## Reporting a Vulnerability

We take security seriously. If you discover a vulnerability, **do not** open a public GitHub issue.

### How to report

1. **Email** **cerealboxx123@gmail.com** with subject `[SECURITY] guildpass-core — <brief description>`.
2. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested mitigations (optional)
3. We will acknowledge receipt within **72 hours** and provide an initial assessment within **7 days**.

---

## Scope

This repository contains:
- A Fastify REST API with Prisma/PostgreSQL
- Solidity smart contracts (ERC-721 MembershipNFT)
- A policy engine for access decisions

### Smart Contract Security (Priority)

Smart contract vulnerabilities are treated as **critical**. In-scope issues include:
- Reentrancy attacks
- Access control bypasses (unauthorised mint/burn/renew)
- Integer overflow/underflow in expiry logic
- Incorrect event emission that breaks off-chain indexing
- Denial of service vectors in public-facing functions

A completed review of `MembershipNFT.sol` against these categories —
findings, fixes, and regression tests — is documented in
[contracts/SECURITY_REVIEW_MembershipNFT.md](./contracts/SECURITY_REVIEW_MembershipNFT.md).

### API Security

In-scope:
- Unauthorised access to admin endpoints (gated by API-key authentication)
- SQL injection or Prisma query manipulation
- Privilege escalation via role endpoints
- Wallet address spoofing in access checks and mutations (mitigated via SIWE and wallet-ownership signature validation)
- Exposure of secrets or private keys in logs or responses

For details on our trust boundaries and endpoint gating, refer to [THREAT_MODEL.md](file:///Users/boufdaddy/Documents/web3%20projects/guildpass-core/docs/THREAT_MODEL.md).

### Out-of-scope

- Third-party libraries (report to their maintainers)
- Discord platform vulnerabilities (report to Discord)
- Issues in deployed testnet contracts (no funds at risk)

---

## Disclosure Policy

- We will work with you to understand and resolve the issue.
- We ask for a **90-day** coordinated disclosure window.
- We will credit reporters in release notes unless you prefer anonymity.
- We will not take legal action against good-faith security reporters.

Thank you for helping keep GuildPass secure.
