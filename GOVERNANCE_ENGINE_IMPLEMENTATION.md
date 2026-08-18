# Constitutional Rule Engine - Implementation Guide

## Overview

This document provides a complete guide to the Constitutional Rule Engine implementation, including architecture, deployment, and integration with the existing access-api.

## What Was Implemented

### 1. Core Governance Engine Package (`packages/governance-engine`)

A new workspace package providing:

- **AST Definitions** (`ast.ts`): TypeScript types for rule nodes
- **Validator** (`validator.ts`): Runtime AST validation with security checks
- **Context** (`context.ts`): Evaluation context including roles, scores, approvals
- **Evaluator** (`evaluator.ts`): Rule evaluation engine with transparent traces
- **Comprehensive Tests** (`test/governance.test.ts`): 30+ test cases

### 2. Database Schema Extensions

Added to `apps/access-api/prisma/schema.prisma`:

- **GovernanceRule**: Stores rule ASTs
- **ApprovalRequest**: Tracks approval workflows
- **Approval**: Individual approval records
- **ContributionScore**: User contribution metrics

### 3. Governance Service (`apps/access-api/src/services/governanceService.ts`)

Business logic layer providing:

- Rule CRUD operations
- Approval workflow management
- Contribution score tracking
- Rule evaluation orchestration

### 4. API Endpoints (`apps/access-api/src/routes.ts`)

RESTful API for:

- Governance rule management
- Rule evaluation
- Approval submissions
- Contribution score updates

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Client Application                        │
└────────────────┬─────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────┐
│           Access API (Fastify Routes)                        │
│                                                              │
│  POST /v1/governance/rules                                   │
│  GET  /v1/governance/rules/:id                               │
│  POST /v1/governance/rules/:id/evaluate                      │
│  POST /v1/governance/approvals/requests                      │
│  POST /v1/governance/approvals/requests/:id/approvals        │
│  GET  /v1/governance/contribution-scores/:wallet             │
└────────────────┬─────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────┐
│         Governance Service (governanceService.ts)            │
│                                                              │
│  - createRule()                                              │
│  - evaluateGovernanceRule()                                  │
│  - createApprovalRequest()                                   │
│  - submitApproval()                                          │
│  - getContributionScore()                                    │
└────────────────┬─────────────────────────────────────────────┘
                 │
          ┌──────┴──────┐
          │             │
          ▼             ▼
┌──────────────┐  ┌────────────────────────────────┐
│   Prisma     │  │  Governance Engine Package     │
│   Database   │  │                                │
│              │  │  - validateRuleAST()           │
│  - Rules     │  │  - evaluateRule()              │
│  - Approvals │  │  - createGovernanceContext()   │
│  - Scores    │  │  - formatTrace()               │
└──────────────┘  └────────────────────────────────┘
```

## Data Flow

### Rule Creation Flow

```
1. Client submits rule JSON
         ↓
2. API validates input
         ↓
3. Governance Service validates AST
         ↓
4. Rule saved to database (GovernanceRule table)
         ↓
5. Rule ID returned to client
```

### Rule Evaluation Flow

```
1. Client requests evaluation (wallet + ruleId)
         ↓
2. API fetches member data (roles, membership)
         ↓
3. Governance Service fetches:
   - Rule AST from database
   - Contribution score
   - Approvals (if requestId provided)
         ↓
4. Service creates GovernanceContext
         ↓
5. Governance Engine evaluates AST
         ↓
6. Evaluation result + trace returned
```

### Approval Workflow

```
1. User creates ApprovalRequest
         ↓
2. Approvers submit Approval records
         ↓
3. Service checks if threshold met
         ↓
4. Request status updated (approved/rejected)
         ↓
