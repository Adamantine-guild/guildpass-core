# Security Review: MembershipNFT.sol

**Scope:** `contracts/src/MembershipNFT.sol`
**Reviewed against:** the in-scope categories listed in [SECURITY.md](../SECURITY.md) —
reentrancy, access-control bypass, integer overflow/underflow in expiry
logic, event-emission integrity, and denial-of-service in public functions.

This document records what was checked, what was found, and what changed as
a result. Regression tests for every fix live in
`contracts/test/MembershipNFT.t.sol` and
`contracts/test/MembershipFuzzInvariant.t.sol`.

---

## Findings

### 1. `setAdmin` did not emit an event (event-emission integrity) — Fixed

**Before:** `setAdmin(address who, bool enabled)` wrote directly to the
`admins` mapping with no event. Every other state-changing function
(`mint`, `renew`, `setSuspended`) emits an event, and SECURITY.md states
off-chain indexers "trust these events completely." An admin grant or
revocation — arguably the most security-relevant state change in the
contract — was invisible to any off-chain system that only listens to
events instead of polling `admins(address)` for every address it cares
about.

**Impact:** An indexer or monitoring system built purely on event logs
(the pattern this contract explicitly optimizes for) could not detect when
an address gained or lost the ability to mint/renew/suspend memberships.

**Fix:** `setAdmin` now emits `AdminUpdated(address indexed admin, bool enabled)`.

**Test:** `testSetAdminEmitsEvent` (`MembershipNFT.t.sol`).

### 2. Re-minting left two simultaneously-active tokens for one (wallet, community) pair — Fixed

