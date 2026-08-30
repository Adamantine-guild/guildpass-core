# GuildPass Core V2 Architecture

GuildPass Core V2 is the backend and domain foundation of the GuildPass ecosystem.

The architecture is intentionally modular, Stellar-first, and designed so that individual capabilities can be developed and tested independently.

This document explains the current architectural direction, major components, system boundaries, and design principles.

---

# 1. Architectural Goals

GuildPass Core V2 is designed around the following goals:

- clear separation of domain logic from infrastructure;
- strong TypeScript contracts;
- deterministic behaviour;
- independently testable modules;
- reproducible database migrations;
- minimal hidden coupling;
- explicit security boundaries;
- Stellar-first blockchain support;
- Soroban smart contracts where on-chain behaviour is appropriate;
- contributor-friendly modularity.

V2 is intentionally smaller and cleaner than the previous implementation.

The goal is not to recreate V1 file-for-file.

---

# 2. High-Level System View

GuildPass Core sits between applications and the infrastructure required to manage community state.

```text
Applications
     │
     │ HTTP / SDK
     ▼
GuildPass API
     │
     ├─────────────────────────────┐
     │                             │
     ▼                             ▼
Domain Modules                Infrastructure
     │                             │
     ├── Membership                ├── PostgreSQL
     ├── Roles                     ├── Redis
     ├── Policy                    ├── Logging
     ├── Governance                ├── Events
     ├── Contributions             └── Configuration
     └── Rewards
     │
     ▼
Stellar / Soroban
```

The key architectural rule is:

> Infrastructure supports the domain. It does not define the domain.

---

# 3. Repository Structure

The intended V2 structure is:

```text
guildpass-core/
│
├── apps/
│   └── api/
│       └── HTTP API and application composition
│
├── packages/
│   ├── shared-types/
│   │   └── Shared domain contracts
│   │
│   ├── policy-engine/
│   │   └── Access decision logic
│   │
│   ├── constitutional-engine/
│   │   └── Constitutional constraints
│   │
│   ├── contribution-engine/
│   │   └── Contribution scoring and evaluation
│   │
│   ├── governance-engine/
│   │   └── Governance calculations and rules
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
├── docker-compose.yml
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── package.json
```

Some packages may be introduced incrementally as implementation work is completed.

---

# 4. Application Layer

The main application currently lives under:

```text
apps/api/
```

The API layer is responsible for:

- HTTP routing;
- request validation;
- response formatting;
- dependency composition;
- configuration loading;
- application startup;
- translating domain results into HTTP responses.

The API should not become the primary location for business logic.

For example:

```text
Bad:

Fastify route
  ├── query database
  ├── inspect role
  ├── calculate access
  └── return result
```

Prefer:

```text
Fastify route
  │
  ▼
Application/domain service
  │
  ▼
Policy engine
  │
  ▼
Access decision
```

---

# 5. Domain Modules

Domain modules represent GuildPass business rules.

They should remain testable without requiring:

- a running HTTP server;
- PostgreSQL;
- Redis;
- Stellar RPC;
- external services.

Where infrastructure is required, modules should depend on narrow interfaces rather than concrete clients.

---

# 6. Shared Types

Shared domain contracts live under:

```text
packages/shared-types/
```

Current concepts include:

- `Community`;
- `Membership`;
- `MembershipState`;
- `RoleDefinition`;
- `Wallet`;
- `AccessDecision`.

For example:

```ts
export interface AccessDecision {
  allowed: boolean;
  code: AccessDecisionCode;
  reasons: string[];
}
```

The shared-types package should remain lightweight.

It should not depend on:

- Fastify;
- Prisma;
- Redis;
- Stellar RPC clients;
- application configuration.

---

# 7. Community Domain

A Community represents the primary organisational boundary in GuildPass.

A community can own or define:

- memberships;
- roles;
- policies;
- governance rules;
- contribution rules;
- rewards;
- protected resources.

A conceptual model is:

