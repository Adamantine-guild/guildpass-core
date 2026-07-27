# Suspension Appeals and Reinstatement

This document describes the suspension appeals subsystem (issue #249): how
members contest a suspension, how admins review appeals, and how reinstatement
reaches the chain without the API silently signing transactions.

## State machine

```
pending ──► approved   (terminal)
   └─────► denied      (terminal)
```

Rules:

- Only one **pending** appeal is allowed per member/community while a
  suspension is active.
- Terminal states (`approved`, `denied`) reject further transitions.
- Submitting an appeal when the membership is not suspended is rejected.

## Access while an appeal is pending (security default)

**Default: access remains denied.**

While `status === pending`, the membership stays `suspended` and the policy
engine continues to deny `MEMBERS_ONLY` (and related) checks. There is **no**
provisional reinstatement during review unless a future community setting
explicitly enables it.

Constants in code:

- `ACCESS_DENIED_WHILE_APPEAL_PENDING = true`
- `PROVISIONAL_REINSTATEMENT_PENDING_REVIEW = false`

Approval alone does **not** flip the off-chain membership to `active`. Access
is restored only after the indexer ingests an on-chain
`MembershipSuspended(tokenId, false)` event via the existing
`applyContractEvent` path — the same path covered by the suspended-membership
integration scenarios.

## API

| Method | Path | Auth |
| ------ | ---- | ---- |
| `POST` | `/v1/communities/:communityId/members/:wallet/appeals` | API key + SIWE; requester must own `:wallet` |
| `GET` | `/v1/communities/:communityId/appeals` | API key + SIWE + community admin; paginated (`page`/`limit`) |
| `POST` | `/v1/communities/:communityId/appeals/:appealId/decision` | API key + SIWE + community admin; body `{ decision, rationale }` |

`decision` is `approved` or `denied`. `rationale` is required and stored on the
appeal and in `audit_events`.

## Approval orchestration

Inside a single Prisma transaction, approval:

1. Transitions the appeal `pending → approved` with `reviewerId` / `reviewedAt` /
   `reviewerRationale`.
2. Writes a chained `audit_events` row (`SUSPENSION_APPEAL_APPROVED`).
3. Emits a durable outbox event `MEMBERSHIP_UNSUSPEND_REQUESTED` whose payload
   includes `tokenId`, `chainId`, `contractAddress`, `wallet`, and
   `requiresAuthorizedSigner: true`.

The API **does not** call `MembershipNFT.setSuspended`. An authorized admin
wallet or operator process must execute that transaction (or an equivalent
renew path). After the chain emits `MembershipSuspended(false)`, the indexer
updates off-chain state and access is restored.

Denial writes audit (`SUSPENSION_APPEAL_DENIED`) and does not emit an unsuspend
outbox event.

## Related

- Data model: `SuspensionAppeal` / `SuspensionAppealStatus` in
  `apps/access-api/prisma/schema.prisma`
- On-chain suspension: `MembershipNFT.setSuspended` /
  `MembershipSuspended` event
- Existing deferred README note replaced by this subsystem
