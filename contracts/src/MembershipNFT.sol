// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract MembershipNFT {
    // Basic ownership tracking (minimal ERC-721-like)
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

    event MembershipMinted(
        address indexed to, uint256 indexed tokenId, string communityId, uint256 expiresAt
    );
    event MembershipRenewed(uint256 indexed tokenId, uint256 newExpiresAt);
    event MembershipSuspended(uint256 indexed tokenId, bool isSuspended);
    // Off-chain indexers trust these events completely (see SECURITY.md);
    // admin/ownership changes must be observable the same way membership
    // changes are, not silently mutate storage.
    event AdminUpdated(address indexed admin, bool enabled);
    event OwnershipTransferProposed(address indexed currentOwner, address indexed proposedOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(
        string memory,
        /*name*/
        string memory /*symbol*/
    ) {
        owner = msg.sender;
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
        }

        uint256 tokenId = _nextTokenId++;
        _ownerOf[tokenId] = to;
        _communityOf[tokenId] = communityId;
        _expiry[tokenId] = block.timestamp + duration;
        _suspended[tokenId] = false;

        _activeTokenOf[to][communityId] = tokenId;

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

        _suspended[tokenId] = suspended_;
        emit MembershipSuspended(tokenId, suspended_);
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
}