```text
Community
   │
   ├── Members
   ├── Roles
   ├── Policies
   ├── Governance
   ├── Contributions
   └── Rewards
```

Community-specific state should not leak accidentally into another community boundary.

---

# 8. Membership Domain

Membership represents the relationship between an entity and a community.

Current membership states include:

```text
active
expired
suspended
```

Membership behaviour should distinguish lifecycle state clearly.

For example:

```text
Member exists
    │
    ▼
Membership record
    │
    ├── active
    ├── expired
    └── suspended
```

Membership state should be evaluated explicitly rather than inferred indirectly from unrelated data.

---

# 9. Roles and Permissions

Roles represent named permission groupings.

Built-in role concepts include:

```text
admin
member
contributor
```

Communities may also define custom roles.

Roles should not automatically imply that every access rule is hard-coded around role names.

The intended model is:

```text
Role
  │
  ▼
Permissions
  │
  ▼
Policy evaluation
```

This allows future custom role definitions without rewriting access logic.

---

# 10. Access Control

Access control is one of the central GuildPass domains.

GuildPass Core should produce explicit access decisions rather than returning only a boolean.

Example:

```ts
interface AccessDecision {
  allowed: boolean;
  code: AccessDecisionCode;
  reasons: string[];
}
```

Possible codes include:

```text
ALLOW
NOT_MEMBER
MEMBERSHIP_EXPIRED
MEMBERSHIP_SUSPENDED
INSUFFICIENT_ROLE
DENY
```

A typical flow is:

```text
Access request
     │
     ▼
Validate input
     │
     ▼
Resolve community state
     │
     ▼
Resolve membership state
     │
     ▼
Resolve permissions / roles
     │
     ▼
Policy engine
     │
     ▼
AccessDecision
```

Policy evaluation should remain deterministic.

---

# 11. Policy Engine

The policy engine should operate on supplied facts and rules rather than performing infrastructure access directly.

Prefer:

```text
Input state
   +
Policy rules
   │
   ▼
Policy engine
   │
   ▼
Decision
```

Avoid:

```text
Policy engine
   ├── queries PostgreSQL
   ├── reads Redis
   ├── calls API
   └── evaluates policy
```

The application layer should gather required state and pass it into the policy evaluator.

This keeps the engine:

- deterministic;
- testable;
- reusable;
- easier to audit.

---

# 12. Governance

Governance logic should be separated from persistence and transport.

Potential governance primitives include:

- quorum calculation;
- voting power snapshots;
- delegation graphs;
- proposal eligibility;
- voting thresholds;
- constitutional constraints.

The governance engine should generally operate as:

```text
Governance state + rules
          │
          ▼
   Governance engine
          │
          ▼
  Deterministic result
```

Floating-point arithmetic should be avoided for security-sensitive voting calculations where exact integer arithmetic is possible.

---

# 13. Constitutional Engine

The constitutional engine represents constraints that should sit above ordinary governance configuration.

This distinction allows GuildPass to express rules such as:

```text
Normal governance rule
        │
        ▼
Constitutional constraint
        │
        ▼
Final validity
```

Constitutional rules should remain:

- explicit;
- deterministic;
- auditable;
- independently testable.

---

# 14. Contributions

Contribution logic may evaluate participation and activity.

Examples include:

- completed tasks;
- contribution weights;
- participation scores;
- campaign activity;
- community-defined metrics.

Contribution scoring should be separate from reward issuance.

Conceptually:

```text
Activity
   │
   ▼
Contribution engine
   │
   ▼
Contribution result
```

Then:

```text
Contribution result
   │
   ▼
Reward engine
```

This prevents scoring and reward policy from becoming tightly coupled.

---

# 15. Rewards

Rewards can represent outcomes such as:

- badges;
- role progression;
- recognition;
- allocation decisions.

The reward engine should generally consume explicit inputs rather than querying unrelated infrastructure itself.

Example:

```text
Contribution result
      +
Reward rules
      │
      ▼
Reward engine
      │
      ▼
Reward decision
```

---

# 16. Persistence Layer

