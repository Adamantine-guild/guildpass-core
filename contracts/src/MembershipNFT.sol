// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract MembershipNFT {
    // Basic ownership tracking (minimal ERC-721-like)
    uint256 private _nextTokenId = 1;
    address public owner;

    mapping(address => bool) public admins;

    mapping(uint256 => address) private _ownerOf;
    mapping(uint256 => string) private _communityOf;
    mapping(uint256 => uint256) private _expiry;
    mapping(uint256 => bool) private _suspended;

    // wallet => communityId => active tokenId
    mapping(address => mapping(string => uint256)) private _activeTokenOf;

    event MembershipMinted(address indexed to, uint256 indexed tokenId, string communityId, uint256 expiresAt);
    event MembershipRenewed(uint256 indexed tokenId, uint256 newExpiresAt);
    event MembershipSuspended(uint256 indexed tokenId, bool isSuspended);

    constructor(string memory /*name*/, string memory /*symbol*/) {
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
        admins[who] = enabled;
    }

    function mint(address to, string memory communityId, uint256 duration) public onlyAdmin returns (uint256) {
        require(to != address(0), "INVALID_TO");
        require(duration > 0, "INVALID_DURATION");

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
        uint256 newExpiry = current < block.timestamp ? block.timestamp + duration : current + duration;
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

    function activeTokenOf(address wallet, string memory communityId) public view returns (uint256) {
        return _activeTokenOf[wallet][communityId];
    }
}