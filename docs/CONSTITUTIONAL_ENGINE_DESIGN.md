# Constitutional Rule Engine & Moderation Design Document

## 1. Overview

The **Constitutional Rule Engine** (`packages/constitutional-engine`) provides higher-level, versioned governance constraints that regulate administrative actions (role assignments, role revocations, policy modifications, access overrides, and moderation actions). 

While the policy engine (`packages/policy-engine`) evaluates runtime access checks (e.g., "Is wallet X allowed to call endpoint Y?"), the constitutional rule engine evaluates whether a proposed *mutation* to administrative state is compliant with a community's active constitution (e.g., "Does assigning the Admin role require 2 co-signatures?").

---

## 2. Declarative Rule Format (v1 Specification)

Constitutional rules are stored as JSON structures per community inside versioned `ConstitutionalRuleSet` records.

### Rule Schema

```typescript
export interface ConstitutionalRule {
  id: string;
  name: string;
  description?: string;
  targetAction: 'ROLE_ASSIGNMENT' | 'ROLE_REVOCATION' | 'POLICY_UPDATE' | 'OVERRIDE_CREATE' | 'OVERRIDE_REVOKE' | '*';
  precedence: number; // Higher numbers evaluate first
  effect: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
  type: 'COOLDOWN' | 'MULTI_ADMIN_APPROVAL' | 'CUSTOM';
  params: CooldownParams | MultiAdminApprovalParams | Record<string, any>;
  active?: boolean;
}
```

### Rule Types

#### 1. `COOLDOWN` Rule
Restricts the rate of mutations targeting a specific wallet, resource, or community.
- **Parameters**:
  - `minIntervalSeconds`: Minimum required elapsed time between successive mutations.
  - `scope`: `'TARGET_WALLET' | 'TARGET_RESOURCE' | 'COMMUNITY'`.

#### 2. `MULTI_ADMIN_APPROVAL` Rule
Requires co-signatures/approvals from multi-admin role holders before executing high-privilege mutations.
- **Parameters**:
  - `requiredApprovals`: Integer threshold (e.g., `2` for 2-admin approval).
  - `approverRole`: Role required for approvals (default: `'admin'`).
  - `approvalMaxAgeSeconds`: Optional expiration for collected signatures.

#### 3. `CUSTOM` Rule
Extensible placeholder for custom community policy logic.

---

## 3. Versioning Strategy & Historical Non-Retroactivity

1. **Version Immutability**: Each rule set update creates a new incremented `version` number (`v1`, `v2`, ...).
2. **Single Active Version**: Creating a new version deactivates prior versions (`active: false`).
3. **Non-Retroactivity**: Evaluations and decisions record the `version` number active at decision time in `AuditEvent` records. Past decisions remain valid under the version that was active when evaluated.

---

## 4. Moderation State Machine

The moderation workflow manages member suspension, appeal, and reinstatement via explicit state transitions.

```
       +---------------------------------------------+
       |                                             |
       v                                             |
  [ ACTIVE ] ---> [ SUSPENDED ]                      |
                      |                              |
                      v                              |
               [ APPEAL FILED ]                      |
                      |                              |
                      v                              |
             [ UNDER REVIEW ]                        |
               /          \                          |
              v            v                         |
       [ UPHELD ]    [ REINSTATED ] -----------------+
```

### Allowed Transitions

1. **Member Appeal Submission**:
   - Condition: Member membership state is `suspended`.
   - Action: `fileAppeal(walletAddress, communityId, reason)`
   - Result: `Appeal` created with status `filed`.

2. **Admin Review Transition**:
   - Allowed: `filed` → `under_review`
   - Requires: Admin authentication.

3. **Resolution Transition**:
   - Allowed: `under_review` → `upheld` OR `reinstated`
   - `upheld`: Appeal rejected, member remains suspended.
   - `reinstated`: Membership token state restored to `active`, outbox event `MEMBERSHIP_REINSTATED` emitted.

---

## 5. Validation Hook Architecture

Administrative mutations invoke `validateAndEvaluateMutation` inside a database transaction:

```typescript
await prisma.$transaction(async (tx) => {
  await validateAndEvaluateMutation(tx, {
    action: 'ROLE_ASSIGNMENT',
    communityId,
    actorWallet,
    targetWallet,
    proposedData: { role },
    approvals,
  });

  // Execute domain mutation...
});
```

If any constitutional constraint fails:
- The transaction rolls back.
- A `ConstitutionalViolationError` (HTTP 403) is thrown with detailed reason codes and rule evaluation traces.

---

## 6. Design Tradeoffs & Future Enhancements

- **Simple Declarative JSON vs Full AST**: v1 uses structured parameters for speed, safety, and readability over an open-ended programming AST.
- **Synchronous Transaction Gates**: Enforcement is transactional and synchronous, preventing race conditions or partial mutations.
- **Future Work**: On-chain cryptographic multi-sig verification for collected approval payloads.
