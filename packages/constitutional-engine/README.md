# @guildpass/constitutional-engine

Higher-order, composable constitutional rule engine for meta-governance and state mutation constraints in the GuildPass ecosystem.

## Overview

While the Policy Engine (`packages/policy-engine`) evaluates runtime access check decisions (`wallet + community + resource -> ALLOW/DENY`) and the Governance Engine (`packages/governance-engine`) evaluates rule predicates (`HasRole`, `RequiresApprovals`), the **Constitutional Engine** evaluates **meta-governance constraints over system mutations** (e.g. role assignments, role revocations, policy updates, access override creations) **before** they are committed to the database.

## Features

- **Mutation Invariants**: Evaluates constraints over target actions (`ROLE_ASSIGNMENT`, `ROLE_REVOCATION`, `POLICY_UPDATE`, `OVERRIDE_CREATE`).
- **Versioned Rule Sets**: Supports per-community rule-set versioning (`version 1, 2, 3...`).
- **Reference Rules**:
  - **Cooldown Rule**: Enforces minimum elapsed duration between state mutations for a target wallet/resource to prevent role thrashing or privilege escalation.
  - **Multi-Admin Approval Rule (N-of-M)**: Requires a threshold $N$ of $M$ valid admin approval records/signatures before a critical mutation can proceed.
- **Full Explainability**: Generates step-by-step evaluation traces with detailed metadata for audit logging.

## Usage Example

```typescript
import { ConstitutionalEngine, ConstitutionalRuleSet, MutationContext } from '@guildpass/constitutional-engine';

const engine = new ConstitutionalEngine();

const ruleSet: ConstitutionalRuleSet = {
  id: 'ruleset-dev-v1',
  communityId: 'dev-community',
  version: 1,
  rules: [
    {
      id: 'cooldown-rule-1',
      name: '24-Hour Role Change Cooldown',
      targetAction: 'ROLE_ASSIGNMENT',
      precedence: 100,
      effect: 'DENY',
      type: 'COOLDOWN',
      params: { minIntervalSeconds: 86400 }
    }
  ]
};

const context: MutationContext = {
  action: 'ROLE_ASSIGNMENT',
  communityId: 'dev-community',
  actorWallet: '0x1111111111111111111111111111111111111111',
  targetWallet: '0x2222222222222222222222222222222222222222',
  previousMutationTimestamp: new Date(Date.now() - 3600 * 1000) // 1 hour ago
};

const result = engine.evaluate(ruleSet, context);
console.log(result.allowed); // false
console.log(result.code); // 'CONSTITUTIONAL_DENY'
console.log(engine.formatTrace(result));
```
