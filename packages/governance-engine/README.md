# Constitutional Rule Engine

A composable, JSON-based governance rule system that extends the static policy engine with complex, multi-party conditional logic.

## Overview

The Constitutional Rule Engine provides a way to define custom, explainable governance rules using a JSON-based Abstract Syntax Tree (AST). Rules are composed from primitive predicates and boolean combinators, creating transparent and verifiable access control logic.

### Key Features

- **JSON-Serializable ASTs**: All rules are data structures - NO executable code
- **Transparent Evaluation**: Every evaluation produces a human-readable trace
- **Composable Primitives**: Build complex rules from simple building blocks
- **Type-Safe**: TypeScript types ensure correctness at compile time
- **Runtime Validated**: AST validation prevents injection attacks
- **Integration Ready**: Works alongside existing policy engine

### Design Philosophy

1. **Simple, Explainable**: Every rule can be understood by non-technical stakeholders
2. **No Code Execution**: Rules are data, not code - eliminates security risks
3. **Verifiable**: Complete audit trail of every decision
4. **Composable**: Small primitives combine into complex logic

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ JSON Rule Definition (AST)                              │
│ {                                                       │
│   type: "AND",                                          │
│   rules: [                                              │
│     { type: "HasRole", role: "admin" },                 │
│     { type: "MinContributionScore", score: 100 }        │
│   ]                                                     │
│ }                                                       │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│ Validator (validator.ts)                                │
│ - Validates AST structure                               │
│ - Prevents injection attacks                            │
│ - Enforces depth/size limits                            │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│ Evaluator (evaluator.ts)                                │
│ - Evaluates AST against context                         │
│ - Produces evaluation trace                             │
│ - Returns allow/deny decision                           │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│ Evaluation Result + Trace                               │
│ {                                                       │
│   allowed: true,                                        │
│   trace: {                                              │
│     ruleType: "AND",                                    │
│     evaluated: true,                                    │
│     details: "All 2 conditions passed",                 │
│     children: [...]                                     │
│   }                                                     │
│ }                                                       │
└─────────────────────────────────────────────────────────┘
```

## Primitive Predicates

### HasRole

Checks if the user has a specific role.

```typescript
{
  type: "HasRole",
  role: "admin" | "contributor" | "member"
}
```

**Example:**
```json
{ "type": "HasRole", "role": "admin" }
```

### MinContributionScore

Checks if the user's contribution score meets a minimum threshold.

```typescript
{
  type: "MinContributionScore",
  score: number
}
```

**Example:**
```json
{ "type": "MinContributionScore", "score": 100 }
```

### HasMembershipState

Checks if the user has a specific membership state.

```typescript
{
  type: "HasMembershipState",
  state: "invited" | "active" | "expired" | "suspended"
}
```

**Example:**
```json
{ "type": "HasMembershipState", "state": "active" }
```

### RequiresApprovals

Checks if the required number of approvals from a specific role exists.

```typescript
{
  type: "RequiresApprovals",
  threshold: number,
  approverRole: "admin" | "contributor" | "member",
  requestId?: string
}
```

**Example:**
```json
{
  "type": "RequiresApprovals",
  "threshold": 2,
  "approverRole": "admin"
}
```

## Boolean Combinators

### AND

All child rules must evaluate to true.

```typescript
{
  type: "AND",
  rules: RuleNode[]
}
```

**Example:**
```json
{
  "type": "AND",
  "rules": [
    { "type": "HasRole", "role": "admin" },
    { "type": "HasMembershipState", "state": "active" }
  ]
}
```

### OR

At least one child rule must evaluate to true.

```typescript
{
  type: "OR",
  rules: RuleNode[]
}
```

**Example:**
```json
{
  "type": "OR",
  "rules": [
    { "type": "HasRole", "role": "admin" },
    { "type": "HasRole", "role": "contributor" }
  ]
}
```

### NOT

Negates the child rule.

```typescript
{
  type: "NOT",
  rule: RuleNode
}
```

**Example:**
```json
{
  "type": "NOT",
  "rule": { "type": "HasRole", "role": "member" }
}
```

### N_OF_M

At least N of M child rules must evaluate to true.

```typescript
{
  type: "N_OF_M",
  n: number,
  rules: RuleNode[]
}
```

**Example:**
```json
{
  "type": "N_OF_M",
  "n": 2,
  "rules": [
    { "type": "HasRole", "role": "admin" },
    { "type": "HasRole", "role": "contributor" },
    { "type": "MinContributionScore", "score": 50 }
  ]
}
```

## Usage Examples

### Example 1: Simple Admin Check

```typescript
import { evaluateRule, createGovernanceContext } from '@guildpass/governance-engine';

