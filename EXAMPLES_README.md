# GuildPass Examples and Usage Guide

This document provides practical examples and usage guides for both the Audit Chain of Custody and Constitutional Rule Engine features.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Governance Engine Examples](#governance-engine-examples)
3. [Audit Trail Examples](#audit-trail-examples)
4. [Integration Examples](#integration-examples)
5. [API Testing](#api-testing)

---

## Quick Start

### Prerequisites

```bash
# 1. Install dependencies
npm install

# 2. Apply database migrations
cd apps/access-api
npx prisma migrate deploy

# 3. Start the API server
npm run dev
```

### Running Examples

```bash
# TypeScript examples (governance engine)
cd packages/governance-engine
npm test  # Run all test examples
ts-node examples/end-to-end-example.ts  # Run interactive scenarios

# API examples (requires running server)
cd apps/access-api
chmod +x examples/*.sh
./examples/governance-api-examples.sh
./examples/audit-trace-examples.sh
```

---

## Governance Engine Examples

### Example 1: Simple Admin Check

**Use Case:** Restrict access to admins only

```typescript
import { evaluateRule, createGovernanceContext } from '@guildpass/governance-engine';

const rule = {
  type: "HasRole",
  role: "admin"
};

const context = createGovernanceContext(
  "0xalice",
  "guild-dev",
  {
    assignments: [{ role: "admin", source: "manual", active: true }],
    membershipState: "active"
  },
  { total: 0 }
);

const result = evaluateRule(rule, context);
console.log(result.allowed); // true
```

**API Equivalent:**

```bash
# Create rule
curl -X POST http://localhost:3000/v1/governance/rules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Admin Only",
    "description": "Only admins can access",
    "communityId": "guild-dev",
    "resource": "admin-panel",
    "ast": { "type": "HasRole", "role": "admin" }
  }'

# Evaluate rule
curl -X POST http://localhost:3000/v1/governance/rules/{ruleId}/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xalice",
    "communityId": "guild-dev"
  }'
```

### Example 2: Contribution Score Gate

**Use Case:** Contributors with high scores get special access

```typescript
const rule = {
  type: "AND",
  rules: [
    { type: "HasRole", role: "contributor" },
    { type: "MinContributionScore", score: 100 }
  ]
};

const context = createGovernanceContext(
  "0xbob",
  "guild-dev",
  {
    assignments: [{ role: "contributor", source: "manual", active: true }],
    membershipState: "active"
  },
  { total: 150, breakdown: { commits: 100, reviews: 50 } }
);

const result = evaluateRule(rule, context);
console.log(result.allowed); // true
console.log(formatTrace(result.trace));
// ✓ AND: All 2 conditions passed
//   ✓ HasRole: User has role "contributor"
//   ✓ MinContributionScore: User contribution score 150 meets minimum 100
```

### Example 3: Multi-Party Approval

**Use Case:** High-value proposals require 2-of-3 admin approvals

```typescript
const rule = {
  type: "RequiresApprovals",
  threshold: 2,
  approverRole: "admin"
};

const approvals = [
  {
    id: "1",
    requestId: "proposal-001",
    approverWallet: "0xadmin1",
    approverRole: "admin",
    approved: true,
    timestamp: new Date().toISOString()
  },
  {
    id: "2",
    requestId: "proposal-001",
    approverWallet: "0xadmin2",
    approverRole: "admin",
    approved: true,
    timestamp: new Date().toISOString()
  }
];

const context = createGovernanceContext(
  "0xproposer",
  "guild-dev",
  { assignments: [], membershipState: "active" },
  { total: 0 },
  approvals,
  "proposal-001"
);

const result = evaluateRule(rule, context);
console.log(result.allowed); // true - has 2 approvals
```

**API Workflow:**

```bash
# 1. Create approval rule
curl -X POST http://localhost:3000/v1/governance/rules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "2-of-3 Admin Approvals",
    "communityId": "guild-dev",
    "resource": "high-value-proposal",
    "ast": {
      "type": "RequiresApprovals",
      "threshold": 2,
      "approverRole": "admin"
    }
  }'

# 2. Create approval request
curl -X POST http://localhost:3000/v1/governance/approvals/requests \
  -H "Content-Type: application/json" \
  -H "X-Wallet: 0xproposer" \
  -d '{
    "communityId": "guild-dev",
    "resource": "high-value-proposal",
    "ruleId": "{ruleId}"
  }'

# 3. Admin 1 approves
curl -X POST http://localhost:3000/v1/governance/approvals/requests/{requestId}/approvals \
  -H "Content-Type: application/json" \
  -H "X-Wallet: 0xadmin1" \
  -d '{ "approved": true }'

# 4. Admin 2 approves
curl -X POST http://localhost:3000/v1/governance/approvals/requests/{requestId}/approvals \
  -H "Content-Type: application/json" \
  -H "X-Wallet: 0xadmin2" \
  -d '{ "approved": true }'

# 5. Evaluate with approvals
curl -X POST http://localhost:3000/v1/governance/rules/{ruleId}/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xproposer",
    "communityId": "guild-dev",
    "requestId": "{requestId}"
  }'
```

### Example 4: Flexible N-of-M Access

**Use Case:** Need 2 of 3: admin role, high score, or active membership

```typescript
const rule = {
  type: "N_OF_M",
  n: 2,
  rules: [
    { type: "HasRole", role: "admin" },
    { type: "MinContributionScore", score: 100 },
    { type: "HasMembershipState", state: "active" }
  ]
};

// Test case: High score + active (passes 2/3)
const context = createGovernanceContext(
  "0xcontributor",
  "guild-dev",
  {
    assignments: [{ role: "contributor", source: "manual", active: true }],
    membershipState: "active"
  },
  { total: 150 }
);

const result = evaluateRule(rule, context);
console.log(result.allowed); // true
console.log(result.trace.metadata?.passed); // 2
```

---

## Audit Trail Examples

### Example 1: Query by Correlation ID

**Use Case:** Get complete trace for a specific access decision

```bash
# Query audit trail
curl -X GET http://localhost:3000/admin/audit/trace/{correlationId}
```

**Response Structure:**

```json
{
  "correlationId": "access_guild-dev_0xalice_dashboard_1721189760000",
  "originatingOnChainEvent": {
    "chainId": 1,
    "txHash": "0xabc...def",
    "blockNumber": 12345678,
    "logIndex": 5
  },
  "databaseMutations": [
    {
      "eventType": "MEMBERSHIP_CREATED",
      "beforeState": null,
      "afterState": { "tokenId": 123, "state": "active" }
    }
  ],
  "outboxEvents": [
    {
      "eventType": "MEMBERSHIP_CREATED",
      "status": "delivered"
    }
  ],
  "accessDecisions": [
    {
      "decision": "ALLOW",
      "resource": "dashboard",
      "membershipState": { "state": "active", "tokenId": 123 }
    }
  ],
  "summary": {
    "totalEvents": 3,
    "hasOnChainOrigin": true
  }
}
```

### Example 2: Query by Transaction Hash

**Use Case:** Find all audit events from a blockchain transaction

```bash
# Query by transaction hash
curl -X GET http://localhost:3000/admin/audit/trace/tx/0xabc...def
```

**Response:**

```json
{
  "txHash": "0xabc...def",
  "traces": [
    {
      "correlationId": "0xabc...def_5_1721189760000",
      "originatingOnChainEvent": { "blockNumber": 12345678 },
      "summary": { "totalEvents": 3, "hasOnChainOrigin": true }
    }
  ],
  "count": 1
}
```

### Example 3: Query by Wallet

**Use Case:** View all audit events for a specific user

```bash
# Query by wallet
curl -X GET "http://localhost:3000/admin/audit/trace/wallet/0xalice?communityId=guild-dev&limit=10"
```

---

## Integration Examples

### Example: Governance Decision with Audit Trail

**Complete workflow showing both features working together**

```typescript
// 1. Create governance rule
const rule = await governanceService.createRule({
  name: "Admin or High Contributor",
  communityId: "guild-dev",
  resource: "proposal-voting",
  ast: {
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
  }
});

// 2. Update contribution score
await governanceService.updateContributionScore(
  "0xcontributor",
  "guild-dev",
  150,
  { commits: 100, reviews: 50 }
);

// 3. Evaluate governance rule (creates audit event)
const result = await governanceService.evaluateGovernanceRule({
  ruleId: rule.id,
  wallet: "0xcontributor",
  communityId: "guild-dev",
  roleContext: {
    assignments: [{ role: "contributor", source: "manual", active: true }],
    membershipState: "active"
  }
});

console.log(result.allowed); // true
console.log(formatTrace(result.trace));
// ✓ OR: 1 of 2 conditions passed
//   ✗ HasRole: User does not have role "admin"
//   ✓ AND: All 2 conditions passed
//     ✓ HasRole: User has role "contributor"
//     ✓ MinContributionScore: User contribution score 150 meets minimum 100

// 4. Query audit trail for this decision
// The evaluation created an audit event with a correlation ID
const auditEvent = await prisma.auditEvent.findFirst({
  where: {
    eventType: 'ACCESS_CHECK',
    walletId: '0xcontributor',
    resource: 'proposal-voting'
  },
  orderBy: { createdAt: 'desc' }
});

// 5. Get complete audit trace
const trace = await getAuditTraceByCorrelationId(auditEvent.correlationId);

console.log(trace.accessDecisions[0]);
// Shows the governance rule evaluation with state snapshots:
// - membershipState: active
// - roleState: [contributor]
// - contributionScore: 150
```

---

## API Testing

### Running the Example Scripts

```bash
# Make scripts executable
chmod +x apps/access-api/examples/*.sh

# Run governance examples
./apps/access-api/examples/governance-api-examples.sh

# Run audit trace examples
./apps/access-api/examples/audit-trace-examples.sh
```

### Manual Testing with curl

#### Test Governance Rule Creation

```bash
curl -X POST http://localhost:3000/v1/governance/rules \
  -H "Content-Type: application/json" \
  -d @- << 'EOF'
{
  "name": "Test Rule",
  "description": "Admin OR Contributor with score >= 100",
  "communityId": "test-guild",
  "resource": "test-resource",
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
EOF
```

#### Test Rule Evaluation

```bash
curl -X POST http://localhost:3000/v1/governance/rules/{ruleId}/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xtest",
    "communityId": "test-guild"
  }'
```

#### Test Audit Trail Query

```bash
# By correlation ID
curl -X GET http://localhost:3000/admin/audit/trace/{correlationId}

# By transaction hash
curl -X GET http://localhost:3000/admin/audit/trace/tx/{txHash}

# By wallet
curl -X GET "http://localhost:3000/admin/audit/trace/wallet/{wallet}?communityId={communityId}"
```

---

## Common Patterns

### Pattern 1: Tiered Access

```typescript
// Bronze, Silver, Gold tier based on contribution score
const tieredAccess = {
  type: "OR",
  rules: [
    { type: "MinContributionScore", score: 200 }, // Gold
    { type: "MinContributionScore", score: 100 }, // Silver
    { type: "MinContributionScore", score: 50 }   // Bronze
  ]
};
```

### Pattern 2: Time-Limited Approval

```typescript
// Create approval request with expiration
const request = await governanceService.createApprovalRequest({
  communityId: "guild-dev",
  resource: "proposal",
  requesterWallet: "0xproposer",
  ruleId: ruleId,
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
});
```

### Pattern 3: Emergency Override

```typescript
// Normal access OR emergency admin override
const emergencyRule = {
  type: "OR",
  rules: [
    // Normal path
    {
      type: "AND",
      rules: [
        { type: "HasRole", role: "contributor" },
        { type: "HasMembershipState", state: "active" }
      ]
    },
    // Emergency path
    {
      type: "RequiresApprovals",
      threshold: 3,
      approverRole: "admin"
    }
  ]
};
```

---

## Troubleshooting

### Issue: Rule validation fails

**Solution:** Check AST structure matches exactly

```typescript
// ❌ Wrong - lowercase type
{ type: "hasRole", role: "admin" }

// ✅ Correct - exact case
{ type: "HasRole", role: "admin" }
```

### Issue: Evaluation returns false unexpectedly

**Solution:** Use formatted trace to debug

```typescript
const result = evaluateRule(rule, context);
console.log(formatTrace(result.trace));
// Examine each step to find where it fails
```

### Issue: Audit trace not found

**Solution:** Check correlation ID exists

```sql
-- Query database for correlation ID
SELECT * FROM "AuditEvent" WHERE "correlationId" = 'your-id';
```

---

## Next Steps

1. **Explore TypeScript Examples**: See `packages/governance-engine/examples/`
2. **Run API Examples**: Execute shell scripts in `apps/access-api/examples/`
3. **Read Documentation**: 
   - `packages/governance-engine/README.md`
   - `apps/access-api/AUDIT_CHAIN_OF_CUSTODY.md`
4. **Run Tests**: `npm test` in both packages
5. **Build Your Own Rules**: Use examples as templates

## Support

For questions or issues:
- Check example files for working code
- Review test files for comprehensive scenarios
- Consult documentation files
- Run shell scripts for API examples
