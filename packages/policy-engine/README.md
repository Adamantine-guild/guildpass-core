# Policy Engine `@guildpass/policy-engine`

Explainable access-control engine. Given an [`AccessPolicy`](../../packages/shared-types/src/index.ts) and a
[`RoleContext`](../../packages/shared-types/src/index.ts), it returns a deterministic `ALLOW` / `DENY` decision plus
human- and machine-readable reasons.

This document is the authoritative spec for the four shipped policy rules, the exact role-resolution algorithm, and the
precedence between membership-derived and backend-assigned roles. If you extend the engine (e.g. the manual-override
work), treat this as the contract you must not silently break.

---

## 1. Policy types

Each rule inspects the **effective roles** set produced by `resolveEffectiveRoles` (section 3), except `MEMBERS_ONLY`,
which also inspects raw membership state. The `RoleContext` is never mutated.

| `ruleType` | Grants access when | Denies with reason code |
| ---------- | ------------------ | ----------------------- |
| `PUBLIC` | Always. | Never denies (returns `ALLOW` for everyone, including `expired`/`suspended`/`invited` and zero roles). |
| `MEMBERS_ONLY` | `membershipState === "active"`. | `NEEDS_ACTIVE` for any non-active state. |
| `ADMINS_ONLY` | The effective roles set contains `admin`. | `NEEDS_ADMIN`. A `contributor` or `member` (even with active membership) is not enough. |
| `CONTRIBUTORS_OR_ADMINS` | The effective roles set contains `admin` **or** `contributor`. | `NEEDS_CONTRIBUTOR_OR_ADMIN`. `member` alone (even with active membership) is not enough. |

`MEMBERS_ONLY` is the only rule that keys off `membershipState` directly. The other three key off the resolved role set,
so a backend role assignment can satisfy them even when membership is not `active` (see the precedence section).

### Malformed / unknown rules

- `validatePolicy` runs before rule evaluation. If `policy.params` is present but not a plain JSON object, the decision is
  `DENY` with reason `MALFORMED_POLICY`. (Structured `params` objects are preserved and ignored by the shipped rules.)
- An unrecognized `ruleType` falls through to the `default` branch and returns `DENY` with reason `RULE_UNHANDLED`.
  This is intentional fail-closed behavior: unknown rules never grant access.

---

## 2. Inputs and outputs

```typescript
import { evaluate, explain, resolveEffectiveRoles } from "@guildpass/policy-engine";
import type { AccessPolicy, RoleContext } from "@guildpass/shared-types";

const ctx: RoleContext = {
  assignments: [{ role: "admin", source: "manual", active: true }],
  membershipState: "active",
};

const policy: AccessPolicy = {
  id: "p1",
  communityId: "c1",
  resource: "res",
  ruleType: "ADMINS_ONLY",
};

const decision = evaluate(policy, ctx);
// {
//   allowed: true,
//   code: "ALLOW",
//   reasons: [
//     { code: "MEMBERSHIP_ACTIVE", message: "Membership is active" },
//     { code: "HAS_ADMIN",        message: "Admin role grants access" },
//   ],
//   effectiveRoles: ["admin", "contributor", "member"],
//   membershipState: "active",
// }

console.log(explain(policy, ctx));
// ALLOWED for ruleType=ADMINS_ONLY
// roles=[admin, contributor, member]
// - MEMBERSHIP_ACTIVE: Membership is active
// - HAS_ADMIN: Admin role grants access
```

`AccessDecision` shape (`@guildpass/shared-types`):

| Field | Type | Notes |
| ----- | ---- | ----- |
| `allowed` | `boolean` | Final verdict. |
| `code` | `"ALLOW" \| "DENY"` | Always present. |
| `reasons` | `DecisionReason[]` | First entry is always `MEMBERSHIP_<STATE>` context. Rule-specific codes follow. |
| `effectiveRoles` | `Role[]` | The full resolved set, for transparency and debugging. |
| `membershipState` | `MembershipState` | Echo of the input context. |

