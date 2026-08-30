<p align="center">
  <img src="./logo/logo.png" alt="GuildPass Core Logo" width="220" />
</p>

<h1 align="center">GuildPass Core</h1>

<p align="center">
  <strong>Open infrastructure for programmable membership, access control, governance, contributions, rewards, and Stellar-native communities.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-24+-339933?logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Stellar-Soroban-7C3AED" alt="Stellar Soroban" />
  <img src="https://img.shields.io/badge/PostgreSQL-15-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white" alt="Redis" />
  <img src="https://img.shields.io/badge/License-MIT-blue" alt="MIT License" />
</p>

---

## What is GuildPass Core?

GuildPass Core is the backend and domain layer of the GuildPass ecosystem.

GuildPass is designed for communities that need more than a simple list of members. It provides infrastructure for:

- membership;
- roles;
- access control;
- governance;
- contribution tracking;
- rewards;
- auditability;
- Stellar and Soroban integration.

GuildPass Core contains the logic and services that make those capabilities possible.

A GuildPass-powered application should be able to ask questions such as:

- Is this person an active member?
- Has their membership expired or been suspended?
- What roles do they hold?
- Are they allowed to access a protected resource?
- What contributions have they made?
- What rewards are they eligible for?
- What governance rules apply?
- How should membership interact with Stellar and Soroban?

GuildPass Core is the system responsible for answering those questions.

---

# For Non-Technical Readers

GuildPass Core can be thought of as the **engine behind a community platform**.

A community application might show:

- member profiles;
- private spaces;
- contributor badges;
- governance proposals;
- rewards;
- wallet-based membership.

The application itself does not need to contain all the logic for deciding who is allowed to do what.

Instead:

```text
Application
    │
    ▼
GuildPass Core
    │
    ├── Membership
    ├── Roles
    ├── Access decisions
    ├── Governance
    ├── Contributions
    ├── Rewards
    └── Stellar / Soroban
```

GuildPass Core provides the reusable infrastructure underneath those features.

---

# GuildPass Core V2

The current repository contains **GuildPass Core V2**, a ground-up rebuild of the original Core implementation.

The previous version had accumulated a large amount of functionality and migration history. V2 was created to establish a cleaner and more maintainable foundation.

The rebuild focuses on:

- smaller, well-defined modules;
- strict TypeScript;
- reproducible database migrations;
- deterministic domain logic;
- clear separation between business rules and infrastructure;
- Stellar-first blockchain support;
- Soroban smart contracts;
- safer CI and contributor workflows;
- independently testable components.

The original implementation remains preserved in Git history and the repository's archived pre-rebuild references.

---

# Current Status

> GuildPass Core V2 is under active development.

The current V2 foundation includes:

- pnpm workspace configuration;
- TypeScript monorepo setup;
- shared GuildPass domain types;
- Fastify API foundation;
- environment configuration;
- `/health` endpoint;
- PostgreSQL local infrastructure;
- Redis local infrastructure;
- CI validation;
- contributor automation.

Additional functionality is being added through scoped contributor issues.

Not every feature described in this README should be assumed to be fully implemented yet.

---

# Architecture

GuildPass Core V2 follows a modular monorepo structure.

```text
guildpass-core/
│
├── apps/
│   └── api/
│       └── GuildPass HTTP API
│
├── packages/
│   ├── shared-types/
│   │   └── Shared domain types
│   │
│   ├── policy-engine/
│   │   └── Access decision logic
│   │
│   ├── constitutional-engine/
│   │   └── Community constitutional rules
│   │
│   ├── contribution-engine/
│   │   └── Contribution scoring
│   │
│   ├── governance-engine/
│   │   └── Governance rules and calculations
│   │
│   └── reward-engine/
│       └── Reward and progression logic
│
├── contracts/
│   └── soroban/
│       └── Stellar Soroban contracts
│
├── tests/
│   └── integration/
│
├── docs/
├── logo/
├── docker-compose.yml
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── package.json
├── .env.example
└── README.md
```

Some modules shown above may still be introduced incrementally as their implementation issues are completed.

---

# Core Concepts

## Communities

A community is the main organisational boundary in GuildPass.

A community can define its own:

- members;
- roles;
- governance rules;
- resources;
- access policies;
- contribution models;
- rewards.

---

## Membership

Membership represents the relationship between a person or wallet and a GuildPass community.

Current membership states include:

```text
active
expired
suspended
```

Membership logic is expected to support:

- creation;
- expiry;
- suspension;
- restoration;
- eligibility checks;
- future on-chain representation.

---

## Roles

Roles represent permissions or responsibilities inside a community.

Built-in role concepts include:

```text
admin
member
contributor
```

GuildPass is also designed to support community-defined roles.

---

## Access Control

GuildPass Core is designed around explicit access decisions.

A decision can return more than a simple boolean.

Example:

```ts
interface AccessDecision {
  allowed: boolean;
  code: AccessDecisionCode;
  reasons: string[];
}
```

Possible decision codes include:

```text
ALLOW
NOT_MEMBER
MEMBERSHIP_EXPIRED
MEMBERSHIP_SUSPENDED
INSUFFICIENT_ROLE
DENY
```