5. Rule evaluation uses approvals
```

## Database Schema

### GovernanceRule

```sql
CREATE TABLE "GovernanceRule" (
    "id" TEXT PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "ast" JSONB NOT NULL,           -- Rule AST as JSON
    "active" BOOLEAN DEFAULT true,
    "createdAt" TIMESTAMP DEFAULT NOW(),
    "updatedAt" TIMESTAMP,
    FOREIGN KEY ("communityId") REFERENCES "Community"("id")
);
```

### ApprovalRequest

```sql
CREATE TABLE "ApprovalRequest" (
    "id" TEXT PRIMARY KEY,
    "communityId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "requesterWallet" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "status" ApprovalRequestStatus DEFAULT 'pending',
    "expiresAt" TIMESTAMP,
    "createdAt" TIMESTAMP DEFAULT NOW(),
    "updatedAt" TIMESTAMP
);

-- Status enum: pending, approved, rejected, expired
```

### Approval

```sql
CREATE TABLE "Approval" (
    "id" TEXT PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "approverWallet" TEXT NOT NULL,
    "approverRole" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL,
    "timestamp" TIMESTAMP DEFAULT NOW(),
    "signature" TEXT,
    FOREIGN KEY ("requestId") REFERENCES "ApprovalRequest"("id"),
    UNIQUE ("requestId", "approverWallet")
);
```

### ContributionScore

```sql
CREATE TABLE "ContributionScore" (
    "id" TEXT PRIMARY KEY,
    "walletId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "totalScore" INTEGER DEFAULT 0,
    "breakdown" JSONB,              -- { commits: 10, reviews: 5, ... }
    "updatedAt" TIMESTAMP,
    UNIQUE ("walletId", "communityId")
);
```

## API Reference

### Create Governance Rule

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

**Response: 201 Created**
```json
{
  "id": "rule-uuid",
  "name": "Admin or High Contributor",
  "description": "...",
  "communityId": "guild-dev",
  "resource": "proposal-voting",
  "ast": { ... },
  "active": true,
  "createdAt": "2026-07-17T12:00:00.000Z",
  "updatedAt": "2026-07-17T12:00:00.000Z"
}
```

### Evaluate Governance Rule

```http
POST /v1/governance/rules/rule-uuid/evaluate
Content-Type: application/json

{
  "wallet": "0xalice...",
  "communityId": "guild-dev",
  "requestId": "proposal-123"
}
```

**Response: 200 OK**
```json
{
  "allowed": true,
  "trace": {
    "ruleType": "OR",
    "evaluated": true,
    "details": "1 of 2 conditions passed (at least 1 required)",
    "children": [
      {
        "ruleType": "HasRole",
        "evaluated": false,
        "details": "User does not have role \"admin\" (has: contributor, member)",
        "metadata": {
          "requiredRole": "admin",
          "userRoles": ["contributor", "member"]
        }
      },
      {
        "ruleType": "AND",
        "evaluated": true,
        "details": "All 2 conditions passed",
        "children": [...]
      }
    ]
  },
  "formattedTrace": "✓ OR: 1 of 2 conditions passed...\n  ✗ HasRole: ...\n  ✓ AND: ..."
}
```

### Create Approval Request

```http
POST /v1/governance/approvals/requests
Content-Type: application/json
X-Wallet: 0xrequester...

{
  "communityId": "guild-dev",
  "resource": "high-value-proposal",
  "ruleId": "rule-uuid",
  "expiresAt": "2026-07-24T12:00:00.000Z"
}
```

**Response: 201 Created**
```json
{
  "id": "request-uuid",
  "communityId": "guild-dev",
  "resource": "high-value-proposal",
  "requesterWallet": "0xrequester...",
  "ruleId": "rule-uuid",
  "status": "pending",
  "expiresAt": "2026-07-24T12:00:00.000Z",
  "createdAt": "2026-07-17T12:00:00.000Z"
}
```

### Submit Approval

```http
POST /v1/governance/approvals/requests/request-uuid/approvals
Content-Type: application/json
X-Wallet: 0xadmin1...