---

## 3. Role-resolution algorithm (`resolveEffectiveRoles`)

This is the single source of truth for "who is this user, role-wise." Every policy rule consumes its output. The
function is pure and evaluated against wall-clock `now` (so `expiresAt` is relative to the evaluation time).

```
roles = []
for each assignment a in ctx.assignments:
    if a.active is false:                 # skip revoked assignments
        continue
    if a.expiresAt is set and a.expiresAt < now:
        continue                          # skip expired assignments
    roles.push(a.role)

if ctx.membershipState === "active":      # membership-derived role, NOT a hierarchy expansion
    roles.push("member")

# Hierarchy expansion (additive, derived from the roles above)
effective = [...roles]
if "admin" in roles:
    effective.push("contributor", "member")
if "contributor" in roles:
    effective.push("member")

return unique(effective)                  # dedupe, stable order not guaranteed
```

Implementation reference: [`src/index.ts:43`](./src/index.ts).

---

## 4. Precedence: membership-derived vs backend-assigned roles

**The two sources are merged additively into one role set. There is no override today.** Membership state does not
invalidate backend assignments, and backend assignments do not change membership state. They are combined before any
rule is evaluated.

Concretely:

1. **Backend `assignments`** contribute their `role` when `active` and unexpired. This includes a backend-assigned
   `member` role (`source: "auto"`), which behaves identically to the membership-derived `member` role.
2. **Active membership** contributes a `member` role as a baseline, independent of any backend assignment.
3. **Both are then expanded through the same hierarchy** (`admin -> contributor -> member`). Because expansion happens
   *after* merging, a backend `admin` assignment grants `contributor` and `member` even when the user's membership is
   `expired` or `suspended`. Active membership is not a prerequisite for backend-derived hierarchy benefits.
4. **`MEMBERS_ONLY` is the exception to "rules only see roles":** it additionally requires `membershipState ===
   "active"`. So a backend `admin` on an `expired` membership passes `ADMINS_ONLY` and `CONTRIBUTORS_OR_ADMINS` (via the
   role set) but **fails `MEMBERS_ONLY`** (via the raw state check). This asymmetry is deliberate and is the most common
   source of surprise when extending the engine.

### Why "no override" matters for the manual-override TODO

The README notes "room for future manual override rules." Until that is built, **membership-derived and backend-assigned
roles have equal weight and cannot cancel each other.** Any future override mechanism must be implemented inside
`resolveEffectiveRoles` (or as a documented post-processing step) so that every policy rule sees one consistent
effective-roles set. Do not special-case override logic into individual `case` branches, or rules will diverge.

---

## 5. Worked examples

All examples use `evaluate(policy, ctx)`. "Roles" = the effective set from `resolveEffectiveRoles`.

| # | `membershipState` | `assignments` | Resolved roles | `PUBLIC` | `MEMBERS_ONLY` | `ADMINS_ONLY` | `CONTRIBUTORS_OR_ADMINS` |
| - | ----------------- | ------------- | -------------- | -------- | -------------- | ------------- | ------------------------ |
| 1 | `active` | `[]` | `[member]` | ALLOW | ALLOW | DENY | DENY |
| 2 | `expired` | `[admin, active]` | `[admin, contributor, member]` | ALLOW | **DENY** | ALLOW | ALLOW |
| 3 | `suspended` | `[admin, active]` | `[admin, contributor, member]` | ALLOW | **DENY** | ALLOW | ALLOW |
| 4 | `expired` | `[member, active]` | `[member]` | ALLOW | DENY | DENY | DENY |
| 5 | `invited` | `[]` | `[]` | ALLOW | DENY | DENY | DENY |
| 6 | `active` | `[contributor, active]` | `[contributor, member]` | ALLOW | ALLOW | DENY | ALLOW |
| 7 | `active` | `[admin, inactive]` | `[member]` | ALLOW | ALLOW | DENY | DENY |
| 8 | `active` | `[admin, active, expiresAt=past]` | `[member]` | ALLOW | ALLOW | DENY | DENY |
| 9 | `active` | `[admin, active, expiresAt=future], [contributor, active, expiresAt=past]` | `[admin, contributor, member]` | ALLOW | ALLOW | ALLOW | ALLOW |
| 10 | `active` | `[member(auto), active], [contributor(manual), active]` | `[member, contributor]` | ALLOW | ALLOW | DENY | ALLOW |

