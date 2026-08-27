# Security Policy

Security is a core requirement of GuildPass Core.

GuildPass handles functionality related to membership, access control, governance, community permissions, Stellar identities, and Soroban smart contracts. Vulnerabilities in these areas can affect user access, community state, or on-chain behaviour.

This document explains how to report security issues responsibly and what contributors should consider when working on security-sensitive parts of the codebase.

---

## Supported Versions

GuildPass Core V2 is the active development line.

Security fixes are expected to target the current `main` branch unless a maintainer explicitly requests work against another branch.

Legacy pre-rebuild code is preserved for historical reference, but it should not be assumed to receive active security maintenance.

---

## Reporting a Vulnerability

Do not open a public GitHub issue for a suspected vulnerability.

Instead, report the issue privately to the maintainers using the repository's private security reporting mechanism, if enabled.

If private vulnerability reporting is available on GitHub, use:

```text
Repository
→ Security
→ Report a vulnerability
```

If that option is not available, contact the maintainers through an approved private channel before sharing technical details publicly.

---

## What to Include in a Report

A useful security report should include:

- a clear description of the vulnerability;
- the affected component or file;
- the conditions required to reproduce it;
- the potential impact;
- steps to reproduce;
- a minimal proof of concept where appropriate;
- any suggested mitigation;
- whether the issue appears remotely exploitable;
- whether credentials, wallets, or blockchain state are involved.

Avoid including unnecessary personal data or unrelated secrets.

---

## Please Do Not

Do not:

- publish the vulnerability before maintainers have had a reasonable opportunity to investigate;
- exploit the issue against real users or production systems;
- access data that does not belong to you;
- exfiltrate secrets;
- perform destructive testing;
- modify on-chain state outside an authorised test environment;
- attempt to gain persistence or broader access;
- publicly disclose private keys, seed phrases, tokens, or credentials.

---

# Security-Sensitive Areas

The following areas deserve additional review and testing.

## Access Control

Code involving:

- permissions;
- role evaluation;
- membership state;
- policy decisions;
- resource access;
- administrative actions;

should be treated as security-sensitive.

A logic error in access control can be as serious as a traditional authentication bug.

---

## Wallet and Stellar Identity

Stellar account validation must use proper StrKey validation rather than simple prefix checks.

Do not assume that a value is valid because it begins with:

```text
G
```

Wallet-related code should consider:

- malformed addresses;
- invalid checksums;
- unsupported StrKey types;
- signature validation;
- replay protection;
- network mismatch;
- ownership verification.

---

## Soroban Contracts

Smart contracts require particular care because deployed behaviour may be difficult or impossible to change safely.

Soroban contributions should consider:

- authorization checks;
- storage access;
- replay protection;
- state transitions;
- privilege escalation;
- integer overflow or underflow assumptions;
- unexpected caller behaviour;
- reentrancy-equivalent patterns where relevant;
- upgrade assumptions;
- contract interface stability.

Contract changes should include focused tests.

---

## Authentication and Secrets

Never commit:

- private keys;
- Stellar secret keys;
- seed phrases;
- API tokens;
- database credentials;
- access tokens;
- signing secrets;
- production `.env` files.

Secrets must come from environment configuration or an approved secret-management mechanism.

---

## HTTP and API Boundaries

External input should be treated as untrusted.

Validate:

- route parameters;
- request bodies;
- query parameters;
- headers;
- identifiers;
- URLs;
- timestamps;
- pagination values;
- encoded payloads.

Avoid unsafe assumptions based only on TypeScript types because TypeScript types do not exist at runtime.

---

## Database Safety

Database contributions should consider:

- injection risks;
- uniqueness constraints;
- referential integrity;
- race conditions;
- transaction boundaries;
- privilege assumptions;
- migration safety.

Do not construct SQL by concatenating untrusted input.

---

## Redis and Cache Safety

Redis should not be trusted as the sole source of critical GuildPass domain state.

Cache-related code should consider:

- stale authorization data;
- key collisions;
- unbounded key growth;
- unsafe serialization;
- cache poisoning;
- incorrect invalidation.

---

## Cryptographic Code

Prefer established cryptographic primitives and platform APIs.

Do not invent custom cryptographic algorithms.

When comparing secrets or signatures, use timing-safe comparison where appropriate.

Random values used for:

- nonces;
- ownership tokens;
- security identifiers;

must come from cryptographically secure randomness.

---

# Dependency Security

Adding a dependency increases the project's attack surface.

Before introducing a new dependency, consider:

- whether Node.js built-ins can safely provide the functionality;
- whether an existing dependency already covers the requirement;
- the package's maintenance status;
- its dependency tree;
- its install scripts;
- whether it executes native or postinstall code.

Unexpected build scripts should not be approved blindly.

---

# GitHub Actions Security

Changes under:

```text
.github/workflows/
```

are security-sensitive.

Workflow changes can affect:

- repository permissions;
- secret access;
- pull request behaviour;
- release processes;
- external automation.

Contributor workflow changes may require manual maintainer review.

Do not increase workflow permissions without a clear reason.

Prefer the minimum required permissions.

---

# Pull Request Automation

GuildPass uses central PR automation.

The automation evaluates:

- CI status;
- merge conflicts;
- workflow state;
- merge eligibility.

A pull request should never bypass required CI checks.

Changes to automation logic, required checks, or repository dispatch behaviour should be reviewed carefully.

---

# Security Testing Expectations

Security-sensitive contributions should include tests for relevant failure modes.

Examples include:

- malformed input;
- replay attempts;
- invalid signatures;
- unauthorized access;
- expired credentials;
- concurrent operations;
- boundary conditions;
- privilege escalation attempts;
- invalid Stellar addresses;
- incorrect role combinations.

---

# Responsible Disclosure Process

Maintainers should aim to:

1. acknowledge the report;
2. assess severity and impact;
3. reproduce the issue;
4. develop and review a fix;
5. test the fix;
6. coordinate disclosure where appropriate;
7. publish a security update if required.

Timelines may vary depending on severity and complexity.

---

# Good-Faith Research

Security research performed responsibly and within legal and ethical boundaries is welcome.

Good-faith research should:

- avoid harming users;
- avoid accessing unrelated private information;
- use test environments where possible;
- minimize impact;
- report findings privately.

---

# Security Is a Shared Responsibility

Maintainers and contributors are expected to treat security as part of implementation quality, not as a separate afterthought.

If a design has security implications that are not clear, raise the concern before merging.

When in doubt, prefer the safer and more explicit implementation.