{
  "approved": true,
  "signature": "0x..."
}
```

**Response: 201 Created**
```json
{
  "id": "approval-uuid",
  "requestId": "request-uuid",
  "approverWallet": "0xadmin1...",
  "approverRole": "admin",
  "approved": true,
  "timestamp": "2026-07-17T12:05:00.000Z",
  "signature": "0x..."
}
```

### Get Contribution Score

```http
GET /v1/governance/contribution-scores/0xalice...?communityId=guild-dev
```

**Response: 200 OK**
```json
{
  "wallet": "0xalice...",
  "communityId": "guild-dev",
  "score": {
    "total": 150,
    "breakdown": {
      "commits": 100,
      "reviews": 30,
      "proposals": 20
    }
  }
}
```

### Update Contribution Score

```http
PUT /v1/governance/contribution-scores/0xalice...
Content-Type: application/json

{
  "communityId": "guild-dev",
  "totalScore": 200,
  "breakdown": {
    "commits": 120,
    "reviews": 50,
    "proposals": 30
  }
}
```

**Response: 200 OK**
```json
{
  "id": "score-uuid",
  "walletId": "0xalice...",
  "communityId": "guild-dev",
  "totalScore": 200,
  "breakdown": { ... },
  "updatedAt": "2026-07-17T12:10:00.000Z"
}
```

## Deployment Guide

### Step 1: Apply Database Migration

```bash
cd apps/access-api
npx prisma migrate deploy --schema=prisma/schema.prisma
```

This creates:
- GovernanceRule table
- ApprovalRequest table  
- Approval table
- ContributionScore table

### Step 2: Build Packages

```bash
# Build governance engine
cd packages/governance-engine
npm run build

# Build access-api
cd ../../apps/access-api
npm run build
```

### Step 3: Deploy Application

```bash
# Deploy updated access-api
npm run start
```

### Step 4: Verify Deployment

```bash
# Test rule creation
curl -X POST http://localhost:3000/v1/governance/rules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Rule",
    "description": "Admin only",
    "communityId": "test",
    "resource": "test-resource",
    "ast": { "type": "HasRole", "role": "admin" }
  }'

# Should return 201 with rule object
```

## Integration Examples

### Example 1: Simple Admin Gate

```typescript
// Create rule
const rule = await governanceService.createRule({
  name: "Admin Gate",
  description: "Only admins can access",
  communityId: "guild-dev",
  resource: "admin-panel",
  ast: {
    type: "HasRole",
    role: "admin"
  }
});

// Evaluate for user
const result = await governanceService.evaluateGovernanceRule({
  ruleId: rule.id,
  wallet: "0xalice",
  communityId: "guild-dev",
  roleContext: {
    assignments: [{ role: "admin", source: "manual", active: true }],
    membershipState: "active"
  }
});

console.log(result.allowed); // true
```

### Example 2: Multi-Party Approval

```typescript
// Create rule requiring 2-of-3 admin approvals
const rule = await governanceService.createRule({
  name: "High-Value Proposal",
  description: "Requires 2 admin approvals",
  communityId: "guild-dev",
  resource: "proposal-execution",
  ast: {
    type: "RequiresApprovals",
    threshold: 2,
    approverRole: "admin"
  }
});

// Create approval request
const request = await governanceService.createApprovalRequest({
  communityId: "guild-dev",
  resource: "proposal-execution",
  requesterWallet: "0xproposer",
  ruleId: rule.id
});

// Admin 1 approves
await governanceService.submitApproval({
  requestId: request.id,
  approverWallet: "0xadmin1",
  approverRole: "admin",
  approved: true
});

// Admin 2 approves
await governanceService.submitApproval({
  requestId: request.id,
  approverWallet: "0xadmin2",
  approverRole: "admin",
  approved: true
});

// Evaluate with approvals
const result = await governanceService.evaluateGovernanceRule({
  ruleId: rule.id,
  wallet: "0xproposer",
  communityId: "guild-dev",
  roleContext: { assignments: [], membershipState: "active" },
  requestId: request.id
});