### Notable cases called out

- **#2 / #3 — expired or suspended membership + backend `admin`:** The user is not an active member, so `MEMBERS_ONLY`
  denies (`NEEDS_ACTIVE`). But the backend `admin` assignment survives the merge and hierarchy expansion, so
  `ADMINS_ONLY` and `CONTRIBUTORS_OR_ADMINS` allow. This is the precedence rule in action: backend role + hierarchy beat
  expired/suspended membership for role-based rules, but not for the membership-state gate.
- **#4 — expired membership + backend `member` only:** Resolves to just `[member]`. Fails every rule except `PUBLIC`
  and `MEMBERS_ONLY` (the latter because `membershipState` is `expired`, not `active`).
- **#7 — inactive `admin` assignment:** Skipped entirely (not active), so the user is just an active member. `ADMINS_ONLY`
  denies.
- **#8 — expired `admin` assignment:** `expiresAt` is in the past, so it is dropped before the merge; result is identical
  to a plain active member.
- **#9 — mixed expiry:** Only the unexpired `admin` contributes; the expired `contributor` is dropped. Hierarchy from
  `admin` still adds `contributor`/`member`.
- **#10 — duplicate `member` via two sources:** Active membership and a backend `member` assignment both add `member`;
  `unique()` collapses them. `CONTRIBUTORS_OR_ADMINS` passes via the backend `contributor`.

---

## 6. Contract types

Defined in [`@guildpass/shared-types`](../../packages/shared-types/src/index.ts):

```typescript
type MembershipState = "invited" | "active" | "expired" | "suspended";
type Role = "admin" | "member" | "contributor";

interface RoleAssignment {
  role: Role;
  source: "manual" | "auto";
  active: boolean;
  expiresAt?: string | Date | null;
}

interface RoleContext {
  assignments: RoleAssignment[];
  membershipState: MembershipState;
}

interface AccessPolicy {
  id: string;
  communityId: string;
  resource: string;
  ruleType: "PUBLIC" | "MEMBERS_ONLY" | "ADMINS_ONLY" | "CONTRIBUTORS_OR_ADMINS" | string;
  params?: Record<string, unknown> | null;
}
```

---

## 7. Extending the engine

When adding a new rule type (including the manual-override rules):

1. **Types:** add the `ruleType` to `PolicyRuleType` in `@guildpass/shared-types`.
2. **Validation:** add a `case` in `validatePolicy` (`src/index.ts`) so malformed params are caught before evaluation.
3. **Resolution:** if the rule needs a new role or override semantics, modify `resolveEffectiveRoles` — never replicate
   role logic in a `case` branch. Keep the single source of truth.
4. **Evaluation:** add a `case` in the `evaluate` switch returning `ALLOW`/`DENY` with a stable reason `code`.
5. **Tests:** add gate tests in `test/policy.test.ts` covering allow, deny, and reason codes. New rule types must fail
   closed if any input is missing.

Run the suite locally:

```bash
npm run -w @guildpass/policy-engine test
npm run -w @guildpass/policy-engine typecheck
```

---

## 8. Versioning

The package is pre-1.0 (`0.1.0`). The decision `code`s and `reason`s are part of the observable contract for API
consumers (see root README "OpenAPI Specification"); changing or removing a reason `code` is a breaking change and must
be reflected in the API versioning policy.
