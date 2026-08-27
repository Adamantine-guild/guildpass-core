# Contributing to GuildPass Core

Thank you for contributing to GuildPass Core.

GuildPass Core V2 is being rebuilt as a modular, Stellar-first backend and domain layer for programmable communities. Contributions should therefore favour clear boundaries, deterministic behaviour, focused scope, strong typing, and tests.

This guide explains how to contribute safely and consistently.

---

## Before You Start

Please read:

- `README.md`
- `CODE_OF_CONDUCT.md`
- `SECURITY.md`

If you are working from a campaign issue, read the full issue carefully before writing code.

Issues are intended to define:

- the problem;
- the expected outcome;
- implementation boundaries;
- acceptance criteria;
- likely affected files or directories.

Treat the issue as the primary source of truth for the contribution.

---

# Repository Direction

GuildPass Core V2 is a clean rebuild of the previous implementation.

The current direction is:

- TypeScript-first backend development;
- Stellar-first blockchain support;
- Soroban smart contracts for on-chain functionality;
- PostgreSQL for relational persistence;
- Redis for caching and infrastructure concerns;
- deterministic domain logic;
- independently testable modules.

Do not restore old V1 architecture unless an issue explicitly asks for it.

In particular, avoid reintroducing legacy complexity such as:

- EVM-specific assumptions;
- generic multichain abstractions;
- old migration history;
- deprecated services;
- duplicated access-control logic;
- tightly coupled route and domain logic.

---

# Contribution Principles

## 1. Keep Pull Requests Focused

A pull request should solve one issue.

Avoid combining unrelated:

- features;
- refactors;
- dependency upgrades;
- formatting changes;
- documentation rewrites;
- infrastructure changes.

Small, focused PRs are easier to review and safer to merge.

---

## 2. Do Not Create Hidden Dependencies Between Issues

Campaign issues are generally designed to be worked on concurrently.

Do not make your implementation depend on another open issue unless the issue explicitly says so.

If your task requires a missing helper, implement the minimum self-contained functionality needed for your issue instead of waiting for another contributor.

---

## 3. Prefer Deterministic Logic

Given the same valid inputs, domain logic should produce the same result.

Avoid behaviour that depends unnecessarily on:

- object insertion order;
- global mutable state;
- implicit current time;
- random values without injection;
- network state;
- local environment assumptions.

Where time or randomness is required, make it testable.

---

## 4. Separate Domain Logic From Infrastructure

Domain logic should not be hidden inside:

- Fastify routes;
- Prisma queries;
- Redis calls;
- Docker configuration;
- blockchain transport code.

Prefer a structure where business rules can be tested without starting external services.

---

## 5. Tests Are Part of the Contribution

New behaviour should include tests.

Bug fixes should preferably include a regression test that demonstrates the previous failure.

Tests should cover:

- normal behaviour;
- invalid input;
- boundary conditions;
- failure modes;
- deterministic ordering;
- concurrency where relevant;
- security-sensitive edge cases.

---

# Development Setup

## Prerequisites

Install:

- Git
- Node.js 24 or newer
- pnpm 11.x
- Docker
- Docker Compose

If you are working on Soroban contracts, also install the required Rust and Stellar tooling.

Check versions:

```bash
node --version
pnpm --version
```

The repository currently uses:

```text
pnpm 11.16.0
```

---

# Fork and Clone

Fork:

```text
Adamantine-guild/guildpass-core
```

Then clone your fork:

```bash
git clone https://github.com/<YOUR_USERNAME>/guildpass-core.git
cd guildpass-core
```

Add the upstream repository:

```bash
git remote add upstream https://github.com/Adamantine-guild/guildpass-core.git
```

Verify:

```bash
git remote -v
```

You should have:

```text
origin    your fork
upstream  Adamantine-guild/guildpass-core
```

---

# Sync Before Starting Work

Before creating a new branch:

```bash
git checkout main
git fetch upstream
git pull upstream main
git push origin main
```

Always start new work from the latest `main`.

---

# Create a Feature Branch

Do not work directly on `main`.

Recommended branch prefixes:

```text
feat/
fix/
test/
docs/
refactor/
chore/
ci/
```

Examples:

```bash
git checkout -b feat/stellar-address-validator
```

```bash
git checkout -b fix/access-decision-ordering
```

```bash
git checkout -b test/quorum-boundaries
```

---

# Install Dependencies

Run:

```bash
pnpm install
```

For reproducible verification:

```bash
pnpm install --frozen-lockfile
```

If pnpm requests approval for expected dependency build scripts:

```bash
pnpm approve-builds
```

Only approve dependencies you recognise and that are required by the project.

---

# Environment Setup

Create a local environment file:

```bash
cp .env.example .env
```

The default local values are:

```env
NODE_ENV=development
PORT=3000

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/guildpass
DIRECT_URL=postgresql://postgres:postgres@localhost:5432/guildpass

REDIS_URL=redis://localhost:6379
```

Do not commit `.env`.

---

# Local Infrastructure

Start PostgreSQL and Redis:

```bash
docker compose up -d
```

Check status:

```bash
docker compose ps
```

Stop services:

```bash
docker compose down
```

Remove volumes only when you intentionally want to reset local persisted data:

```bash
docker compose down -v
```

---

# Run the API

Start the development server:

```bash
pnpm dev
```

or:

```bash
pnpm --filter @guildpass/api dev
```

Default URL:

```text
http://localhost:3000
```

Health check:

```bash
curl http://localhost:3000/health
```

---

# Required Validation

Before opening a pull request, run:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

All applicable checks must pass.

Do not open a PR with known failing tests unless the issue explicitly concerns the failing test infrastructure.

---

# TypeScript Guidelines

GuildPass Core uses strict TypeScript.

Prefer:

