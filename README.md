<p align="center">
  <img src="./logo/logo.png" alt="GuildPass Logo" width="180" />
</p>

<h1 align="center">GuildPass Core</h1>

<p align="center">
  <strong>Open infrastructure for membership, access, governance and contribution-driven communities on Stellar.</strong>
</p>

<p align="center">
  <a href="https://github.com/Adamantine-guild/guildpass-core">
    <img src="https://img.shields.io/badge/GitHub-GuildPass%20Core-181717?logo=github" alt="GitHub Repository" />
  </a>
  <img src="https://img.shields.io/badge/Version-Core%20V2-6F42C1" alt="GuildPass Core V2" />
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Stellar-Soroban-7C3AED" alt="Stellar Soroban" />
  <img src="https://img.shields.io/badge/License-See%20LICENSE-blue" alt="License" />
</p>

---

## GuildPass

GuildPass is an open-source infrastructure project for communities that need programmable membership, access control, roles, governance, contribution tracking and rewards.

`guildpass-core` contains the backend and core domain logic behind the GuildPass ecosystem.

The project is being rebuilt as **GuildPass Core V2** with a cleaner architecture, stronger domain boundaries, reproducible infrastructure and a Stellar-first blockchain model.

The goal is not simply to provide membership records. GuildPass is intended to provide a reusable foundation for communities that need to answer questions such as:

- Is this wallet a recognised member of this community?
- Is the membership currently valid?
- Does the member have the required role?
- Should this member be allowed to access a resource?
- What contributions has the member made?
- What rewards or role upgrades have they earned?
- Which governance rules apply to the community?
- What events should be recorded for auditing or downstream processing?
- How should off-chain membership state interact with Stellar smart contracts?

GuildPass Core provides the infrastructure on which those decisions can be built.

---

## Core V2

GuildPass Core V2 is a ground-up rebuild of the original GuildPass Core implementation.

The previous implementation remains preserved in Git history and through the project's pre-rebuild archive, while V2 establishes a smaller and more maintainable foundation for future development.

The rebuild focuses on:

- clear domain models;
- deterministic access decisions;
- modular application services;
- reproducible database migrations;
- strict TypeScript;
- Stellar-native wallet support;
- Soroban smart contracts;
- reliable testing;
- CI-gated pull requests;
- contribution-friendly issue scopes;
- auditable domain events;
- separation between infrastructure and business logic.

---

## Current Status

> GuildPass Core V2 is under active development.

The current V2 foundation includes:

- pnpm workspace configuration;
- TypeScript monorepo configuration;
- shared GuildPass domain types;
- Fastify API foundation;
- environment validation;
- `/health` API endpoint;
- local PostgreSQL infrastructure;
- local Redis infrastructure;
- contributor and repository governance files.

Additional capabilities are being implemented incrementally through scoped contributor issues.

A feature described in the architecture or roadmap below should not automatically be assumed to be production-ready.

---

## Architecture

GuildPass Core is organised as a modular monorepo.

```text
guildpass-core/
│
├── apps/
│   └── api/
│       └── GuildPass HTTP API
│
├── packages/
│   ├── shared-types/
│   │   └── Shared domain contracts and TypeScript types
│   │
│   ├── policy-engine/
│   │   └── Deterministic access-control decisions
│   │
│   ├── constitutional-engine/
│   │   └── Community rules and constitutional constraints
│   │
│   ├── contribution-engine/
│   │   └── Contribution evaluation and scoring
│   │
│   ├── governance-engine/
│   │   └── Community governance logic
│   │
│   └── reward-engine/
│       └── Rewards, badges and role progression
│
├── contracts/
│   └── soroban/
│       └── Stellar Soroban smart contracts
│
├── tests/
│   └── integration/
│
├── docs/
│
├── logo/
│
├── docker-compose.yml
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── package.json
├── .env.example
└── README.md
```

Some directories shown above are part of the V2 architecture and may be introduced as their associated implementation issues are completed.

---

## Core Domains

### Communities

A Community represents an organisation or group operating through GuildPass.

Communities provide the boundary for:

- memberships;
- roles;
- governance;
- resources;
- access decisions;
- contributions;
- rewards.

A community can define its own membership and permission model while using common GuildPass infrastructure.

---

### Membership

Membership represents the relationship between a person or wallet and a GuildPass community.

The V2 domain currently defines membership states including:

```text
active
expired
suspended
```

Membership logic is designed to support:

- membership creation;
- expiry;
- suspension;
- restoration;
- membership-state evaluation;
- eventual Soroban membership representation.

---

### Wallets

GuildPass Core V2 is being designed with a **Stellar-first** wallet model.

Wallet infrastructure will be responsible for:

- validating Stellar addresses;
- linking wallets to members;
- preventing invalid or duplicate wallet relationships;
- providing a stable identity boundary for blockchain interaction.

