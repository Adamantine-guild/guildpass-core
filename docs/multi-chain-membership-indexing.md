# Multi-chain membership indexing design

GuildPass now treats a membership deployment as `(chainId, membershipNftAddress, rpcUrl)` rather than a single global contract.

## Data model

- `ChainConfig` stores every configured EVM deployment and RPC endpoint.
- `Community.chainConfigId` optionally pins a community to the deployment that owns its membership events.
- `IndexerState` checkpoints by `(chainId, contractAddress)` so two chains can index concurrently without overwriting each other.
- `ProcessedEvent` includes `chainId` in its uniqueness constraint, because `(transactionHash, logIndex)` is not a cross-chain identity.

Existing single-chain installs can continue using `CHAIN_ID`, `RPC_URL`, and `MEMBERSHIP_NFT_ADDRESS`. New deployments should prefer `MEMBERSHIP_CHAIN_CONFIGS`, a JSON array of chain configs, then backfill `Community.chainConfigId` for each community.

## Replay protection

Every decoded membership event is applied with an explicit `chainId`. The indexer overwrites/sets the event `chainId` from its adapter config before persistence. Idempotency uses `(chainId, transactionHash, logIndex)`, and audit/outbox correlation includes `chainId`, so a proof from chain A cannot mark an otherwise-identical proof from chain B as valid or already processed.

SIWE or other wallet signatures must keep the EIP-4361 `Chain ID` field in the signed message and compare it to the community's `ChainConfig.chainId` before granting access.

## Indexer topology trade-offs

### Single multiplexed process

A single process can host N `IndexerWorker` instances via `MultiChainIndexerWorker`. This is simple to deploy and works well when chains share latency/reliability characteristics. The downside is blast radius: one busy or failing RPC can consume process resources unless each adapter is isolated with timeouts and backpressure.

### Per-chain indexer processes

Running one process per chain isolates RPC failures, makes horizontal scaling and chain-specific finality windows easier, and simplifies operational ownership. The trade-off is more deployment coordination and duplicated worker overhead.

## Recommended path

Start with a single multiplexed process for small installations. Move high-volume or unreliable chains to per-chain processes once metrics show distinct scaling or availability requirements.

## Ingestion guarantees

See [indexer-ingestion-guarantees.md](./indexer-ingestion-guarantees.md) for idempotency, confirmation depth, and reorg rollback (#273).