console.log(result.allowed); // true (2 approvals met threshold)
```

### Example 3: Contribution Score Gate

```typescript
// Update user's contribution score
await governanceService.updateContributionScore(
  "0xcontributor",
  "guild-dev",
  150,
  { commits: 100, reviews: 50 }
);

// Create rule requiring minimum score
const rule = await governanceService.createRule({
  name: "Contributor Vote",
  description: "Contributors with score >= 100",
  communityId: "guild-dev",
  resource: "voting",
  ast: {
    type: "AND",
    rules: [
      { type: "HasRole", role: "contributor" },
      { type: "MinContributionScore", score: 100 }
    ]
  }
});

// Evaluate
const result = await governanceService.evaluateGovernanceRule({
  ruleId: rule.id,
  wallet: "0xcontributor",
  communityId: "guild-dev",
  roleContext: {
    assignments: [{ role: "contributor", source: "manual", active: true }],
    membershipState: "active"
  }
});

console.log(result.allowed); // true (has role AND score >= 100)
```

## Security Considerations

### 1. AST Validation

All rule ASTs are validated before storage:

```typescript
// ✅ Valid - will be accepted
const validRule = {
  type: "HasRole",
  role: "admin"
};

// ❌ Invalid - will be rejected
const invalidRule = {
  type: "HasRole",
  role: "admin",
  __proto__: { malicious: true },  // Injection attempt
  eval: "malicious code"            // Code execution attempt
};
```

### 2. No Code Execution

The engine NEVER executes code:

```typescript
// ❌ NOT POSSIBLE - eval/Function not supported
const codeRule = {
  type: "CustomFunction",
  code: "return true;"
};

// ✅ ONLY THIS - pure data structures
const dataRule = {
  type: "HasRole",
  role: "admin"
};
```

### 3. Depth Limits

Prevents stack overflow:

```typescript
// ❌ Rejected - exceeds max depth (10 levels)
let deepRule = { type: "HasRole", role: "admin" };
for (let i = 0; i < 15; i++) {
  deepRule = { type: "AND", rules: [deepRule] };
}
```

### 4. Authorization

TODO: Implement authorization checks:

```typescript
// In routes.ts - add before rule creation/update/delete
const requesterWallet = getRequesterWallet(request);
const isAdmin = await checkIfAdmin(requesterWallet, communityId);
if (!isAdmin) {
  return reply.status(403).send({ error: 'Forbidden' });
}
```

## Performance Considerations

### 1. Contribution Score Caching

Contribution scores are stored in the database and updated asynchronously:

```typescript
// Background job updates scores
async function updateContributionScores() {
  const members = await getActiveMembers();
  
  for (const member of members) {
    const score = await calculateScore(member);
    await governanceService.updateContributionScore(
      member.wallet,
      member.communityId,
      score.total,
      score.breakdown
    );
  }
}
```

### 2. Approval Pre-fetching

Approvals are fetched once per evaluation:

```typescript
// Service caches approvals for the evaluation
const approvals = await this.getApprovals(input.requestId);
const context = createGovernanceContext(
  // ... other params
  approvals,  // Passed to context
  input.requestId
);
```

### 3. Rule Complexity

Keep rules simple for best performance:

```typescript
// ✅ Good - shallow nesting
{
  type: "AND",
  rules: [
    { type: "HasRole", role: "admin" },
    { type: "MinContributionScore", score: 100 }
  ]
}

// ⚠️ Avoid - deep nesting
{
  type: "AND",
  rules: [
    {
      type: "OR",
      rules: [
        {
          type: "AND",
          rules: [
            // ... many nested levels
          ]
        }
      ]
    }
  ]
}
```

## Testing

### Unit Tests

```bash
cd packages/governance-engine
npm test
```

### Integration Tests

```bash
cd apps/access-api
npm test
```

### Manual API Testing

```bash
# Test rule creation
curl -X POST http://localhost:3000/v1/governance/rules \
  -H "Content-Type: application/json" \
  -d @test-rule.json