**Before:** `mint()` unconditionally overwrote `_activeTokenOf[to][communityId]`
with the new token id, but never touched the previous token's own
`_suspended`/`_expiry` state. If the previous token was still within its
validity window, `isActive(previousTokenId)` continued to return `true`
even though it was no longer the wallet's "active" token per
`activeTokenOf`. Any consumer that checks a *specific* token id (rather
than looking it up via `activeTokenOf`) would see two valid memberships
for the same wallet in the same community simultaneously — the contract's
implicit invariant ("at most one active membership per wallet per
community") did not actually hold on-chain.

This is a real behavior change from the previous test suite: the existing
fuzz test `testInvariant_singleActivePerWalletPerCommunity` only asserted
that `activeTokenOf` pointed at *one of* the two minted tokens and that
*that* token was active — it never asserted the other token was inactive,
so it passed while the invariant was actually violated.

**Impact:** Off-chain services that cache "is token X active" by id (e.g.
a Discord role sync keyed on a previously-seen token id) could continue
granting access through a stale token after an admin intended to replace
it via re-mint, until it naturally expired.

**Fix:** `mint()` now suspends the wallet's previous active token for that
community *if and only if it is still currently active* (not already
suspended, and not already expired) before minting the new one. Emits the
existing `MembershipSuspended` event so the transition is observable.
Tokens that already expired naturally are left untouched — they're already
inactive, and marking them "suspended" would misrepresent the reason in
the event log (natural expiry vs. an admin action).

**Tests:** `testReMintingSuspendsThePreviousActiveToken`,
`testReMintingAfterExpiryDoesNotEmitRedundantSuspend`, and the corrected
`testInvariant_singleActivePerWalletPerCommunity` fuzz test.

### 3. `setAdmin(address(0), ...)` was accepted — Fixed (defense in depth)

**Before:** No zero-address check. Granting admin to `address(0)` is
harmless in practice (nothing can transact from it), but accepting it
silently masks what is very likely a caller-side bug (a missing/failed
address lookup resolving to the zero value).

**Fix:** `setAdmin` now reverts with `INVALID_ADMIN` for `address(0)`,
matching the existing `INVALID_TO` / `INVALID_DURATION` input-validation
style already used in `mint`/`renew`.

**Test:** `testSetAdminRejectsZeroAddress`.

### 4. Single-key, one-step ownership with no recovery path — Partially addressed, residual risk documented

**Before:** `owner` was set once in the constructor with **no function to
ever change it**. Combined with `admins` being a simple mapping controlled
solely by `owner`, this contract's entire security model — who can
mint/renew/suspend memberships for every community it serves — rests on
one EOA's private key, with no way to rotate it even proactively.

**Assessed and NOT changed:** migrating to OpenZeppelin's `AccessControl`
was considered per the issue's suggested implementation, but deferred as a
separate follow-up. `AccessControl` would require adding
`openzeppelin-contracts` as a new dependency (currently only `forge-std` is
vendored), which is a meaningfully larger change (new submodule, new
remapping, new supply-chain surface) than this review's scope of
"audit and fix the existing contract." The current `owner` +
`admins` mapping is not itself a vulnerability — it is a role system, just
a minimal hand-rolled one — so there is no correctness bug to fix here,
only a hardening opportunity.

**Fix applied now:** added a standard two-step ownership transfer
(`transferOwnership` / `acceptOwnership`, mirroring OpenZeppelin's
`Ownable2Step`) so that a future key rotation cannot permanently brick the
contract by transferring to a mistyped or unreachable address — the
previous owner remains in control until the new owner actively accepts.
This was zero-risk to add (no existing functionality depended on
single-step transfer, since no transfer function existed at all before)
and directly reduces the blast radius of an operational mistake during key
rotation.

**Update (issue #102, Merkle batch claim):** `openzeppelin-contracts` (pinned
`v5.6.1`) was subsequently added as a `lib/` dependency, but only for
`MerkleProof.sol` and `BitMaps.sol` — both stateless, function-only libraries
with no inheritance, no constructors, and no effect on this contract's
storage layout or access-control model. This is a materially smaller
addition than the `AccessControl` migration assessed above: it adds no new
admin/role surface, `owner`/`admins` remain the sole access-control
mechanism, and `onlyAdmin` still gates the new `setMembershipMerkleRoot`
exactly as it gates `mint`/`renew`. The reasoning above for declining
`AccessControl` (new submodule, new supply-chain surface, out of scope for
an "audit and fix" review) still stands for anything *stateful*; it does not
extend to pure verification/data-structure libraries with negligible attack
surface.

**Residual risk / recommendation:** the *day-to-day* minting/suspension
key set (`admins`) and the *root* key (`owner`) are both still single EOA
patterns. Before mainnet deployment with real funds/communities at stake,
we recommend:
- `owner` be a multisig (e.g. Safe) rather than a single EOA — it can
  still call `transferOwnership`/`setAdmin` through the same interface.
- Consider a timelock in front of `setAdmin` if the operational model can
  tolerate a delay, so a compromised `owner` key can't instantly grant
  itself/an attacker admin rights with no response window.
- If migrating to `AccessControl` later, keep `onlyAdmin`'s revert string
  (`"NOT_ADMIN"`) stable or coordinate the change with any off-chain code
  that pattern-matches on it (none currently does, per a repo-wide search).

**Tests:** `testTransferOwnershipRequiresAcceptance`,
`testAcceptOwnershipRevertsForNonPendingOwner`,
`testTransferOwnershipRejectsZeroAddress`,
`testFuzz_transferOwnership_twoStep`.

### 5. Missing ERC-721 / ERC-165 / ERC-5192 interface — Non-transferable tokens invisible to wallets — Fixed

**Before:** The contract implemented "minimal ERC-721-like" ownership
tracking but did not implement the actual ERC-721 interface (no
`balanceOf`, no `tokenURI`, no ERC-165 `supportsInterface`), did not emit
spec-compliant `Transfer` events, and did not declare non-transferability
via any recognized standard. As a result, wallets, block explorers, and
NFT marketplaces could not recognize, display, or correctly represent
membership tokens — undermining the "membership NFT" branding.

**Impact:** Users' wallet apps could not show GuildPass membership NFTs
the way they show any standard NFT. Marketplaces could not correctly
refuse to list soulbound tokens (they would silently fail rather than
showing a clear "non-transferable" state).

**Fix applied:**

1. **`supportsInterface(bytes4)`** — returns `true` for IERC165
   (`0x01ffc9a7`), IERC721 (`0x80ac58cd`), and IERC5192 (`0x4bc2a65b`);
   `false` for unrelated interfaces.

2. **`balanceOf(address)`** — returns the number of tokens currently owned
   by a wallet. Maintained via an incrementing/decrementing counter with
   swap-and-pop removal on `_ownedTokens`, keeping mint and suspend paths
   O(1) (one new SSTORE each).

3. **`tokenURI(uint256)`** — returns a well-formed URI
   (`baseTokenURI` + decimal token id) for any minted token; reverts with
   `NO_TOKEN` for nonexistent tokens (matching `ownerOf`'s revert behavior).

4. **`locked(uint256)`** (ERC-5192) — always returns `true` since
   transfers are never implemented; reverts for nonexistent tokens.

5. **ERC-721 `Transfer` events** — emitted additively (not replacing
   custom events) on mint (`from: address(0)`) and suspend
   (`to: address(0)`), so existing indexers built against
   `MembershipMinted`/`MembershipSuspended` keep working unchanged.

6. **ERC-5192 `Locked` event** — emitted on mint, signaling the token is
   soulbound.

7. **`baseTokenURI`** — configurable in the constructor; exposed via a
   public getter.

**Gas impact:** The `mint()` path gains ~16k gas per call (two additional
SSTOREs for `_balances` and `_ownedTokens`, plus one event emission for
`Transfer` and one for `Locked`). `setSuspended()` gains ~10k gas when
toggling active status (one `Transfer` event + one SSTORE for `_balances`
+ swap-and-pop on `_ownedTokens`). Renewal paths are unaffected. See
`GasBenchmark.t.sol` for measured values.

**Tests:** `testSupportsInterface_IERC165`, `testSupportsInterface_IERC721`,
`testSupportsInterface_IERC5192`, `testSupportsInterface_UnrelatedInterface`,
`testBalanceOf_*` (7 tests), `testTokenURI_*` (2 tests),
`testLocked_*` (4 tests), `testMintEmitsTransferFromZero`,
`testMintEmitsLockedEvent`, `testSuspendEmitsTransferToZero`,
`testRemintEmitsBothTransferEvents`, `testBaseTokenURI_ReturnsConfiguredValue`.

---

## Checked, no issue found

### Reentrancy
The contract makes **no external calls** anywhere — no `.call`, no ETH
transfers, no calls into `to` or any other supplied address, and no
callback hooks (this is not a full ERC-721: there is no `safeTransferFrom`
and no `onERC721Received` callback). There is no reentrancy surface to
exploit. No changes made.

### Integer overflow/underflow in expiry logic
All arithmetic runs under Solidity ^0.8.23, which reverts on
overflow/underflow by default (no `unchecked` blocks are used anywhere in
this contract). `renew()`'s `current + duration` can in theory revert if
`duration` is large enough to overflow `uint256` from an already-large
`current` — but `duration` is admin-supplied (`onlyAdmin`), not
attacker-controlled from an untrusted caller, so this is an operational
footgun (a mistaken renew reverts, it doesn't corrupt state) rather than a
security vulnerability. No changes made; `testFuzz_renew_extends` already
exercises a range of durations and confirms expiry always strictly
increases.

### Timestamp manipulation
`isActive()` and `renew()` both compare against `block.timestamp`. Miners/
validators can influence `block.timestamp` by roughly a dozen seconds at
most on mainnet-like chains. Membership durations are expected to be
measured in days at minimum (the test suite uses durations from 1 second
up to 3650 days), so a ~12-second manipulation window is not economically
meaningful against this contract — it cannot flip a membership from
"expired" to "active" (or vice versa) except within a sub-minute sliver of
its actual expiry, which has no exploitable value here (unlike, say, an
auction or price oracle). Added `testExpiryBoundary` /
`testFuzz_expiryBoundary` to lock in the exact boundary semantics
(`isActive` is true up to and excluding the expiry timestamp itself) as a
regression guard, but no code change was needed.

### Denial of service in public functions
No function contains unbounded loops over user-controlled collections —
every function operates on O(1) mapping reads/writes. `mint`'s new
previous-token-suspension logic is also O(1) (a single mapping lookup),
so it does not introduce a new DoS vector.

### Transfers
The contract has no `transferFrom`/`safeTransferFrom` at all — membership
tokens are non-transferable by construction (only admin-driven mint/renew/
suspend change ownership-adjacent state). This sidesteps an entire class of
ERC-721 transfer-time vulnerabilities (reentrancy via `onERC721Received`,
approval-based theft, etc.) since the surface doesn't exist. The contract
now implements ERC-5192 (`locked()` always returns `true`) to explicitly
declare non-transferability so marketplaces correctly refuse to list tokens.
ERC-721 `Transfer` events are emitted additively for wallet/display
compatibility but never indicate actual token transfers.

---

## Summary

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | `setAdmin` missing event | Medium (breaks off-chain indexing trust) | Fixed |
| 2 | Re-mint leaves stale token active | High (violates core membership invariant) | Fixed |
| 3 | `setAdmin(address(0), ...)` accepted | Low (defense in depth) | Fixed |
| 4 | Single-key owner, no transfer path | Medium (operational/key-management risk) | Two-step transfer added; multisig/timelock recommended before mainnet |
| 5 | Missing ERC-721/ERC-165/ERC-5192 interface | Medium (tokens invisible to wallets/explorers/marketplaces) | Fixed (read-only ERC-721, ERC-165, ERC-5192 soulbound) |
| — | Reentrancy | N/A | Reviewed, no external calls exist |
| — | Integer overflow in expiry | N/A | Reviewed, checked arithmetic + admin-only input |
| — | Timestamp manipulation | Low | Reviewed, not economically exploitable at this contract's timescales |
| — | DoS in public functions | N/A | Reviewed, all operations are O(1) |
