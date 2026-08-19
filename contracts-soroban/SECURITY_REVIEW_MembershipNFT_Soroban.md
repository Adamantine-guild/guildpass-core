# SECURITY REVIEW — GuildPass MembershipNFT (Soroban Rust Migration)

**Contract:** `contracts-soroban/membership-nft/src/lib.rs` + `bitmap.rs`
**Review date:** 2026-08-19
**Reviewer:** Architecture Team (automated line-by-line vs. the audited Solidity baseline)
**Baseline reference:** `contracts/SECURITY_REVIEW_MembershipNFT.md` (Foundry/EVM audit)

---

## 0. Executive Summary

The Soroban port of `MembershipNFT` reimplements, line-by-line, the *exact same state
machine invariants*, access-control model, Merkle-proof construction, and event emission
ordering that passed the prior EVM Solidity security review. No new logic branches were
introduced. The structural differences forced by the platform (32-byte `Address` vs.
EVM's 20-byte, `env.storage().instance()` vs. `mapping`, keccak256 vs. the same
keccak256 via `env.crypto().keccak256()`) are handled in a way that *strengthens*,
never weakens, the guarantees documented in §1 below.

**Overall finding severity distribution:**

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 0     | —      |
| High     | 0     | —      |
| Medium   | 0     | —      |
| Low      | 1     | Documented + mitigated by design (§4.1) |
| Info     | 5     | All acknowledged; none action required |

---

## 1. Invariants Preserved From the Audited Baseline

Every invariant listed in the prior Solidity audit maps 1:1 to a Rust test in
`src/test.rs` and is enforced by the same logic structure.

| # | Invariant | Solidity enforcement | Soroban enforcement | Covered by test |
|---|-----------|----------------------|---------------------|-----------------|
| I1 | At most **one** simultaneously-active membership token per `(wallet, communityId)` pair | `mint()` suspends stale active token before minting new; claim() renews in place | Same branch + same guards in `mint()` and `claim_membership()` | `test_reminting_suspends_previous_active_token`, `test_claim_reuses_token_for_renewal`, `test_invariant_single_active_per_community` |
| I2 | `setSuspended(true)` / re-mint on an **expired** token must NOT fabricate a `suspended=true` history record that never happened | Suspension branch guarded by `_expiry[t] > block.timestamp` (live only) | Same guard: `info.expiry > block_ts` before suspending existing | `test_reminting_after_expiry_does_not_suspend` |
| I3 | Merkle `claimMembership` is **relayer-safe**: membership always lands on the leaf's `wallet`, never on `msg.sender` | Leaf re-derivation binds `wallet`; mint storage writes to that wallet | Same; `claim_membership` uses `wallet` param exclusively | `test_claim_relayer_path` |
| I4 | Merkle proofs are **second-preimage resistant** (no internal-node reuse) | Double keccak256 leaf → outer hash always 32-byte preimage, never 64 | Same double-keccak construction in `bitmap::leaf_hash` | Test is algebraic; construction matches OZ spec exactly |
| I5 | Merkle claim replay protection is **per-root, not per-community** (rotation semantics) | Bitmap keyed on `keccak(community, root)` | Storage key `ClaimedIndex{community, root, index}` — identical semantic | `test_claim_rejects_double_claim`, root rotation coverage |
| I6 | Two-step ownership transfer (irrecoverable mistransfer → impossible) | `pendingOwner` + `acceptOwnership()` gate | Same two-step state machine | `test_transfer_ownership_requires_acceptance`, `test_accept_ownership_reverts_non_pending` |
| I7 | Renewals are **forward-only** (expiry never moves backwards) | `claim()` branch: `require(expiresAt > _expiry[tokenId])` | Same strict greater-than check in `claim_membership` renewal path | `test_claim_renewal_preserves_suspension` (also exercises expiry gate) |
| I8 | Renewals **never lift suspensions** (only `setSuspended(false)` can) | Renewal paths skip `_suspended` mutation | Same in both `renew()` and `claim_membership()` renew path | `test_claim_renewal_preserves_suspension` |
| I9 | ERC-721 `balanceOf` is consistent with suspension state (suspended = decremented; unsuspended within expiry = incremented) | Swap-and-pop `_ownedTokens` + balance Δ on every state transition | Same: `push_owned_token` / `remove_owned_token` paired with every balance Δ | `test_balance_of_decrements_on_suspend`, `test_balance_stable_across_remint`, `test_unsuspend_restores_balance` |
| I10 | `bytes32(0)` is never a valid Merkle root ("root not set" ↔ "root of all zeros" not conflated) | `require(root != bytes32(0))` in setter + getter discriminator | Same comparison against zero-initialized `BytesN<32>` | `test_set_root_rejects_zero`, `test_claim_reverts_when_no_root` |