PostgreSQL is the primary relational datastore for GuildPass Core V2.

The persistence layer should be responsible for:

- durable state;
- relationships;
- uniqueness;
- referential integrity;
- transactional updates.

Prisma is used as the ORM layer.

Database concerns should remain outside pure domain engines.

---

# 17. Database Migration Philosophy

V1 accumulated migration drift.

V2 intentionally adopts a stricter migration philosophy.

Every migration should:

- work from a clean database;
- avoid depending on local developer state;
- preserve referential integrity;
- be replayable in CI;
- remain aligned with the current Prisma schema.

The desired flow is:

```text
Fresh database
     │
     ▼
Apply all migrations
     │
     ▼
Generate Prisma client
     │
     ▼
Application starts
```

Manual migration repair should never be part of the normal setup process.

---

# 18. Redis

Redis is used for temporary infrastructure concerns such as:

- caching;
- coordination;
- performance optimisations.

Redis should not be the authoritative source of core GuildPass state.

A cache failure should not corrupt authoritative domain data.

---

# 19. Events

GuildPass Core may emit domain events when meaningful state changes occur.

Examples:

```text
MembershipActivated
MembershipSuspended
RoleAssigned
AccessDenied
RewardGranted
```

Events should represent domain facts, not merely technical implementation details.

---

# 20. Transactional Outbox

For reliable event delivery, Core may use a transactional outbox pattern.

The pattern is:

```text
Database transaction
      │
      ├── Update domain state
      │
      └── Write outbox event
              │
              ▼
       Background processor
              │
              ▼
         Event consumer
```

This prevents state changes from succeeding while event publication is silently lost.

---

# 21. Auditability

Security-sensitive actions should be explainable.

Relevant operations may include:

- role assignment;
- membership suspension;
- governance decisions;
- access denials;
- reward issuance;
- administrative changes.

Audit information should avoid leaking secrets or sensitive raw credentials.

---

# 22. Stellar-First Architecture

GuildPass Core V2 is Stellar-first.

The primary blockchain stack is:

```text
Stellar
   │
   ▼
Soroban
   │
   ▼
GuildPass contracts
```

Legacy EVM abstractions are not part of the default V2 architecture.

EVM support should only be reintroduced through an explicit architectural decision.

---

# 23. Stellar Identity

GuildPass may associate members with Stellar accounts.

Stellar account validation should use actual StrKey validation.

Do not rely on:

```text
address.startsWith("G")
```

as sufficient validation.

The system should distinguish:

- valid public account IDs;
- malformed StrKeys;
- invalid checksums;
- unsupported address types.

---

# 24. Soroban Contracts

Soroban contracts live under:

```text
contracts/soroban/
```

On-chain logic should be used selectively.

Not every GuildPass rule belongs on-chain.

A useful boundary is:

```text
Off-chain:
- complex application logic
- rich metadata
- indexing
- analytics
- flexible policy evaluation

On-chain:
- durable contract state
- verifiable authorization
- membership primitives
- blockchain-native interactions
```

The exact boundary should be documented as contracts are introduced.

---

# 25. API Boundary

The API acts as the main external interface to Core.

The API layer should:

- validate input;
- translate HTTP concerns;
- call application/domain services;
- return structured responses.

The API should not expose raw Prisma objects directly.

Public response contracts should remain intentional and stable.

---

# 26. Error Model

Errors should be structured.

Prefer:

```text
code
message
context
```

over relying only on arbitrary free-form strings.

Error responses should not leak:

- stack traces in production;
- database credentials;
- API keys;
- wallet secrets;
- raw authentication headers.

---

# 27. Validation

TypeScript types are not runtime validation.

External input should be validated at trust boundaries.

Examples include:

- API bodies;
- query parameters;
- headers;
- Stellar identifiers;
- encoded payloads;
- timestamps;
- resource identifiers.

---

# 28. Security Boundaries

Important trust boundaries include:

```text
External client
     │
     ▼
HTTP validation
     │
     ▼
Application layer
     │
     ▼
Domain logic
     │
     ▼
Persistence / Stellar
```

