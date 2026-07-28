# Reward engine architecture

`@guildpass/reward-engine` is a pure, pluggable decision package. The access API
adapts outbox events to it and owns persistence.

## Processing flow

1. The outbox worker sends membership, attendance, and contribution-score
   events to `createRewardEventHandler`.
2. `StreakTracker` maps the event timestamp into a configurable UTC daily,
   weekly, or monthly period.
3. Activity in the same period is idempotent for streak purposes. The next
   period increments the streak; any missed period resets it to one.
4. Every registered `RewardRule` evaluates the event and current streak.
5. Grants are inserted into `reward_ledger` with `createMany(skipDuplicates)`.

The ledger has a database unique constraint on
`(walletId, communityId, rewardType, sourceEventId)`. Outbox replay, worker
restart, and concurrent duplicate processing therefore cannot double-credit a
reward. Ledger rows are append-only: the consumer exposes no update or delete
operation, and a database trigger rejects `UPDATE` and `DELETE` statements.

## Reward types and rules

Built-in rules demonstrate points per activity and streak badges. A rule only
implements:

```ts
interface RewardRule {
  readonly id: string;
  evaluate(event: RewardEvent, streak: StreakState): RewardGrant[];
}
```

The engine does not switch on reward type. New reward types are strings, so a
plugin can return `token:erc20` without changing the engine.

## Future token rewards

A token rule should first append a `token:*` grant to the ledger. A separate
settlement worker can claim unsettled token grants, submit an on-chain
transaction, and append settlement metadata in a dedicated settlement table.
Private keys and chain retries remain outside the deterministic reward engine.
The ledger's source-event key prevents duplicate entitlement; the settlement
layer must additionally use its own transaction/idempotency key.

## Read model

`GET /v1/members/:wallet/rewards` returns append-only ledger history and current
streak projections. `communityId` may be supplied as a query filter.

The older daily `StreakState`, `RewardRule`, and `StreakRewardHistory` models
remain available for backward compatibility while consumers migrate.