The shared domain currently defines the supported wallet network as:

```text
stellar
```

Additional chains should only be introduced through an intentional architectural decision rather than by carrying forward legacy multichain complexity.

---

### Roles

Roles provide community-level authorisation.

Built-in role concepts currently include:

```text
admin
member
contributor
```

GuildPass is also designed to support community-defined role definitions.

Roles are expected to participate directly in access decisions and governance policies.

---

### Access Control

Access decisions are intended to be deterministic.

Instead of controllers implementing permission logic independently, GuildPass uses a policy-engine model that evaluates relevant membership and role state and returns an explicit decision.

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

This makes access decisions easier to:

- test;
- audit;
- explain;
- consume from APIs;
- reuse across GuildPass applications.

---

## Planned Access Flow

A typical access request is intended to follow this path:

```text
Client
  │
  ▼
GuildPass API
  │
  ▼
Request validation
  │
  ▼
Community + Membership state
  │
  ▼
Role assignments
  │
  ▼
Policy Engine
  │
  ▼
AccessDecision
  │
  ├── ALLOW
  │
  └── DENY + reason
```

The planned API endpoint for this capability is:

```http
POST /v1/access/check
```

---

## Governance

The GuildPass governance engine will provide reusable domain logic for community governance.

Rather than embedding governance behaviour directly inside routes or database queries, governance rules should be expressed through a dedicated engine.

Planned areas include:

- community rule evaluation;
- permissions;
- governance constraints;
- rule-set validation;
- integration with constitutional rules;
- deterministic governance outcomes.

---

## Constitutional Rules

GuildPass separates general governance logic from constitutional constraints.

The constitutional engine is intended to represent rules that should not be bypassed by ordinary application behaviour.

This provides a foundation for communities that want stronger guarantees around how governance decisions are evaluated.

---

## Contributions

Communities often need more than binary membership.

The GuildPass contribution engine is intended to track and evaluate meaningful participation, providing a foundation for systems such as:

- contributor scores;
- activity thresholds;
- community progression;
- reputation;
- contribution-based privileges;
- reward eligibility.

Contribution logic should remain deterministic and independently testable.

---

## Rewards

The reward engine will use community activity and contribution information to evaluate rewards.

Potential reward outcomes include:

- badges;
- recognition;
- role upgrades;
- progression;
- community-defined rewards.

Reward evaluation should be separated from HTTP controllers and blockchain code so that the same rules can be reused by multiple GuildPass interfaces.

---

## Stellar and Soroban

GuildPass Core V2 is adopting Stellar as its primary blockchain environment.

Smart contracts are located under:

```text
contracts/soroban/
```

The initial contract direction focuses on GuildPass membership.

The Soroban implementation is expected to complement the backend domain rather than duplicate all backend functionality on-chain.

A simplified future relationship is:

```text
GuildPass API
     │
     ├──────────────┐
     │              │
     ▼              ▼
PostgreSQL       Soroban
     │           Contract
     │              │
     └──────┬───────┘
            │
            ▼
      Membership State
```

The exact boundary between on-chain and off-chain responsibilities should remain explicit and documented as the contract architecture develops.

---

## Technology Stack

### Backend

- Node.js 20+
- TypeScript
- Fastify
- Zod

### Package Management

- pnpm
- pnpm workspaces

### Data

- PostgreSQL
- Prisma ORM
- Redis

> Prisma integration is part of the Core V2 implementation roadmap and may depend on the current state of the relevant contributor issues.

### Blockchain

- Stellar
- Soroban
- Rust

### Infrastructure

- Docker
- Docker Compose
- GitHub Actions

---

## Prerequisites

Before working on GuildPass Core, install:

- Node.js 20 or newer
- pnpm
- Docker
- Docker Compose
- Git
- Rust and Stellar/Soroban tooling when working on smart contracts

Check your Node version:

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

## Getting Started

### 1. Fork the repository

Fork:

```text
Adamantine-guild/guildpass-core
```

to your own GitHub account.

---

### 2. Clone your fork

```bash
git clone https://github.com/<YOUR_USERNAME>/guildpass-core.git
cd guildpass-core
```

---

### 3. Add the upstream repository

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

### 4. Install dependencies

```bash
pnpm install --frozen-lockfile
```

For local dependency updates:

```bash
pnpm install
```

---

### 5. Configure environment variables

Copy the example environment file:

```bash
cp .env.example .env
```

The local development defaults are:

```env
NODE_ENV=development
PORT=3000

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/guildpass
DIRECT_URL=postgresql://postgres:postgres@localhost:5432/guildpass

REDIS_URL=redis://localhost:6379
```

Do not commit `.env`.

---

## Local Infrastructure

GuildPass Core uses Docker Compose for local infrastructure.

Start the services:

```bash
docker compose up -d
```

Check them:

```bash
docker compose ps
```

The development stack includes:

```text
PostgreSQL : 5432
Redis      : 6379
```

Stop the stack with:

```bash
docker compose down
```

To also remove local volumes:

```bash
docker compose down -v
```

Use volume deletion carefully because it removes local persisted database data.

---

## Running the API

Start the development server:

```bash
pnpm dev
```

or directly:

```bash
pnpm --filter @guildpass/api dev
```

The default API address is:

```text
http://localhost:3000
```

---

## Health Check

GuildPass Core provides a basic health endpoint:

```http
GET /health
```

Example:

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

Database readiness checks will be incorporated as the persistence layer is completed.

---

## Workspace Commands

### Build all workspaces

```bash
pnpm build
```

Equivalent to:

```bash
pnpm -r build
```

---

### Typecheck

```bash
pnpm typecheck
```

---

### Run tests

```bash
pnpm test
```

---

### Start API development server

```bash
pnpm dev
```

---

## Shared Types

Core domain contracts live in:

```text
packages/shared-types
```

The package is published internally as:

```text
@guildpass/shared-types
```

It should contain definitions that need to be shared across GuildPass modules without introducing infrastructure dependencies.

For example:

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

Shared types should remain focused on domain contracts.

Database clients, HTTP frameworks and application-specific implementation details should not be introduced into this package.

---

## Database

GuildPass Core V2 uses PostgreSQL as its primary relational datastore.

The database layer is being rebuilt with an emphasis on:

- one coherent Prisma schema;
- reproducible migrations;
- clean fresh-database setup;
- explicit relationships;
- predictable constraints;
- testable seed and migration behaviour.

A fresh clone should eventually be able to:

```text
install dependencies
        ↓
start PostgreSQL
        ↓
generate Prisma client
        ↓
apply migrations
        ↓
build
        ↓
test
```

without manual database repair.

---

## Redis

Redis is intended for infrastructure concerns such as access-decision caching.

Redis must not become the source of truth for GuildPass domain state.

The authoritative state should remain in the appropriate persistent domain store.

Caching should be treated as an optimisation layer.

---

## Events and Transactional Outbox

Core V2 will introduce structured domain events and a transactional outbox.

This is intended to support reliable downstream processing without coupling domain operations directly to external consumers.

The general pattern is:

```text
Domain operation
      │
      ▼
Database transaction
      │
      ├── State update
      │
      └── Outbox event
              │
              ▼
       Event processor
```

This ensures important events can be persisted alongside the state transition that produced them.

---

## Auditability

GuildPass infrastructure should make important state changes explainable.

Audit events are planned for operations involving areas such as:

- membership;
- roles;
- access;
- governance;
- rewards;
- administrative actions.

Audit infrastructure should capture meaningful domain activity without leaking sensitive information.

---

# Development Workflow

## Sync your fork

Before starting a new issue:

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
git checkout -b feat/community-service
```

Recommended branch prefixes include:

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

```text
feat/community-service
feat/stellar-wallet-validation
fix/access-decision-state
test/membership-lifecycle
docs/api-architecture
```

---

## Keep Changes Scoped

Each pull request should solve the issue it references.

Avoid combining unrelated:

- refactors;
- dependencies;
- formatting changes;
- new features;
- infrastructure changes

into the same PR unless they are required by the issue.

Smaller scoped PRs are easier to review, test and merge.

---

## Before Opening a Pull Request

Run:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

All applicable checks should pass before submitting your PR.

---

# Continuous Integration

GuildPass Core uses GitHub Actions to validate pull requests.

The Core validation pipeline is intended to run:

```text
dependency installation
        ↓
typecheck
        ↓
build
        ↓
tests
```

The required Core validation job is:

```text
Build and Test
```

Pull requests should not be merged until the required Core CI checks pass.

As database infrastructure matures, validation will also expand to include fresh PostgreSQL and Prisma migration verification.

---

## PR Automation

GuildPass uses central PR automation maintained by Adamantine Guild.

The automation evaluates open contributor pull requests and can:

- inspect workflow status;
- wait for pending checks;
- detect failed checks;
- detect merge conflicts;
- comment when intervention is required;
- safely approve eligible external-contributor workflow runs;
- automatically merge eligible pull requests.

For `guildpass-core`, the required Core CI check must be present and successful before a PR becomes eligible for automatic merging.

The intended flow is:

```text
Contributor opens PR
        │
        ├───────────────┐
        │               │
        ▼               ▼
    Core CI        PR automation
        │               │
        ▼               │
 Build and Test          │
        │               │
        └───────┬───────┘
                │
                ▼
        Evaluate PR state
                │
        ┌───────┼─────────┐
        │       │         │
      Fail   Pending    Success
        │       │         │
        ▼       ▼         ▼
      Block    Wait     Mergeable