Every transition should validate assumptions appropriate to that boundary.

---

# 29. Testing Strategy

Testing should happen at multiple levels.

## Unit Tests

For pure logic such as:

- policy evaluation;
- governance calculations;
- reward allocation;
- parsers;
- validators.

## Integration Tests

For:

- database behaviour;
- API routes;
- Prisma integration;
- Redis behaviour.

## Contract Tests

For:

- Soroban authorization;
- storage behaviour;
- state transitions;
- invalid callers;
- edge cases.

---

# 30. CI Architecture

Core CI validates contributor changes.

The main required job is:

```text
Build and Test
```

The intended flow is:

```text
Pull Request
     │
     ▼
Install
     │
     ▼
Typecheck
     │
     ▼
Build
     │
     ▼
Test
```

A failing required check blocks automatic merging.

---

# 31. Central PR Automation

GuildPass repositories use central automation maintained by Adamantine Guild.

The automation:

- evaluates open PRs;
- checks CI state;
- detects conflicts;
- comments on blocked PRs;
- merges eligible PRs.

For GuildPass Core, the required CI job must be present and successful before automatic merge.

---

# 32. Contributor Modularity

Core V2 intentionally supports concurrent contribution.

Issues should be designed so contributors can work independently.

Avoid architectural patterns where:

```text
Issue B cannot start until Issue A merges
```

unless dependency is genuinely unavoidable.

Prefer:

```text
Issue A ─┐
Issue B ─┼── independently mergeable
Issue C ─┘
```

This is a deliberate design goal of the V2 contributor model.

---

# 33. Dependency Direction

A healthy dependency direction looks like:

```text
Infrastructure
      │
      ▼
Application composition
      │
      ▼
Domain interfaces
      │
      ▼
Pure domain modules
```

Pure domain packages should not import the application layer.

For example:

```text
policy-engine
```

should not import:

```text
apps/api
```

---

# 34. Avoid Global State

Global mutable state makes tests and concurrency harder.

Avoid using process-wide mutable singletons for domain behaviour.

Prefer explicit dependency injection where stateful infrastructure is required.

---

# 35. Time and Randomness

Time-sensitive logic should not depend directly on hidden current time if it needs deterministic testing.

Prefer:

```ts
evaluate(input, now)
```

or an injected clock.

Security-sensitive random values should use cryptographically secure randomness.

---

# 36. Concurrency

Concurrency-sensitive modules should define atomic semantics explicitly.

Examples include:

- idempotency;
- leases;
- deduplication;
- cache coordination;
- event processing.

Avoid patterns such as:

```text
check
then later set
```

when multiple callers may execute concurrently.

---

# 37. Public Contracts

Public contracts include more than HTTP routes.

They also include:

- shared exported types;
- event shapes;
- contract interfaces;
- error codes;
- package APIs.

Changes to these interfaces should be reviewed as compatibility changes.

---

# 38. V1 Compatibility

V2 is not required to preserve every V1 internal abstraction.

V1 remains available through Git history.

If an old feature is genuinely required, it should be reconsidered against the V2 architecture rather than copied blindly.

---

# 39. Architectural Decision Rule

When deciding where functionality belongs, ask:

1. Is it pure business logic?
   - Put it in a domain package.

2. Does it require HTTP?
   - Keep HTTP concerns in the API layer.

3. Does it require persistence?
   - Use repository/infrastructure boundaries.

4. Does it need blockchain state?
   - Isolate Stellar/Soroban integration.

5. Is it reusable across modules?
   - Consider a small focused package.

6. Is it speculative?
   - Do not add it yet.

---

# 40. Summary

GuildPass Core V2 follows a simple architectural philosophy:

```text
Clear contracts
     +
Pure domain logic
     +
Explicit infrastructure
     +
Deterministic behaviour
     +
Strong testing
     =
Maintainable GuildPass Core
```

The architecture should remain understandable even as the system grows.

Complexity should be introduced only when the domain actually requires it.