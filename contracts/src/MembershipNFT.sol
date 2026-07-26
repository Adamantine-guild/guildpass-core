// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {BitMaps} from "@openzeppelin/contracts/utils/structs/BitMaps.sol";

/// @dev Minimal ERC-5192 (Soulbound) interface. OZ v5.6.1 does not ship
/// this interface, so we define the subset we implement inline.
interface IERC5192 {
    event Locked(uint256 indexed tokenId);
    event Unlocked(uint256 indexed tokenId);
    function locked(uint256 tokenId) external view returns (bool);
}

contract MembershipNFT {
    using BitMaps for BitMaps.BitMap;

    uint256 private _nextTokenId = 1;
    address public owner;
    // Two-step ownership transfer: `owner` only changes once the proposed
    // address calls acceptOwnership(), so a typo'd transferOwnership() call
    // can never permanently brick admin control of the contract.
    address public pendingOwner;

    mapping(address => bool) public admins;

    mapping(uint256 => address) private _ownerOf;
    mapping(uint256 => string) private _communityOf;
    mapping(uint256 => uint256) private _expiry;
    mapping(uint256 => bool) private _suspended;

    // wallet => communityId => active tokenId
    mapping(address => mapping(string => uint256)) private _activeTokenOf;

    // --- ERC-721 read-only compliance ---
    string private _baseTokenURI;
    // wallet => balance (count of tokens the wallet currently owns)
    mapping(address => uint256) private _balances;
    // wallet => owned token ids (swap-and-pop removal for O(1) delete)
    mapping(address => uint256[]) private _ownedTokens;

    // communityId => current Merkle root for batch-claimable allowlist entries.
    // bytes32(0) means "no root published" and must never be treated as a
    // valid, all-zero-leaf root to verify proofs against.
    mapping(string => bytes32) public merkleRoot;

    // keccak256(communityId, root) => bitmap of claimed leaf indices. Keying
    // the bitmap by the root (not just communityId) means rotating to a new
    // root for a community starts every index unclaimed again with zero
    // extra bookkeeping - the old root's claim bitmap simply becomes
    // unreachable dead storage, it is never read or written again. See
    // setMembershipMerkleRoot's NatSpec for the full rotation semantics.
    mapping(bytes32 => BitMaps.BitMap) private _claimedIndex;

    // --- Custom events (preserved for existing indexer compatibility) ---
    event MembershipMinted(
        address indexed to, uint256 indexed tokenId, string communityId, uint256 expiresAt
    );
    event MembershipRenewed(uint256 indexed tokenId, uint256 newExpiresAt);
    event MembershipSuspended(uint256 indexed tokenId, bool isSuspended);
    event AdminUpdated(address indexed admin, bool enabled);
    event OwnershipTransferProposed(address indexed currentOwner, address indexed proposedOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event MembershipMerkleRootUpdated(string communityId, bytes32 previousRoot, bytes32 newRoot);
    event MembershipClaimed(
        address indexed wallet,
        uint256 indexed tokenId,
        string communityId,
        uint256 index,
        uint256 expiresAt
    );

    // --- Standard ERC-721 / ERC-5192 events (additive, not replacing custom events) ---
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Locked(uint256 indexed tokenId);
    event Unlocked(uint256 indexed tokenId);

    constructor(
        string memory,
        /*name*/
        string memory,
        /*symbol*/
        string memory baseTokenURI_
    ) {
        owner = msg.sender;
        _baseTokenURI = baseTokenURI_;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier onlyAdmin() {
        require(admins[msg.sender], "NOT_ADMIN");
        _;
    }

    function setAdmin(address who, bool enabled) public onlyOwner {
        require(who != address(0), "INVALID_ADMIN");
        admins[who] = enabled;
        emit AdminUpdated(who, enabled);
    }

    /// @notice Propose a new owner. Ownership only changes once `proposedOwner`
    /// calls acceptOwnership(), preventing an irrecoverable transfer to an
    /// unreachable or mistyped address.
    function transferOwnership(address proposedOwner) public onlyOwner {
        require(proposedOwner != address(0), "INVALID_OWNER");
        pendingOwner = proposedOwner;
        emit OwnershipTransferProposed(owner, proposedOwner);
    }

    /// @notice Complete a proposed ownership transfer. Callable only by the
    /// proposed owner, so control cannot be transferred to an address that
    /// cannot act on it.
    function acceptOwnership() public {
        require(msg.sender == pendingOwner, "NOT_PENDING_OWNER");
        address previousOwner = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, owner);
    }

    function mint(address to, string memory communityId, uint256 duration)
        public
        onlyAdmin
        returns (uint256)
    {
        require(to != address(0), "INVALID_TO");
        require(duration > 0, "INVALID_DURATION");

        // Enforce "at most one active membership per wallet per community":
        // re-minting while a previous token for this wallet+community is
        // still active would otherwise leave two simultaneously-valid
        // tokens (the old one still reports isActive() == true even though
        // _activeTokenOf no longer points to it). Suspend the stale token
        // first so on-chain state never has two live memberships for the
        // same (wallet, communityId) pair. Only tokens that are CURRENTLY
        // active are touched — a token that already expired naturally is
        // left alone so its history doesn't misleadingly show an admin
        // suspension that never happened.
        uint256 previousTokenId = _activeTokenOf[to][communityId];
        if (
            previousTokenId != 0 && !_suspended[previousTokenId]
                && _expiry[previousTokenId] > block.timestamp
        ) {
            _suspended[previousTokenId] = true;
            emit MembershipSuspended(previousTokenId, true);
            // ERC-721 Transfer event for suspension (token becomes inactive)
            emit Transfer(_ownerOf[previousTokenId], address(0), previousTokenId);
            _balances[to]--;
            _removeOwnedToken(to, previousTokenId);
        }

        uint256 tokenId = _nextTokenId++;
        _ownerOf[tokenId] = to;
        _communityOf[tokenId] = communityId;
        _expiry[tokenId] = block.timestamp + duration;
        _suspended[tokenId] = false;

        _activeTokenOf[to][communityId] = tokenId;

        // ERC-721 compliance: mint Transfer event (from: address(0))
        emit Transfer(address(0), to, tokenId);
        // ERC-5192 compliance: Locked event
        emit Locked(tokenId);

        // Balance tracking
        _balances[to]++;
        _ownedTokens[to].push(tokenId);

        emit MembershipMinted(to, tokenId, communityId, _expiry[tokenId]);
        return tokenId;
    }

    function renew(uint256 tokenId, uint256 duration) public onlyAdmin {
        address tokenOwner = _ownerOf[tokenId];
        require(tokenOwner != address(0), "NO_TOKEN");
        require(duration > 0, "INVALID_DURATION");

        uint256 current = _expiry[tokenId];
        uint256 newExpiry =
            current < block.timestamp ? block.timestamp + duration : current + duration;
        _expiry[tokenId] = newExpiry;

        emit MembershipRenewed(tokenId, newExpiry);
    }

    function setSuspended(uint256 tokenId, bool suspended_) public onlyAdmin {
        address tokenOwner = _ownerOf[tokenId];
        require(tokenOwner != address(0), "NO_TOKEN");

        bool wasActive = !_suspended[tokenId] && _expiry[tokenId] > block.timestamp;
        _suspended[tokenId] = suspended_;
        emit MembershipSuspended(tokenId, suspended_);

        // Emit ERC-721 Transfer + adjust balance when toggling active status
        if (wasActive && suspended_) {
            // Becoming suspended: token becomes inactive
            emit Transfer(tokenOwner, address(0), tokenId);
            _balances[tokenOwner]--;
            _removeOwnedToken(tokenOwner, tokenId);
        } else if (!wasActive && !suspended_ && _expiry[tokenId] > block.timestamp) {
            // Becoming unsuspended while still within expiry: token becomes active again
            emit Transfer(address(0), tokenOwner, tokenId);
            _balances[tokenOwner]++;
            _ownedTokens[tokenOwner].push(tokenId);
        }
    }

    // --- Merkle-based batch mint/renew claim path ---
    //
    // Leaf encoding (integrators reproducing this off-chain MUST match this
    // exactly - a published root is immutable in practice once wallets begin
    // claiming, since changing the encoding invalidates every outstanding
    // proof):
    //
    //   leaf = keccak256(bytes.concat(keccak256(abi.encode(
    //       index,       // uint256 - position of this entry in the source list
    //       wallet,      // address - membership always goes here, never msg.sender
    //       communityId, // string  - same identifier mint()/renew() use
    //       expiresAt    // uint256 - absolute expiry timestamp (NOT a duration)
    //   ))));
    //
    // The double keccak256 (hash-of-the-encoded-tuple, then hashed again)
    // ensures no internal tree node can ever be replayed as a valid leaf
    // (second-preimage resistance) - the outer hash's pre-image is always
    // exactly 32 bytes, so it can never collide with the 64-byte pre-image of
    // an internal node produced by OZ MerkleProof's pair hashing. abi.encode
    // (never abi.encodePacked) is required, not stylistic: communityId is a
    // dynamic type, and packed encoding of dynamic types is ambiguous
    // (e.g. encodePacked("ab","c") == encodePacked("a","bc")).

    /// @notice Publish (or rotate) the Merkle root that gates batch claims for
    /// `communityId` via claimMembership.
    /// @dev Rotation semantics: the claimed-index bitmap is keyed by
    /// keccak256(abi.encode(communityId, root)), not by communityId alone.
    /// Setting a genuinely new root therefore starts every index unclaimed
    /// under that root with no explicit reset - the previous root's bitmap
    /// storage simply becomes unreachable (it is never read or written again
    /// once merkleRoot[communityId] no longer equals it). Re-publishing the
    /// SAME root value is a no-op with respect to claim state: it resolves to
    /// the same bitmap key, so indices already claimed under that root remain
    /// claimed. This is intentional - it is the same tree, so identical root
    /// must imply identical claim state.
    /// @param communityId The community this root gates. Matches mint()'s/
    /// renew()'s communityId exactly - not a separate identifier space.
    /// @param root The new Merkle root. bytes32(0) is rejected: it would
    /// otherwise be indistinguishable from "no root has ever been set", and
    /// claimMembership relies on that distinction to reject claims against an
    /// unpublished community.
    function setMembershipMerkleRoot(string calldata communityId, bytes32 root) external onlyAdmin {
        require(root != bytes32(0), "INVALID_ROOT");
        bytes32 previousRoot = merkleRoot[communityId];
        merkleRoot[communityId] = root;
        emit MembershipMerkleRootUpdated(communityId, previousRoot, root);
    }

    /// @notice Claim (mint or renew) the membership committed to by a Merkle
    /// leaf. Callable by anyone holding a valid proof - relayers may submit on
    /// behalf of a wallet, but the membership always goes to the leaf's
    /// `wallet`, never to msg.sender.
    /// @dev Mint-vs-renew branch: if `wallet` has no existing token for
    /// `communityId`, a new token is minted with its expiry set to `expiresAt`
    /// directly (there is no duration to add to). If `wallet` already holds a
    /// token for `communityId`, that SAME tokenId is renewed in place rather
    /// than suspended-and-replaced - this intentionally differs from admin
    /// mint()'s behavior (which always mints a fresh tokenId and suspends any
    /// still-active prior one). It is safe because this path never creates a
    /// second live token for the same (wallet, communityId) pair, so mint()'s
    /// "at most one active token per wallet per community" invariant holds
    /// trivially without needing the suspend step at all. A renewal is
    /// forward-only, matching renew()'s own "expiry never moves backward"
    /// semantics: a leaf committing an expiry that is not strictly later than
    /// the token's current stored expiry reverts (EXPIRY_NOT_LATER) rather
    /// than silently no-op'ing, so a stale root (e.g. a rollback, or a wallet
    /// that already has a longer expiry from another source) fails loudly
    /// instead of emitting a MembershipRenewed event that didn't actually
    /// renew anything. Renewing also never touches _suspended, exactly like
    /// renew() - a suspension can only be lifted by an explicit
    /// setSuspended(tokenId, false) call.
    /// @param communityId The community this claim is for.
    /// @param index This leaf's position in the source allowlist; the unit of
    /// replay protection (one claim per index per root).
    /// @param wallet The address the membership is minted/renewed to.
    /// @param expiresAt Absolute expiry timestamp committed to by the leaf.
    /// @param proof OZ MerkleProof sibling path from `leaf` to the community's
    /// current root.
    /// @return tokenId The minted or renewed token's id.
    function claimMembership(
        string calldata communityId,
        uint256 index,
        address wallet,
        uint256 expiresAt,
        bytes32[] calldata proof
    ) external returns (uint256 tokenId) {
        bytes32 root = merkleRoot[communityId];
        require(root != bytes32(0), "NO_ROOT_SET");
        require(wallet != address(0), "INVALID_WALLET");
        require(expiresAt > block.timestamp, "EXPIRY_IN_PAST");

        bytes32 bitmapKey = keccak256(abi.encode(communityId, root));
        require(!_claimedIndex[bitmapKey].get(index), "ALREADY_CLAIMED");

        bytes32 leaf =
            keccak256(bytes.concat(keccak256(abi.encode(index, wallet, communityId, expiresAt))));
        require(MerkleProof.verifyCalldata(proof, root, leaf), "INVALID_PROOF");

        uint256 existingTokenId = _activeTokenOf[wallet][communityId];
        if (existingTokenId == 0) {
            tokenId = _nextTokenId++;
            _ownerOf[tokenId] = wallet;
            _communityOf[tokenId] = communityId;
            _expiry[tokenId] = expiresAt;
            _activeTokenOf[wallet][communityId] = tokenId;

            _claimedIndex[bitmapKey].set(index);
            // ERC-721 compliance: mint Transfer event
            emit Transfer(address(0), wallet, tokenId);
            // ERC-5192 compliance: Locked event
            emit Locked(tokenId);
            // Balance tracking
            _balances[wallet]++;
            _ownedTokens[wallet].push(tokenId);
            emit MembershipMinted(wallet, tokenId, communityId, expiresAt);
        } else {
            require(expiresAt > _expiry[existingTokenId], "EXPIRY_NOT_LATER");
            tokenId = existingTokenId;
            _expiry[tokenId] = expiresAt;

            _claimedIndex[bitmapKey].set(index);
            emit MembershipRenewed(tokenId, expiresAt);
        }

        emit MembershipClaimed(wallet, tokenId, communityId, index, expiresAt);
    }

    /// @notice Whether `index` has already been claimed under `root` for
    /// `communityId`. Exposed so an admin/tooling can check claim status
    /// before or after publishing a root, without re-deriving the bitmap key.
    function isClaimed(string calldata communityId, bytes32 root, uint256 index)
        public
        view
        returns (bool)
    {
        return _claimedIndex[keccak256(abi.encode(communityId, root))].get(index);
    }

    // Convenience getters used by tests
    function isActive(uint256 tokenId) public view returns (bool) {
        address tokenOwner = _ownerOf[tokenId];
        if (tokenOwner == address(0)) return false;
        if (_suspended[tokenId]) return false;
        if (_expiry[tokenId] <= block.timestamp) return false;
        return true;
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address tokenOwner = _ownerOf[tokenId];
        require(tokenOwner != address(0), "NO_TOKEN");
        return tokenOwner;
    }

    function communityOf(uint256 tokenId) public view returns (string memory) {
        return _communityOf[tokenId];
    }

    function suspended(uint256 tokenId) public view returns (bool) {
        return _suspended[tokenId];
    }

    function expiry(uint256 tokenId) public view returns (uint256) {
        return _expiry[tokenId];
    }

    function activeTokenOf(address wallet, string memory communityId)
        public
        view
        returns (uint256)
    {
        return _activeTokenOf[wallet][communityId];
    }

    // --- ERC-721 / ERC-165 / ERC-5192 read-only interface ---

    /// @dev ERC-165: returns true for IERC165, IERC721, and IERC5192.
    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return
            interfaceId == 0x01ffc9a7 // IERC165
                || interfaceId == 0x80ac58cd // IERC721
                || interfaceId == 0x4bc2a65b; // IERC5192
    }

    /// @dev ERC-721: number of tokens owned by `account`.
    function balanceOf(address account) external view returns (uint256) {
        require(account != address(0), "ZERO_ADDRESS");
        return _balances[account];
    }

    /// @dev ERC-721 Metadata: returns the metadata URI for `tokenId`.
    ///      Reverts for nonexistent tokens (matches ownerOf's revert behavior).
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(_ownerOf[tokenId] != address(0), "NO_TOKEN");
        return string(abi.encodePacked(_baseTokenURI, _toString(tokenId)));
    }

    /// @dev ERC-5192: always returns true — transfers are never implemented.
    ///      Reverts for nonexistent tokens (matches ownerOf's revert behavior).
    function locked(uint256 tokenId) external view returns (bool) {
        require(_ownerOf[tokenId] != address(0), "NO_TOKEN");
        return true;
    }

    /// @dev Returns the base URI set in the constructor.
    function baseTokenURI() external view returns (string memory) {
        return _baseTokenURI;
    }

    // --- Internal helpers ---

    /// @dev Remove `tokenId` from `_ownedTokens[owner]` in O(1) via swap-and-pop.
    function _removeOwnedToken(address owner_, uint256 tokenId) internal {
        uint256[] storage tokens = _ownedTokens[owner_];
        uint256 len = tokens.length;
        for (uint256 i = 0; i < len; i++) {
            if (tokens[i] == tokenId) {
                tokens[i] = tokens[len - 1];
                tokens.pop();
                return;
            }
        }
    }

    /// @dev uint256 to decimal string (for tokenURI construction).
    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