```

A failed pipeline does not qualify for auto-merge.

---

## Workflow Security

Pull requests that modify:

```text
.github/workflows/
```

require additional care.

The central automation deliberately avoids blindly approving contributor workflow changes because GitHub Actions workflows can affect repository permissions and execution behaviour.

CI and workflow modifications may therefore require maintainer review.

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

## Contributor Issues

Work should normally begin from an existing GitHub issue.

GuildPass contributor issues generally contain:

- difficulty;
- issue type;
- background;
- problem definition;
- expected outcome;
- suggested implementation;
- acceptance criteria;
- likely affected files or directories.

Campaign issues may also carry labels such as:

```text
Third Campaign
backend
database
stellar
soroban
testing
governance
membership
policy
intermediate
advanced
```

Select an issue that matches your experience and follow the acceptance criteria carefully.

---

## Pull Request Guidelines

When opening a pull request:

1. Reference the issue being solved.
2. Explain what changed.
3. Keep the implementation scoped to the issue.
4. Add or update tests where appropriate.
5. Avoid unrelated formatting or refactoring.
6. Ensure TypeScript typechecking passes.
7. Ensure the project builds.
8. Ensure tests pass.
9. Resolve merge conflicts.
10. Respond to review feedback where necessary.

Example:

```text
Closes #123
```

---

## Commit Messages

Use clear, scoped commit messages.

Recommended format:

```text
type(scope): description
```

Examples:

```text
feat(membership): add membership lifecycle service
fix(policy): handle suspended membership decisions
test(wallet): add Stellar address validation cases
docs(api): document access check contract
ci(core): add database migration verification
```

---

# Contributor Roadmap

Core V2 development is intentionally being broken into smaller independently reviewable pieces.

Major work areas include:

### Foundation

- Prisma and PostgreSQL setup
- core Prisma schema
- reproducible initial migration
- fresh-clone CI validation
- database-aware health checks

### Domain Services

- community service
- Stellar wallet service
- member and membership lifecycle
- roles and role assignments

### Access

- policy engine
- access-check API
- standardised API errors
- Redis access-decision caching

### Infrastructure

- audit events
- transactional outbox
- integration testing

### Community Systems

- governance engine
- contribution engine
- reward engine

### Stellar

- Soroban membership contract
- Soroban contract tests

---

# Design Principles

Contributors should keep the following principles in mind when working on Core V2.

## 1. Domain logic should be explicit

Business rules should not be hidden inside controllers, Prisma calls or route handlers.

---

## 2. Deterministic behaviour is preferred

Given the same valid inputs and state, domain engines should return predictable outcomes.

---

## 3. Infrastructure should not define the domain

PostgreSQL, Redis, Fastify and Soroban are tools used by GuildPass.

The GuildPass domain should remain understandable independently of those tools.

---

## 4. Avoid premature abstraction

V2 intentionally starts smaller than the previous architecture.

Create abstractions when the domain requires them, not solely because they existed in V1.

---

## 5. Migrations must be reproducible

A migration should work against a fresh database without requiring knowledge of a developer's local database history.

---

## 6. Tests are part of the feature

New domain behaviour should include appropriate tests.

Bug fixes should preferably include a regression test.

---

## 7. Security-sensitive changes deserve explicit review

Changes involving:

- authentication;
- wallet ownership;
- permissions;
- access control;
- workflow files;
- smart contracts;
- secrets;
- governance

should be implemented conservatively and reviewed carefully.

---

# Repository History

GuildPass Core V2 is a rebuild, not a deletion of the project's history.

The original implementation remains available through Git history and the repository's preserved pre-rebuild references.

This allows maintainers to inspect earlier implementations when useful without carrying legacy architecture directly into V2.

Contributors should implement against the current Core V2 architecture rather than restoring old V1 modules unless an issue explicitly requests it.

---

# Security

Do not report security vulnerabilities through a public GitHub issue.

Follow the process described in:

```text
SECURITY.md
```

Never commit:

- private keys;
- seed phrases;
- wallet secrets;
- API keys;
- database credentials;
- access tokens;
- production `.env` files.

---

# Documentation

Architecture and implementation documentation should live under:

```text
docs/
```

Documentation should be updated when a change materially affects:

- architecture;
- public APIs;
- data models;
- developer setup;
- smart-contract interfaces;
- contributor workflows.

---

# Licence

GuildPass Core is distributed under the terms described in the repository's:

```text
LICENSE
```

Review the licence before redistributing or integrating the project.

---

# Adamantine Guild

GuildPass is developed as part of the **Adamantine Guild** open-source ecosystem.

Repository:

```text
https://github.com/Adamantine-guild/guildpass-core
```

Organisation:

```text
https://github.com/Adamantine-guild
```

---

<p align="center">
  <strong>GuildPass Core</strong><br />
  Infrastructure for programmable communities.
</p>