- explicit domain types;
- discriminated unions;
- narrow public APIs;
- readonly values where appropriate;
- `unknown` over `any` at trust boundaries;
- runtime validation for external input.

Avoid:

- unnecessary `any`;
- unsafe type assertions;
- broad casts used to silence compiler errors;
- duplicating types already defined in shared packages.

---

# Error Handling

Errors should be:

- structured;
- predictable;
- safe to expose;
- useful to tests and callers.

Do not rely only on free-form strings when a machine-readable code is more appropriate.

Avoid leaking:

- secrets;
- tokens;
- database credentials;
- private keys;
- raw authentication headers.

---

# Database Contributions

When modifying Prisma or PostgreSQL-related functionality:

- keep schema changes scoped;
- create reproducible migrations;
- test against a fresh database;
- avoid assuming local database history;
- preserve referential integrity;
- document important constraints.

A migration that only works on one developer's existing database is not acceptable.

---

# Redis Contributions

Redis should be treated as infrastructure, not the authoritative source of domain state.

Use Redis for concerns such as:

- caching;
- temporary coordination;
- performance optimisation.

Do not make critical GuildPass state exist only in Redis unless explicitly designed and approved.

---

# Stellar and Soroban Contributions

GuildPass Core V2 is Stellar-first.

When working on Stellar-related functionality:

- validate Stellar formats correctly;
- avoid prefix-only validation;
- keep network logic separated from pure domain logic;
- do not introduce EVM dependencies unless explicitly requested;
- keep Soroban-specific code isolated from unrelated backend functionality.

When working on Soroban contracts:

- include appropriate Rust tests;
- document storage and authorization assumptions;
- avoid unnecessary contract complexity;
- treat public contract interfaces as stable API surfaces.

---

# Public API Changes

Changes to public APIs should be intentional.

If your contribution changes:

- request shapes;
- response shapes;
- exported types;
- public function signatures;
- contract interfaces;

document the change clearly in the PR.

Do not introduce breaking changes casually.

---

# Adding Dependencies

Dependencies affect:

- security;
- install size;
- maintenance;
- build reproducibility.

Before adding one, consider whether the functionality can be implemented safely with:

- Node.js built-ins;
- existing project dependencies;
- a small self-contained implementation.

If a new dependency is necessary, explain why in the PR.

---

# Code Style

Follow the existing codebase conventions.

Prefer:

- clear names;
- small focused functions;
- explicit control flow;
- limited side effects;
- readable tests;
- meaningful comments only where behaviour is non-obvious.

Avoid comments that merely restate the code.

---

# Commit Messages

Use clear scoped commit messages.

Recommended format:

```text
type(scope): description
```

Examples:

```text
feat(policy): add deterministic rule evaluator
feat(stellar): validate Stellar account IDs
fix(api): reject malformed request metadata
test(governance): cover quorum boundary cases
docs(core): update contributor setup
```

---

# Pull Request Requirements

A good pull request should include:

- a clear title;
- a reference to the issue;
- a concise explanation of the implementation;
- tests;
- any important design decisions;
- no unrelated changes.

Reference the issue using:

```text
Closes #123
```

---

# Pull Request Description

Your PR description should explain:

## What changed?

Describe the implementation.

## Why?

Explain the problem being solved.

## How was it tested?

List the commands and tests you ran.

Example:

```text
pnpm typecheck
pnpm build
pnpm test
```

## Any important decisions?

Document:

- trade-offs;
- assumptions;
- unusual edge cases;
- intentionally excluded functionality.

---

# CI and Auto-Merge

GuildPass Core uses GitHub Actions.

The required validation job is:

```text
Build and Test
```

The central Adamantine Guild PR automation checks:

- CI status;
- pending checks;
- failed checks;
- merge conflicts;
- merge eligibility.

A PR with failing required checks will not be auto-merged.

If checks are still running, the automation waits.

If checks pass and the PR is clean, the PR may be merged automatically.

---

# Workflow Changes

Changes under:

```text
.github/workflows/
```

receive additional scrutiny.

Do not modify GitHub Actions workflows as part of an unrelated feature.

Workflow changes may require manual maintainer review before automation is allowed to execute them.

---

# Security-Sensitive Contributions

Changes involving any of the following require extra care:

- authentication;
- authorization;
- wallet ownership;
- access control;
- secrets;
- governance;
- smart contracts;
- workflow permissions;
- cryptographic operations.

Security-sensitive code should include targeted tests and avoid undocumented assumptions.

---

# Issue Scope

Contributor issues include explicit acceptance criteria.

Your implementation should satisfy those criteria without expanding the task unnecessarily.

If you discover a separate problem while working:

- do not silently fold it into the same PR;
- open or suggest a separate issue;
- keep the current PR focused.

---

# Independent Issue Policy

Campaign issues are designed so multiple contributors can work concurrently.

If an issue includes an **Independence Requirement**, it must be respected.

This means:

- do not wait for another open issue;
- do not import code that only exists in another contributor's unmerged branch;
- do not create hidden cross-issue dependencies;
- keep your solution independently mergeable.

---

# Documentation Changes

Update documentation when your contribution changes:

- setup instructions;
- architecture;
- public APIs;
- data models;
- CI behaviour;
- Stellar integration;
- contract interfaces.

Documentation belongs under:

```text
docs/
```

or the relevant public Markdown file.

---

# Security Reporting

Do not report vulnerabilities through public issues.

Follow:

```text
SECURITY.md
```

for responsible disclosure instructions.

---

# Code of Conduct

All contributors must follow:

```text
CODE_OF_CONDUCT.md
```

---

# Need Help?

If an issue is unclear, ask a focused question on the issue before implementing a significantly different interpretation.

Avoid opening large speculative PRs without alignment.

---

Thank you for contributing to GuildPass Core.