This makes access behaviour easier to:

- test;
- audit;
- debug;
- expose through APIs;
- reuse across applications.

---

## Governance

GuildPass governance functionality is intended to provide reusable logic for:

- rules;
- voting;
- quorum;
- delegation;
- eligibility;
- proposal constraints;
- constitutional requirements.

Governance calculations should remain deterministic and testable independently of API routes.

---

## Contributions

The contribution system is intended to help communities evaluate meaningful participation.

Examples may include:

- contribution scores;
- activity metrics;
- completed tasks;
- participation thresholds;
- contributor progression.

---

## Rewards

GuildPass rewards may be derived from:

- contribution activity;
- participation;
- governance outcomes;
- community-defined rules.

Potential outcomes include:

- badges;
- recognition;
- role progression;
- reward allocations.

---

# Stellar and Soroban

GuildPass Core V2 is Stellar-first.

The current blockchain direction uses:

- Stellar accounts;
- Soroban smart contracts;
- Rust for contract development.

The previous EVM-oriented architecture is not the default direction for V2.

Blockchain logic should remain clearly separated from the rest of the application.

Conceptually:

```text
GuildPass API
      │
      ├──────────────┐
      │              │
      ▼              ▼
PostgreSQL        Soroban
      │           Contracts
      │              │
      └──────┬───────┘
             │
             ▼
       GuildPass State
```

---

# Technology Stack

## Backend

- Node.js 24+
- TypeScript
- Fastify
- Zod

## Package Management

- pnpm
- pnpm workspaces

## Data

- PostgreSQL 15
- Prisma
- Redis 7

## Blockchain

- Stellar
- Soroban
- Rust

## Tooling

- Docker
- Docker Compose
- GitHub Actions

---

# Prerequisites

Install:

- Git
- Node.js 24 or newer
- pnpm 11.x
- Docker
- Docker Compose
- Rust and Stellar tooling when working on Soroban contracts

Check Node:

```bash
node --version
```

Check pnpm:

```bash
pnpm --version
```

The repository currently uses:

```text
pnpm 11.16.0
```

---

# Getting Started

## 1. Fork the repository

Fork:

```text
Adamantine-guild/guildpass-core
```

---

## 2. Clone your fork

```bash
git clone https://github.com/<YOUR_USERNAME>/guildpass-core.git
cd guildpass-core
```

---

## 3. Add the upstream repository

```bash
git remote add upstream https://github.com/Adamantine-guild/guildpass-core.git
```

Verify:

```bash
git remote -v
```

---

## 4. Install dependencies

```bash
pnpm install
```

For CI-style reproducibility:

```bash
pnpm install --frozen-lockfile
```

If pnpm asks you to approve expected dependency build scripts:

```bash
pnpm approve-builds
```

---

# Environment Configuration

Create your local environment file:

```bash
cp .env.example .env
```

The local defaults are:

```env
NODE_ENV=development
PORT=3000

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/guildpass
DIRECT_URL=postgresql://postgres:postgres@localhost:5432/guildpass

REDIS_URL=redis://localhost:6379
```

Do not commit `.env`.

---

# Start Local Infrastructure

GuildPass Core uses Docker Compose for PostgreSQL and Redis.

Start:

```bash
docker compose up -d
```

Check:

```bash
docker compose ps
```

Expected local services:

```text
PostgreSQL : 5432
Redis      : 6379
```

Stop:

```bash
docker compose down
```

To remove local volumes as well:

```bash
docker compose down -v
```

Use the volume-removal command carefully because it deletes local database data.

---

# Run the API

Start development mode:

```bash
pnpm dev
```

or:

```bash
pnpm --filter @guildpass/api dev
```

Default API address:

```text
http://localhost:3000
```

---

# Health Check

The API exposes:

```http
GET /health
```

Test it:

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{
  "status": "ok",
  "service": "guildpass-core-api"
}
```

---

# Development Commands

## Typecheck

```bash
pnpm typecheck
```

---

## Build

```bash
pnpm build
```

---

## Test

```bash
pnpm test
```

---

## Start development server

```bash
pnpm dev
```

---

# Database

GuildPass Core V2 uses PostgreSQL as its primary relational datastore.

The V2 database approach is designed around:

- a coherent Prisma schema;
- reproducible migrations;
- fresh-database compatibility;
- explicit constraints;
- predictable relations;
- CI migration verification.

The intended development flow is:

```text
install dependencies
        ↓
start PostgreSQL
        ↓
generate Prisma client
        ↓
apply migrations
        ↓
typecheck
        ↓
build
        ↓