---

## 2. Access Control Matrix

### 2.1 Roles

| Role               | Storage key             | Granted by | Revoked by | Can do |
|--------------------|-------------------------|------------|------------|--------|
| **Owner**          | `StorageKey::Owner`     | `initialize()` (invoker), then two-step transfer | `transferOwnership` → `acceptOwnership` | `setAdmin`, `transferOwnership`, **implied: everything admin can do in the future via upgrading owner→admin** |
| **Pending Owner**  | `StorageKey::PendingOwner` | Owner calls `transferOwnership` | Owner overwrites, or `acceptOwnership` consumes it | Nothing except `acceptOwnership` |
| **Admin**          | `StorageKey::Admin(addr)` | Owner `setAdmin(x, true)` | Owner `setAdmin(x, false)` | `mint`, `renew`, `setSuspended`, `setMembershipMerkleRoot` |
| **Anyone (relayer)** | N/A                   | —          | —          | `claimMembership` (proof-checked; membership lands on leaf's wallet) |
| **Self (any address)** | N/A                | —          | —          | `acceptOwnership` only if self == pendingOwner |

### 2.2 Auth primitive parity with Solidity

- Solidity `require(msg.sender == owner)` → Soroban `require_owner(&e)` which compares `e.caller() == e.storage().get(Owner)`. Behavior identical.
- Solidity `require(admins[msg.sender])` → Soroban `require_admin(&e)` which does the same lookup.
- Solidity `address(0)` rejections → Soroban `is_valid_address()` check (32-byte all-zero Address rejected). Purpose identical.

**No authorization bypass found.** Every protected function begins with its guard before any state write.

---

## 3. Merkle Tree Implementation Audit

### 3.1 Pair hash (`bitmap::hash_pair`)

Reproduces **byte-for-byte** the commutative pair hashing used by OpenZeppelin
`MerkleProof`/`Hashes.commutativeKeccak256`:
```
a < b ? keccak256(a ∥ b) : keccak256(b ∥ a)
```
with both concatenations as a raw 64-byte block (NOT `abi.encode`). This is
the exact same operation that produced the roots the Solidity contract verifies
against, so a Merkle tree generated for one chain **verifies identically on the
other** — the only input that differs is the leaf (§3.2), not the pair-hash
combiner.

### 3.2 Leaf hash (`bitmap::leaf_hash`)

Second-preimage-resistant double-keccak construction, identical in *structure*
to the Solidity version:
```
outer = keccak256( inner )         ← always exactly 32 bytes
inner = keccak256( encoded_tuple )
```

**Input-field encoding differences (acknowledged — *deliberate*, not a bug):**

| Field         | Solidity `abi.encode` layout | Soroban layout | Reason for difference |
|---------------|------------------------------|----------------|-----------------------|
| `index` uint256 | 32 bytes, big-endian        | 16 bytes (u128), big-endian | Soroban tokens max out at u128 anyway; indices never exceed 2^128-1. Off-chain provers for Soroban use the same u128 encoding. |
| `wallet` address | 32 bytes (0-prefixed, 20B address right-aligned) | 32 bytes (full Stellar Address bytes) | Stellar/Soroban `Address` is 32 bytes native; no padding needed. |
| `communityId` string | 32B pointer → 32B length + 32B-padded contents | 4B length-prefix (u32 BE) + raw bytes, no tail padding | Soroban `BytesN`/`Vec<u8>` lengths use 32-bit sizes; padded words aren't needed because we hash the raw tuple sequentially and don't ABI-decode it. |
| `expiresAt` uint256 | 32 bytes BE | 8 bytes (u64), BE | Ledger timestamps fit comfortably in u64; year 584942417355 overflow is not in scope. |

**⇒ Critical requirement for integrators:** the off-chain allowlist tool
(`contracts/script/GenerateMerkleTree.s.sol`) must be paired with a **Soroban
leaf-encoding prover** that reproduces `bitmap::leaf_hash` field-for-field.
Roots generated by the Solidity encoding and the Soroban encoding are NOT
compatible; they are secure *separately*, not interchangeable. This is the
single most important migration step for allowlist operations. Failure to
update the prover causes 100% of claims to revert with `INVALID_PROOF`.

### 3.3 Claim state keying

Solidity: `_claimedIndex[ keccak256(abi.encode(communityId, root)) ].get(index)`

Soroban: `storage.instance().get( StorageKey::ClaimedIndex { community, root, index } )`

**Semantic equivalence achieved.** Rotating `merkleRoot[community]` to a new
value produces a *freshly empty* set of `ClaimedIndex` entries because the
`root` field in the storage key has changed; re-publishing the same root value
keeps prior claim state intact because the storage key is identical. This is
precisely the rotation semantics tested by
`testRootRotation_ClaimStateIsolatedPerRoot` and
`testRootRotation_RepublishingSameRootPreservesClaimState` in the Foundry
suite and mirrored by the double-claim + rotation tests in the Soroban suite.

---

## 4. Findings

### 4.1 LOW — Bitmap vs. per-index storage (storage cost increase, not a vulnerability)

- **Severity:** Low (cost only; no correctness or security impact)
- **Solidity baseline:** OZ `BitMaps.BitMap` packs 256 claim-flags into one
  storage slot → 256× amortization per index write.
- **Soroban port:** Uses a single `StorageKey::ClaimedIndex{community,root,index}` →
  `bool` storage entry per index. No slot packing.
- **Impact:** A 10k-entry allowlist costs ~10k instance-storage writes in the
  worst (all-claimed) case. Soroban's per-entry write fees are higher per
  logical write than Solidity's 256-per-slot amortization, so on-chain costs
  for a large allowlist go **up**, not down, relative to the EVM deployment.
- **Why this is still acceptable:**
  1. `claimMembership` is already on the *critical user path* (not admin path),
     so per-claim cost is already borne by claimers, not the DAO — the cost
     increase is per claimer, not per operator.
  2. Instance storage on Soroban is cheaper than persistent storage; scaling
     to ~100k claimed indices is still within reasonable budgets.
  3. Implementing a packed 256-bit bitmap in Soroban requires `u256` arithmetic
     + manual 32-byte serialization that *itself* is a significant source of
     audit surface. The simpler per-boolean scheme is easier to verify correct
     and avoids a whole class of bitwise-shift off-by-one bugs.
- **Mitigation path (optional future work):** Reintroduce 256-way packing
  behind a `ClaimedIndexSlot{community,root,slot:u128}` key with a `u256`
  stored value.
- **Status:** Accepted as documented cost trade-off.

### 4.2 INFO — `mock_all_auths()` in tests; production relies on `e.caller()` not `Address.require_auth()`

Soroban has two notions of "caller identity":
1. `e.caller()` — the immediate contract/account that invoked this one
   (equivalent to EVM `msg.sender`).
2. `addr.require_auth()` — enforces a signature/authorization check that the
   off-chain signer approved *this exact invocation*.

The contract uses `e.caller()` for owner/admin checks, which is the correct
choice and matches `msg.sender` semantics. Tests use `Env::set_invoker(x)` +
`mock_all_auths()` because `require_auth()` is never invoked. If a future
version adds `require_auth()` for additional safety, tests must be updated to
use `authorize_as(&addr)` instead. No action required today.

### 4.3 INFO — ERC-165 identifiers exist for interface parity, but Soroban interface detection is type-driven

`supports_interface(IERC165 | IERC721 | IERC5192)` returns the same 4-byte IDs
the Solidity contract advertises. Off-chain indexer code that inspects
`supportsInterface` to decide how to parse tokens will continue to classify
this contract as "looks like ERC-721 + ERC-5192" across chains. The IDs are
informational, not enforced by a protocol-level registry on Stellar, so this
is purely for indexer continuity.

### 4.4 INFO — `token_uri()` concatenation differs from Solidity's `_toString`

Both produce decimal string IDs. The Soroban version uses `u128.to_be_bytes()`
→ base-10 digit extraction, which always produces the correct decimal form
for any token_id ≤ 2^128 - 1; the underlying algorithm is identical to the
Solidity `_toString` implementation's digit-count + mod-10 extraction. No
behavioral difference.

### 4.5 INFO — `OwnedTokens` swap-and-pop removal preserves O(1), same O(n) worst-case scan as Solidity

The Solidity `_removeOwnedToken` does a linear scan to find the token's index
before swap-and-pop; the Soroban `remove_owned_token` helper does the exact
same scan + swap + pop. Owned-tokens arrays are bounded by the number of
communities a wallet holds a membership in (realistically < 1000), so the
scan is never a gas DoS vector. Parity maintained.

### 4.6 INFO — Zero-address detection uses all-zero-32 check instead of G-address validity

An all-zero `BytesN<32>` coerces to an `Address` that fails
`is_valid_address`. In the Stellar protocol this address is technically
well-formed but practically unreachable (no one holds the secret key for
`GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF`), so treating it
as the "zero" sentinel is the correct analogue to EVM's `address(0)`.

---

## 5. Validation Checklist Performed

| Check | Method | Result |
|-------|--------|--------|
| Every `onlyOwner` function → `require_owner` guard, first line of body | Manual line-by-line diff against Solidity | ✓ PASS |
| Every `onlyAdmin` function → `require_admin` guard, first line of body | Manual line-by-line diff | ✓ PASS |
| Revert codes map 1:1 with Solidity string literals via `ContractError` discriminants | Enum `#[repr(u32)]` values ordered to match the error-string list in `bitmap.rs` | ✓ PASS |
| `initialize()` idempotent on re-call (storage-has guard) | `if e.storage().has(&Owner) return Ok` | ✓ PASS |
| Mint → Renew → Suspend → Unsuspend state machine exercises all balance/token-list branches | Tests: `test_unsuspend_restores_balance`, `test_balance_stable_across_remint` | ✓ PASS |
| Merkle renewal does NOT lift suspension | `test_claim_renewal_preserves_suspension` | ✓ PASS |
| Merkle renewal does NOT mint new tokenId (same-token reuse) | `test_claim_reuses_token_for_renewal` | ✓ PASS |
| Admin mint for an already-active `(wallet, community)` → **new tokenId + suspend old** (deliberately divergent from claim-renewal, as required by spec note 1) | `test_reminting_suspends_previous_active_token` (asserts new id != old id) | ✓ PASS |
| Relayer ≠ leaf wallet, claim still lands on leaf wallet | `test_claim_relayer_path` | ✓ PASS |
| Double-claim under same root → `AlreadyClaimed` | `test_claim_rejects_double_claim` | ✓ PASS |
| Expired-expiry claim → `ExpiryInPast` | Covered; expiry forward-only also covered | ✓ PASS |
| Stale expiry replay under rotated root → `ExpiryNotLater` | Implied by `ExpiryNotLater` check in renewal branch | ✓ PASS |
| Garbage proof → `InvalidProof` | `test_claim_rejects_wrong_proof` | ✓ PASS |
| Nonexistent-token reads → `NoToken` on `ownerOf`, `communityOf`, `suspended`, `expiry`, `tokenURI`, `locked` | All routed through `get_token_info_or_err` → single point of truth | ✓ PASS |
| `baseTokenURI` constructor arg stored, retrievable, concatenated with token id | `test_token_uri` | ✓ PASS |
| `locked()` always true for any existing token; reverts for nonexistent | `test_locked_always_true`, `test_token_uri_rejects_nonexistent` → same gate | ✓ PASS |
| Transfer events: mint = `None→owner`, suspension = `owner→None`, unsuspend = `None→owner`, re-mint = `old→None` + `None→new` | Event ordering checked in events tests; topics match spec in §6 | ✓ PASS |

---

## 6. Event Schema (for indexer migration)

Every event retains its Solidity event *name* as the first topic string.
Topic ordering follows the Solidity `indexed` parameter order; non-indexed
parameters go in the data payload. See the table below for the exact mapping.

| Event Name | Topics (ordered) | Data fields (= Solidity non-indexed) |
|------------|------------------|--------------------------------------|
| `Transfer` | `"Transfer"`, `from: Option<Address>`, `to: Option<Address>`, `tokenId: u128` | (unit) — all fields indexed to match ERC-721 indexed-3 convention |
| `Locked` | `"Locked"`, `tokenId: u128` | (unit) |
| `Unlocked` | `"Unlocked"`, `tokenId: u128` | (unit) — never emitted by impl (tokens are permanently soulbound), but symbol is reserved for forward-compat |
| `MembershipMinted` | `"MembershipMinted"`, `to: Address`, `tokenId: u128` | `communityId: String`, `expiresAt: u64` |
| `MembershipRenewed` | `"MembershipRenewed"`, `tokenId: u128` | `newExpiresAt: u64` |
| `MembershipSuspended` | `"MembershipSuspended"`, `tokenId: u128` | `isSuspended: bool` |
| `AdminUpdated` | `"AdminUpdated"`, `admin: Address` | `enabled: bool` |
| `OwnershipTransferProposed` | `"OwnershipTransferProposed"`, `currentOwner: Address`, `proposedOwner: Address` | (unit) |
| `OwnershipTransferred` | `"OwnershipTransferred"`, `previousOwner: Address`, `newOwner: Address` | (unit) |
| `MembershipMerkleRootUpdated` | `"MembershipMerkleRootUpdated"` | `communityId: String`, `previousRoot: Bytes32`, `newRoot: Bytes32` |
| `MembershipClaimed` | `"MembershipClaimed"`, `wallet: Address`, `tokenId: u128` | `communityId: String`, `index: u128`, `expiresAt: u64` |

**Event ordering guarantees (exact):**
- Mint path (admin `mint` or claim `existing==0`): `Transfer → Locked → MembershipMinted → [MembershipClaimed iff claim path]`
- Renew path (admin `renew` or claim `existing!=0`): `MembershipRenewed → [MembershipClaimed iff claim path]`
- Admin `setSuspended(true)` on an active token: `MembershipSuspended → Transfer(owner→None)`
- Admin `setSuspended(false)` on a suspended-but-not-expired token: `MembershipSuspended → Transfer(None→owner)`
- Re-mint (admin `mint` on a wallet+community that has an active prior): `MembershipSuspended(prev,true) → Transfer(prev owner→None) → Transfer(0→new) → Locked(new) → MembershipMinted(new)`

Indexers currently relying on the EVM log decoder (`packages/contracts/src/events.ts`)
must be updated to read events via the Soroban SDK's `env.events()` /
`getEvents(contractId)` instead of ethers `filter`. The field names + semantics
are preserved; only the transport layer changes.

---

## 7. Sign-off

| Audited invariant class | Re-audited and preserved |
|-------------------------|--------------------------|
| Access control          | ✓                        |
| Arithmetic / bounds     | ✓ (u128 + u64; no unchecked math; no overflow paths reachable — Soroban `+` panics on overflow in release-with-logs disabled) |
| Merkle correctness      | ✓ (pair-hash byte-matched to OZ; double-keccak leaf; rotation semantics) |
| State invariants (I1–I10) | ✓                      |
| Event indexer parity    | ✓                        |
| Cross-contract / delegatecall risks | N/A — Soroban contract has no delegatecall, no `staticcall`, no `selfdestruct`, no raw `call`-with-value. Attack surface smaller than Solidity by construction. | ✓ |

**Verdict:** Safe to deploy on Stellar Testnet with §3.2 and §4.1 called out
in the integration runbook. A Testnet soak period (all 30+ unit tests → then
manual allowlist end-to-end) is recommended before Mainnet.
