# Indexer ingestion guarantees

This document describes the production MembershipNFT event ingestion
pipeline in `apps/access-api` (issue #273, building on #144 / #52).

## Exactly-once processing (idempotency)

Each applied log is recorded in `ProcessedEvent` with unique key:

```text
(chainId, transactionHash, logIndex)
```

`applyContractEvent` checks this key before mutating membership / admin /
ownership state. Re-delivery of the same log (worker restart, overlapping
polls, or replay) is a no-op.

Fixtures may supply either `transactionHash` or legacy `txHash`; both map
to the same idempotency key.

## Confirmation depth

The indexer only applies logs at or below:

```text
safeBlock = latestBlockNumber - confirmationDepth
```

Configuration (aliases — first set wins for `INDEXER_FINALITY_WINDOW`):

| Env var | Default | Meaning |
|---|---|---|
| `INDEXER_FINALITY_WINDOW` | `12` | Preferred name |
| `INDEXER_CONFIRMATION_DEPTH` | — | Alias |
| `CONFIRMATION_BLOCKS` | — | Alias (#273 wording) |

Unconfirmed tip blocks are left for a later poll once they gain enough
confirmations.

## Reorg handling

On each pass the worker compares the tip hash stored in `IndexerState`
with the provider hash at that height.

1. **Detect** — mismatch ⇒ reorg.
2. **LCA** — walk `BlockHeader` vs provider hashes to find the common
   ancestor (`findCommonAncestor`, #144). If search depth is exceeded,
   raise `ReorgTooDeepError` (operational alert; no silent under-rewind).
3. **Reverse** — for audit rows with `blockNumber > LCA`, restore
   `beforeState` for membership tokens / contract admin / ownership, then
   delete orphaned audit + outbox rows for those heights.
4. **Forget** — delete `ProcessedEvent` and `BlockHeader` rows after the
   LCA so canonical logs can be re-applied.
5. **Rewind** — set `IndexerState` to the LCA.
6. **Reapply** — the next forward pass scans from `LCA + 1` and applies
   the canonical chain.

## Related components

- `IndexerWorker` / `MultiChainIndexerWorker` — poll + apply path
- `onChainReconciliationWorker` — detect-only drift sampling (does not
  auto-correct; see its own docs)
- Integration coverage: `membership-integration.test.ts` (“Resilient
  Indexing Pipeline”) and `indexerWorker.reorg.test.ts`