const rule = {
  type: "HasRole",
  role: "admin"
};

const context = createGovernanceContext(
  "0xalice",
  "community-1",
  {
    assignments: [{ role: "admin", source: "manual", active: true }],
    membershipState: "active"
  },
  { total: 0 }
);

const result = evaluateRule(rule, context);
console.log(result.allowed); // true
console.log(formatTrace(result.trace));
// ✓ HasRole: User has role "admin"
```

### Example 2: Complex Governance Rule

**Rule:** Admin OR (Contributor AND MinScore >= 100)

```typescript
const rule = {
  type: "OR",
  rules: [
    { type: "HasRole", role: "admin" },
    {
      type: "AND",
      rules: [
        { type: "HasRole", role: "contributor" },
        { type: "MinContributionScore", score: 100 }
      ]
    }
  ]
};

// Test as contributor with high score
const contributorContext = createGovernanceContext(
  "0xbob",
  "community-1",
  {
    assignments: [{ role: "contributor", source: "manual", active: true }],
    membershipState: "active"
  },
  { total: 150 }
);

const result = evaluateRule(rule, contributorContext);
console.log(result.allowed); // true
console.log(formatTrace(result.trace));
// ✓ OR: 1 of 2 conditions passed (at least 1 required)
//   ✗ HasRole: User does not have role "admin"
//   ✓ AND: All 2 conditions passed
//     ✓ HasRole: User has role "contributor"
//     ✓ MinContributionScore: User contribution score 150 meets minimum 100
```

### Example 3: Multi-Party Approval

**Rule:** Requires 2-of-3 admin approvals

```typescript
const rule = {
  type: "RequiresApprovals",
  threshold: 2,
  approverRole: "admin",
  requestId: "proposal-123"
};

const approvals = [
  {
    id: "1",
    requestId: "proposal-123",
    approverWallet: "0xadmin1",
    approverRole: "admin",
    approved: true,
    timestamp: new Date().toISOString()
  },
  {
    id: "2",
    requestId: "proposal-123",
    approverWallet: "0xadmin2",
    approverRole: "admin",
    approved: true,
    timestamp: new Date().toISOString()
  }
];

const context = createGovernanceContext(
  "0xproposer",
  "community-1",
  { assignments: [], membershipState: "active" },
  { total: 0 },
  approvals,
  "proposal-123"
);

const result = evaluateRule(rule, context);
console.log(result.allowed); // true
console.log(result.trace.details);
// "Has 2 of 2 required approvals from role 'admin'"
```

## Security

### No Code Execution

The engine **never** executes arbitrary code:

```typescript
// ❌ NEVER SUPPORTED - would be a security vulnerability
const maliciousRule = {
  type: "CustomFunction",
  code: "eval('malicious code')"
};

// ✅ ONLY SUPPORTED - pure data structures
const safeRule = {
  type: "HasRole",
  role: "admin"
};
```

### Validation Prevents Injection

All rules are validated before evaluation:

```typescript
import { validateRuleAST } from '@guildpass/governance-engine';

const suspiciousRule = {
  type: "HasRole",
  role: "admin",
  __proto__: { malicious: true }, // Injection attempt
  eval: "bad code" // Injection attempt
};

const validation = validateRuleAST(suspiciousRule);
console.log(validation.valid); // false
console.log(validation.errors);
// ["Unexpected properties in HasRole node: __proto__, eval"]
```

### Depth Limits

Prevents stack overflow attacks:

```typescript
// ❌ Rejected - exceeds max depth of 10
let deepRule = { type: "HasRole", role: "admin" };
for (let i = 0; i < 15; i++) {
  deepRule = { type: "AND", rules: [deepRule] };
}

const validation = validateRuleAST(deepRule);
console.log(validation.valid); // false
console.log(validation.errors);
// ["Rule nesting exceeds maximum depth of 10"]
```

## API Integration

### Creating a Governance Rule

```http
POST /v1/governance/rules
Content-Type: application/json

{
  "name": "Admin or High Contributor",
  "description": "Allows admins or contributors with score >= 100",
  "communityId": "guild-dev",
  "resource": "proposal-voting",
  "ast": {
    "type": "OR",
    "rules": [
      { "type": "HasRole", "role": "admin" },
      {
        "type": "AND",
        "rules": [
          { "type": "HasRole", "role": "contributor" },
          { "type": "MinContributionScore", "score": 100 }
        ]
      }
    ]
  }
}
```

### Evaluating a Rule

```http
POST /v1/governance/rules/:ruleId/evaluate
Content-Type: application/json