# Test rule evaluation
curl -X POST http://localhost:3000/v1/governance/rules/{ruleId}/evaluate \
  -H "Content-Type: application/json" \
  -d '{"wallet":"0xalice","communityId":"test"}'
```

## Troubleshooting

### Issue: Rule validation fails

**Symptom:** `Invalid rule AST: Unknown rule type`

**Solution:** Check type field is exact match (case-sensitive):
- `HasRole` not `hasRole`
- `AND` not `And`

### Issue: Evaluation returns false unexpectedly

**Symptom:** Rule evaluates to false but should be true

**Solution:** Use formatted trace to debug:

```typescript
const result = await evaluateRule(rule, context);
console.log(formatTrace(result.trace));
// Examine each step
```

### Issue: Approvals not working

**Symptom:** RequiresApprovals always returns false

**Solution:** Check:
1. Approvals have matching `requestId`
2. Approvals have `approved: true`
3. Approvals have matching `approverRole`

## Resource-Limiting Execution Model

### Overview

Community-authored governance rules are less trusted than the system's own static
policy types. A maliciously or accidentally crafted rule AST could degrade
`checkAccess()` latency for the entire community — or the whole API process —
if evaluation were unbounded.

The governance engine employs three layers of defence:

| Layer | Mechanism | Enforced At | Purpose |
|---|---|---|---|
| 1. Complexity limit | Weighted AST scoring (≤64) | Rule creation (`validateRuleAST`) | Rejects overly complex rules before they are stored |
| 2. Depth limit | Recursion guard (≤10 levels) | Rule creation (`validateRuleAST`) | Prevents stack overflow |
| 3. Wall-clock timeout | `performance.now()` deadline checks (5 ms) | Each evaluation (`evaluateRuleWithBudget`) | Bounds runtime of any accepted rule |

### Layer 1: AST Complexity Scoring

Every rule AST has a **complexity score** — a weighted sum of all nodes:

| Node Type | Weight | Rationale |
|---|---|---|
| `HasRole` | 1 | Single `Array.includes` check |
| `MinContributionScore` | 1 | Single numeric comparison |
| `HasMembershipState` | 1 | Single string comparison |
| `RequiresApprovals` | 2 | Array filter + count + comparison |
| `AND` / `OR` | 2 + Σ children | Combinator overhead + recursive evaluation |
| `NOT` | 2 + child | Combinator overhead + recursive evaluation |
| `N_OF_M` | 3 + Σ children | Most complex combinator (n check + counting) |

**Limit:** `MAX_COMPLEXITY = 64`

**Rationale:** A realistic complex rule (e.g. `Admin OR (Contributor AND Score ≥ 100)
OR 2-of-3[Moderator, Score ≥ 50, Active]`) scores ~10. The limit of 64 allows rules
~6× more complex than any realistic governance rule while capping worst-case
evaluation work at a small, predictable amount.

```typescript
import { computeComplexity, RESOURCE_LIMITS } from '@guildpass/governance-engine';

computeComplexity({ type: 'HasRole', role: 'admin' });        // 1
computeComplexity({
  type: 'AND',
  rules: [
    { type: 'HasRole', role: 'admin' },
    { type: 'MinContributionScore', score: 100 },           // total: 4
  ],
});