test
```

Database migrations should work against a fresh database without requiring manual repair.

---

# Redis

Redis is used for infrastructure concerns such as caching.

Redis must not become the authoritative source of GuildPass domain state.

The database and relevant domain systems remain the source of truth.

---

# Shared Types

Shared domain contracts live under:

```text
packages/shared-types
```

The package is exposed internally as:

```text
@guildpass/shared-types
```

Examples include:

```ts
export interface Community {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
}
```

and:

```ts
export interface AccessDecision {
  allowed: boolean;
  code: AccessDecisionCode;
  reasons: string[];
}
```

Shared types should remain free of unnecessary infrastructure dependencies.

---

# Design Principles

## 1. Domain logic should be explicit

Business rules should not be hidden inside:

- controllers;
- database queries;
- route handlers;
- middleware.

---

## 2. Keep modules independently testable

A policy calculator should be testable without starting a database.

A governance calculation should not require the API server.

A Stellar parser should not require a network request.

---

## 3. Prefer deterministic behaviour

Given the same inputs and state, domain logic should return the same result.

---

## 4. Keep infrastructure separate from business rules

Fastify, PostgreSQL, Redis, and Soroban are infrastructure.

GuildPass domain behaviour should remain understandable without them.

---

## 5. Avoid rebuilding V1 accidentally

Core V2 is intentionally smaller.

Do not recreate old architecture unless there is a specific approved requirement.

---

## 6. Migrations must be reproducible

Database migrations must work on a fresh database.

Local database history should never be required for a migration to succeed.

---

## 7. Tests are part of the implementation

New logic should include relevant tests.

Bug fixes should preferably include regression tests.

---

# Continuous Integration

GuildPass Core uses GitHub Actions to validate pull requests.

The Core pipeline performs:

```text
Install dependencies
        ↓
Typecheck
        ↓
Build
        ↓
Test
```

The required job is:

```text
Build and Test
```

Pull requests are not eligible for automatic merging until this check passes.

---

# PR Automation

GuildPass repositories use central PR automation maintained by Adamantine Guild.

The automation can:

- inspect CI checks;
- detect pending workflows;
- detect failed checks;
- detect merge conflicts;
- comment on blocked pull requests;
- approve eligible external-contributor workflows;
- merge eligible pull requests.

For `guildpass-core`, the required CI check must exist and succeed before auto-merge is allowed.

The flow is:

```text
Contributor opens PR
        │
        ├──────────────┐
        │              │
        ▼              ▼
     Core CI      PR Automation
        │              │
        ▼              │
  Build and Test       │
        │              │
        └──────┬───────┘
               │
               ▼
       Evaluate PR state
               │
      ┌────────┼────────┐
      │        │        │
    Failed   Pending   Passed
      │        │        │
      ▼        ▼        ▼
    Block     Wait     Merge
```

---

# Contributing

Contributions are welcome.

Before contributing, read:

```text
CONTRIBUTING.md
CODE_OF_CONDUCT.md
SECURITY.md
```

---

# Contributor Workflow

## Sync your fork

```bash
git checkout main
git fetch upstream
git pull upstream main
git push origin main
```

---

## Create a feature branch

Do not work directly on `main`.

Example:

```bash
git checkout -b feat/stellar-address-validation
```

Recommended prefixes:

```text
feat/
fix/
test/
docs/
refactor/
chore/
ci/
```

---

## Work on one issue

Contributor issues are intentionally scoped so multiple contributors can work concurrently.

Do not make your issue depend on another open issue unless the issue explicitly says so.

---

## Validate your work

Before opening a PR:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

---

## Open a pull request

Reference the issue:

```text
Closes #123
```

Your PR should explain:

- what changed;
- why;
- how it works;
- what tests were added;
- any important design decisions.

---

# Contributor Issues

GuildPass Core contributor issues may include labels such as:

```text
Third Campaign
advanced
expert
backend
database
stellar
soroban
policy
governance
membership
roles
testing
security
performance
```

Issues should be treated as the source of truth for implementation scope.

Avoid expanding a contribution far beyond the issue acceptance criteria.

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

# Security

Never commit:

- private keys;
- Stellar secret keys;
- seed phrases;
- API tokens;
- database passwords;
- production credentials;
- `.env` files containing secrets.

Security vulnerabilities should not be disclosed through public GitHub issues.

Follow:

```text
SECURITY.md
```

for responsible disclosure instructions.

---

# Repository History

GuildPass Core V2 is a rebuild, not a deletion of the original project.

The pre-rebuild implementation remains available through Git history and preserved archive references.

Contributors should build against the current `main` branch and current V2 architecture unless an issue explicitly says otherwise.

---

# Documentation

Architecture and implementation documentation belongs under:

```text
docs/
```

Documentation should be updated when a change materially affects:

- architecture;
- APIs;
- data models;
- contributor setup;
- CI;
- Stellar integration;
- Soroban contracts.

---

# Licence

GuildPass Core is distributed under the MIT License.

See:

```text
LICENSE
```

for the complete terms.

---

# Adamantine Guild

GuildPass is developed as part of the Adamantine Guild open-source ecosystem.

### GuildPass Core

```text
https://github.com/Adamantine-guild/guildpass-core
```

### Adamantine Guild

```text
https://github.com/Adamantine-guild
```

---

<p align="center">
  <img src="./logo/logo.png" alt="GuildPass Core Logo" width="110" />
</p>

<p align="center">
  <strong>GuildPass Core</strong><br />
  Infrastructure for programmable communities.
</p>