{
  "wallet": "0xalice...",
  "communityId": "guild-dev",
  "requestId": "proposal-123"
}
```

**Response:**
```json
{
  "allowed": true,
  "trace": {
    "ruleType": "OR",
    "evaluated": true,
    "details": "1 of 2 conditions passed (at least 1 required)",
    "children": [...]
  },
  "formattedTrace": "✓ OR: 1 of 2 conditions passed..."
}
```

## Testing

```bash
cd packages/governance-engine
npm test
```

### Test Coverage

- ✅ AST validation (all primitives and combinators)
- ✅ Injection prevention
- ✅ Depth limit enforcement
- ✅ Primitive predicate evaluation
- ✅ Boolean combinator logic
- ✅ Complex nested rules
- ✅ Multi-party approvals
- ✅ Trace formatting
- ✅ JSON parsing and validation

## Migration from Static Policies

The governance engine **coexists** with the static policy engine:

```typescript
// Static policy (existing)
const staticPolicy = {
  ruleType: "ADMINS_ONLY",
  resource: "admin-panel"
};

// Governance rule (new)
const governanceRule = {
  ast: {
    type: "AND",
    rules: [
      { type: "HasRole", role: "admin" },
      { type: "MinContributionScore", score: 50 }
    ]
  }
};
```

### Migration Path

1. **Keep existing static policies** for simple cases
2. **Add governance rules** for complex scenarios
3. **Gradually migrate** static policies to governance rules as needed

## Best Practices

### 1. Start Simple

```json
// Good - simple and clear
{
  "type": "HasRole",
  "role": "admin"
}

// Avoid - overly complex for simple cases
{
  "type": "AND",
  "rules": [
    {
      "type": "OR",
      "rules": [
        { "type": "HasRole", "role": "admin" }
      ]
    }
  ]
}
```

### 2. Name Rules Descriptively

```typescript
// Good
{
  name: "High-Value Proposal Approval",
  description: "Requires 3-of-5 admin approvals for proposals > $10k"
}

// Avoid
{
  name: "Rule 1",
  description: "Admin rule"
}
```

### 3. Document Complex Logic

```typescript
// Good - document the intent
{
  name: "Contributor Voting Rights",
  description: "Contributors can vote if they have >= 100 score OR are active for >= 30 days",
  ast: {
    type: "AND",
    rules: [
      { type: "HasRole", role: "contributor" },
      {
        type: "OR",
        rules: [
          { type: "MinContributionScore", score: 100 },
          // Note: time-based rules not yet implemented
        ]
      }
    ]
  }
}
```

### 4. Test Rules Before Deployment

```typescript
import { validateRuleAST } from '@guildpass/governance-engine';

const rule = { /* your rule */ };

// Always validate before saving
const validation = validateRuleAST(rule);
if (!validation.valid) {
  console.error('Invalid rule:', validation.errors);
  return;
}

// Save to database
await governanceService.createRule({ ...ruleData, ast: rule });
```

## Limitations

### Current Limitations

1. **No Time-Based Predicates**: Currently cannot check "member for > 30 days"
2. **No External Data**: Cannot query external APIs or oracles
3. **No Arithmetic**: Cannot perform calculations (e.g., score1 + score2 > 100)
4. **No String Operations**: Cannot check string patterns or regex

### Future Enhancements

- Time-based predicates (MemberSince, ActiveFor)
- Token balance predicates (MinTokenBalance)
- NFT ownership predicates (OwnsNFT)
- Delegation support (DelegatedBy)
- Custom predicate plugins

## Troubleshooting

### Rule Validation Fails

**Problem:** `Invalid rule AST: Unknown rule type`

**Solution:** Check that all `type` fields match exactly (case-sensitive):
- `HasRole`, not `hasRole` or `HAS_ROLE`
- `AND`, not `And` or `and`

### Evaluation Returns Unexpected Result

**Problem:** Rule evaluates to false but should be true

**Solution:** Use `formatTrace()` to see the detailed evaluation:

```typescript
const result = evaluateRule(rule, context);
console.log(formatTrace(result.trace));
// Examine each step to find where it fails
```

### Performance Issues

**Problem:** Rule evaluation is slow

**Solution:**
- Reduce rule nesting depth
- Simplify complex OR branches
- Cache contribution scores
- Pre-fetch approvals

## Contributing

When adding new predicates or combinators:

1. Add type definition to `ast.ts`
2. Add validation logic to `validator.ts`
3. Add evaluation logic to `evaluator.ts`
4. Add comprehensive tests to `test/governance.test.ts`
5. Update this README with examples
6. Update API documentation

## License

Part of the GuildPass project - see root LICENSE file.