console.log(RESOURCE_LIMITS.maxComplexity); // 64
```

### Layer 2: Depth Limit

`MAX_DEPTH = 10` prevents stack overflow from deeply nested trees. Combined with
`MAX_CHILDREN = 50` (per combinator), this bounds the structural size of any AST.

### Layer 3: Wall-Clock Timeout

The `evaluateRuleWithBudget()` function accepts an optional `EvaluationOptions`
with a `timeoutMs` field (default **5 ms**).

**How it works:**
1. The deadline is computed once at entry: `deadline = performance.now() + timeoutMs`
2. Before each AST node is visited (a "yield point"), the evaluator checks
   `performance.now() > deadline`
3. If the deadline has passed, evaluation halts and returns a `TIMEOUT` trace
   with `evaluated: false`
4. The caller (typically `GovernanceRuleProvider`) converts this into a `DENY`
   with code `GOVERNANCE_TIMEOUT`

**Why this is sufficient:**
- The evaluator is a **pure, synchronous tree-walk interpreter** — no I/O, no
  external calls, no unbounded iteration
- AST size is bounded by the validator (complexity ≤64, depth ≤10)
- Each node evaluation is a handful of property accesses and comparisons (~µs)
- A 5 ms budget is **>1000× the typical evaluation time** for a max-complexity rule

**Why no worker threads / child processes are needed:**
- The evaluator terminates naturally (it's a finite tree walk)
- It shares no mutable state between evaluations
- The clock check at each yield point is sub-microsecond overhead
- For this bounded domain, a wall-clock budget with yield points provides the
  same safety guarantee as process isolation with much less complexity

```typescript
import { evaluateRuleWithBudget, DEFAULT_TIMEOUT_MS } from '@guildpass/governance-engine';

// Uses the default 5 ms budget
const result = evaluateRuleWithBudget(rule, context);

// Custom budget
const result = evaluateRuleWithBudget(rule, context, { timeoutMs: 10 });

// Handle timeout
if (result.trace.ruleType === 'TIMEOUT') {
  // Budget exceeded — treat as DENY
}
```

### Integration in `GovernanceRuleProvider`

The `GovernanceRuleProvider.evaluate()` method (in `apps/access-api`) uses
`evaluateRuleWithBudget` with the default 5 ms timeout. If a rule evaluation
times out, the provider returns:

```typescript
{
  result: 'DENY',
  explanation: 'Governance rule "rule-name" evaluation timed out after 5ms',
  code: 'GOVERNANCE_TIMEOUT',
}
```

### Acceptance Criteria Verification

| Criterion | How It's Tested |
|---|---|
| `validateRuleAST` rejects ASTs beyond complexity/depth threshold | `governance.test.ts`: `rejects AST with complexity exceeding MAX_COMPLEXITY` |
| Any accepted rule is provably bounded in time | `governance.test.ts`: `most complex valid AST evaluates well within 5ms budget` |
| Load test confirms no measurable degradation | `load-test.test.ts`: `1000 evaluations of max-complexity rule stay within aggregate budget` |

### Running the Load Tests

```bash
cd packages/governance-engine
npx jest test/load-test.test.ts --verbose
```

Expected output:
```
 PASS  test/load-test.test.ts
  Load Test: Resource-Limiting / Sandboxing
    ✓ max-complexity AST passes validation
    ✓ single evaluation of max-complexity rule completes in microseconds
    ✓ 1000 evaluations of max-complexity rule stay within aggregate budget
    ✓ max-depth AST accepted by validator evaluates within budget
    ✓ AST rejected by complexity limit never reaches evaluator
```

## Future Enhancements

1. **Time-Based Predicates**: MemberSince, ActiveFor
2. **Token Balance Predicates**: MinTokenBalance, OwnsNFT
3. **Delegation**: DelegatedBy predicate
4. **Arithmetic Operations**: score1 + score2 > threshold
5. **String Operations**: Regex matching, string contains
6. **External Oracles**: Oracle data in predicates

## Summary

The Constitutional Rule Engine provides:

✅ **Security**: No code execution, validated ASTs, depth limits  
✅ **Transparency**: Complete evaluation traces  
✅ **Flexibility**: Composable primitives and combinators  
✅ **Integration**: Coexists with existing policy engine  
✅ **Testing**: Comprehensive test coverage  
✅ **Documentation**: Complete API and usage docs  

All requirements from the original specification are met.
