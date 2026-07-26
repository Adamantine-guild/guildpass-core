# Policy Engine `@guildpass/policy-engine`

Explainable access-control engine. Given an [`AccessPolicy`](../../packages/shared-types/src/index.ts) and a
[`RoleContext`](../../packages/shared-types/src/index.ts), it returns a deterministic `ALLOW` / `DENY` decision plus
human- and machine-readable reasons.

This document is the authoritative spec for the four shipped policy rules, the exact role-resolution algorithm, and the
precedence between manual access overrides, membership-derived roles, and backend-assigned roles. If you extend the
engine, treat this as the contract you must not silently break.

---

## 1. Policy types

Each rule inspects the **effective roles** set produced by `resolveEffectiveRoles` (section 3), except `MEMBERS_ONLY`,
which also inspects raw membership state. The `RoleContext` is never mutated.

Before any rule runs, `evaluate` checks for an active **manual access override** (section 4) on `ctx.overrides` for the
exact `(wallet, communityId, resource)` triple. If one is found and unexpired, it short-circuits the decision — none of
the rule types below are evaluated at all.

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

## 4. Precedence: overrides, membership-derived roles, and backend-assigned roles

Precedence is a strict three-tier hierarchy, evaluated top to bottom. A higher tier fully decides the outcome; lower
tiers are never consulted once a higher tier applies.

1. **Manual access overrides (highest precedence).** An `AccessOverride` is a `(wallet, communityId, resource, effect)`
   record with an optional `expiresAt`, created via the `/v1/communities/:communityId/overrides` admin routes (see the
   root README's "Policy Engine" section). `findActiveOverride` (`src/index.ts`) looks for an override matching the
   exact wallet, community, and resource in `ctx.overrides`, skipping any whose `expiresAt` is in the past. If one
   matches, its `effect` (`ALLOW` or `DENY`) **is** the decision — no rule (`PUBLIC`, `MEMBERS_ONLY`, etc.) is evaluated,
   and no role resolution happens for the purpose of that decision. This is a deliberate escape hatch for cases role-
   and membership-state logic can't express cleanly: a temporary ban on an otherwise-admin wallet, or a one-off grant
   for a partner wallet that isn't a member at all.
2. **Backend-assigned and membership-derived roles (no override present).** When no active override applies, evaluation
   falls through to `resolveEffectiveRoles` and behaves exactly as described below: the two sources are merged
   additively into one role set, and the matched policy rule evaluates that set.
3. **Rule-specific fallback (`RULE_UNHANDLED`) / fail-closed default.** If the policy's `ruleType` isn't registered,
   the decision is `DENY`. Malformed `params` are also fail-closed (`MALFORMED_POLICY`), checked after the override
   lookup but before rule dispatch.

**Within tier 2, membership-derived and backend-assigned roles are merged additively — neither cancels the other.**
Membership state does not invalidate backend assignments, and backend assignments do not change membership state.

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

### Implementation notes for the override tier

- Overrides are looked up by exact `(wallet, communityId, resource)` match — there is no wildcard or hierarchy-aware
  matching (an override on one `resource` string does not apply to another, even within the same community).
- Expiry is evaluated at decision time (`new Date()`), not at write time — an override with a past `expiresAt` is
  treated as if it doesn't exist, and evaluation falls through to tier 2 as normal.
- `ctx.overrides` must be populated by the caller (see `apps/access-api`'s `memberService.checkAccess`, which fetches
  matching `AccessOverride` rows before calling `evaluate`). The engine itself never queries a database.
- Override precedence is implemented once, in `findActiveOverride`/`evaluate` (`src/index.ts`) — not duplicated into
  individual rule `case` branches — so every policy rule sees the same short-circuit behavior. Keep any future
  extension to this tier in that single location.

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

### Override examples

These use the same `evaluate(policy, ctx)` call, but `ctx` now carries `wallet`, `communityId`, `resource`, and
`overrides`. Compare #11 and #12 to #2/#3 above: an override changes the outcome even for a wallet that would otherwise
pass `ADMINS_ONLY` on role grounds alone.

| # | `membershipState` | `assignments` | `overrides` (for this wallet/community/resource) | Result | Why |
| - | ----------------- | ------------- | -------------------------------------------------- | ------ | --- |
| 11 | `active` | `[admin, active]` | `[{ effect: "DENY" }]` (unexpired) | **DENY** (`OVERRIDE_DENY`) | The DENY override short-circuits before `ADMINS_ONLY` is ever evaluated — an active admin can still be blocked from one specific resource. |
| 12 | `invited` | `[]` | `[{ effect: "ALLOW" }]` (unexpired) | **ALLOW** (`OVERRIDE_ALLOW`) | A non-member with zero roles is granted access — the one-off "partner wallet" case. Every rule type (even `ADMINS_ONLY`) would otherwise deny. |
| 13 | `active` | `[member, active]` | `[{ effect: "DENY", expiresAt: <past> }]` | Falls through to normal rule evaluation | The override is expired, so `findActiveOverride` skips it; the decision comes from tier 2 (role resolution) as if no override existed. |
| 14 | `active` | `[]` | `[{ effect: "ALLOW", wallet: <different wallet> }]` | Falls through to normal rule evaluation | The override doesn't match this wallet, so it's not a candidate — exact-match only, no partial or wildcard matching. |

---

## 6. Contract types

Defined in [`@guildpass/shared-types`](../../packages/shared-types/src/index.ts):

```typescript
type MembershipState = "invited" | "active" | "expired" | "suspended";
type Role = "admin" | "member" | "contributor";
type AccessOverrideEffect = "ALLOW" | "DENY";

interface RoleAssignment {
  role: Role;
  source: "manual" | "auto";
  active: boolean;
  expiresAt?: string | Date | null;
}

interface AccessOverride {
  id?: string;
  wallet: string;
  communityId: string;
  resource: string;
  effect: AccessOverrideEffect;
  expiresAt?: string | Date | null;
  reason?: string | null;
  createdAt?: string | Date;
}

interface RoleContext {
  assignments: RoleAssignment[];
  membershipState: MembershipState;
  // Required for override lookup (section 4, tier 1). Omit any of these
  // three and findActiveOverride can't match — it falls through to normal
  // role resolution as if no override existed.
  wallet?: string;
  communityId?: string;
  resource?: string;
  overrides?: AccessOverride[];
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

When adding a new rule type:

1. **Types:** add the `ruleType` to `PolicyRuleType` in `@guildpass/shared-types`.
2. **Validation:** add a `case` in `validatePolicy` (`src/index.ts`) so malformed params are caught before evaluation.
3. **Resolution:** if the rule needs a new role, modify `resolveEffectiveRoles` — never replicate role logic in a
   `case` branch. Keep the single source of truth.
4. **Evaluation:** add a `case` in the `evaluate` switch returning `ALLOW`/`DENY` with a stable reason `code`.
5. **Tests:** add gate tests in `test/policy.test.ts` covering allow, deny, and reason codes. New rule types must fail
   closed if any input is missing.

When extending override semantics specifically (tier 1, section 4) — e.g. wildcard resource matching, or overrides
scoped to a role instead of a wallet — modify `findActiveOverride` in `src/index.ts`, not `resolveEffectiveRoles` or an
individual rule's `case` branch. Overrides intentionally bypass role resolution entirely; keeping that logic in one
place is what lets every rule type see the same short-circuit behavior without re-implementing it.

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
