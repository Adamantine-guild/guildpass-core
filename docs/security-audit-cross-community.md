# Cross-community data-isolation audit

Audit date: 2026-07-21  
Scope: `memberService.ts`, `resourceService.ts`, and `contractEventHelpers.ts`

## Method

Every direct Prisma read and mutation in the three scoped files was enumerated and
traced back to its community boundary. A query is considered safely scoped when it
uses `communityId` directly, uses a compound unique key containing `communityId`,
or uses an immutable record ID obtained from an already community-scoped query.
Global identity lookups are marked separately and justified by a schema uniqueness
constraint.

Result: no cross-community query gap was found. The existing implementation
consistently scopes community-owned data. The regression suite in
`apps/access-api/test/crossCommunityLeakage.test.ts` now exercises membership,
profile/role, policy, override, cache-key, resource, and contract-event boundaries.

## `memberService.ts`

| Operation | Community-bound selector or value | Status |
| --- | --- | --- |
| `accessPolicy.findFirst` in `checkAccess` | `communityId + resource` | Scoped |
| `accessOverride.findMany` in `checkAccess` | `communityId + resource + wallet` | Scoped |
| `wallet.findUnique` in `checkAccess` | Global `Wallet.address` (`@unique`) | Global identity; safe |
| `member.findFirst` in `checkAccess` | `walletId + communityId` | Scoped |
| `wallet.findUnique` in `getMembershipsByWallet` | Global `Wallet.address` (`@unique`) | Global identity; safe |
| `member.findMany` in `getMembershipsByWallet` | `walletId`; adds `communityId` for community routes | Scoped/intentional aggregate |
| `wallet.findUnique` in `getProfileByWallet` | Global `Wallet.address` (`@unique`) | Global identity; safe |
| `member.findFirst` in `getProfileByWallet` | `walletId`; adds `communityId` for community routes | Scoped/intentional aggregate |
| `member.findMany` in `listMembersForAdmin` | `communityId` | Scoped |
| Requester `wallet.findUnique` in `assignMemberRole` | Global `Wallet.address` (`@unique`) | Global identity; safe |
| Requester `member.findFirst` in `assignMemberRole` | `walletId + communityId` | Scoped |
| Target `wallet.findUnique` in `assignMemberRole` | Global `Wallet.address` (`@unique`) | Global identity; safe |
| Target `member.findFirst` in `assignMemberRole` | `walletId + communityId` | Scoped |
| `roleAssignment.findFirst` / `create` in `assignMemberRole` | Community-scoped target `memberId` | Scoped by parent |
| Requester `wallet.findUnique` in `createAccessOverride` | Global `Wallet.address` (`@unique`) | Global identity; safe |
| Requester `member.findFirst` in `createAccessOverride` | `walletId + communityId` | Scoped |
| `accessOverride.findFirst` in `createAccessOverride` | `communityId + wallet + resource` | Scoped |
| `accessOverride.update` in `createAccessOverride` | ID returned by the scoped lookup | Scoped by prior query |
| `accessOverride.create` in `createAccessOverride` | Writes `communityId` | Scoped |
| Requester `wallet.findUnique` in `revokeAccessOverride` | Global `Wallet.address` (`@unique`) | Global identity; safe |
| Requester `member.findFirst` in `revokeAccessOverride` | `walletId + communityId` | Scoped |
| `accessOverride.findFirst` / `delete` in `revokeAccessOverride` | `communityId + wallet + resource`; delete uses returned ID | Scoped |
| Requester `wallet.findUnique` in `removeMemberRole` | Global `Wallet.address` (`@unique`) | Global identity; safe |
| Requester `member.findFirst` in `removeMemberRole` | `walletId + communityId` | Scoped |
| Target `wallet.findUnique` in `removeMemberRole` | Global `Wallet.address` (`@unique`) | Global identity; safe |
| Target `member.findFirst` in `removeMemberRole` | `walletId + communityId` | Scoped |
| `roleAssignment.updateMany` in `removeMemberRole` | Community-scoped target `memberId` | Scoped by parent |

The access-decision key and all five version-counter keys include `communityId`, so
identical wallet/resource/version inputs in two communities cannot share cache state.

## `resourceService.ts`

| Operation | Community-bound selector or value | Status |
| --- | --- | --- |
| `wallet.findUnique` in `assertRequesterIsAdmin` | Global `Wallet.address` (`@unique`) | Global identity; safe |
| `member.findFirst` in `assertRequesterIsAdmin` | `walletId + communityId` | Scoped |
| `resource.findMany` in `listResources` | `communityId` | Scoped |
| `resource.findUnique` in `upsertResource` | Compound `communityId_resourceId` | Scoped |
| `resource.update` / `findUnique` in the update branch | Compound `communityId_resourceId` | Scoped |
| `resource.create` in the create branch | Writes `communityId` | Scoped |
| `resource.findUnique` in `updateResource` | Compound `communityId_resourceId` | Scoped |
| `resource.update` in `updateResource` | Compound `communityId_resourceId` | Scoped |
| `resource.findUnique` in `archiveResource` | Compound `communityId_resourceId` | Scoped |
| `resource.update` in `archiveResource` | Compound `communityId_resourceId` | Scoped |
| `resource.findUnique` in `isResourceActive` | Compound `communityId_resourceId` | Scoped |

Every resource outbox write also receives the same normalized `communityId` used by
the resource mutation.

## `contractEventHelpers.ts`

| Operation | Community-bound selector or value | Status |
| --- | --- | --- |
| `processedEvent.findUnique` / `create` | Global on-chain event identity (`transactionHash + logIndex`) | Not community-owned |
| `wallet.upsert` for mint | Global `Wallet.address` (`@unique`) | Global identity; safe |
| `community.upsert` for mint | Community primary key `id` | Scoped |
| `member.upsert` for mint | Compound `communityId_walletId` | Scoped |
| `membership.findUnique` / `upsert` for mint | `memberId` from the scoped member | Scoped by parent |
| Audit and outbox creates for mint | Writes the event's `communityId` | Scoped |
| `membership.findFirst` for renewal | Global `Membership.tokenId` (`@unique`) | Global token identity; safe |
| `membership.update` for renewal | ID returned by token lookup | Scoped by parent |
| Audit and outbox creates for renewal | Community derived from `membership.member.communityId` | Scoped by parent |
| `membership.findFirst` for suspension | Global `Membership.tokenId` (`@unique`) | Global token identity; safe |
| `membership.update` for suspension | ID returned by token lookup | Scoped by parent |
| Audit and outbox creates for suspension | Community derived from `membership.member.communityId` | Scoped by parent |
| `community.upsert` in `ensureCommunity` | Community primary key `id` | Scoped |
| `member.findFirst` in `getCurrentMembershipState` | Wallet relation + community relation | Scoped |
| `membership.findUnique` in `tokenIdExists` | Global `Membership.tokenId` (`@unique`) | Global token identity; safe |

Renewal and suspension events do not carry a community ID. Their token lookup is
safe under the current data model because `Membership.tokenId` is globally unique;
the community used for subsequent writes is taken from the matched member rather
than from caller-controlled context.
