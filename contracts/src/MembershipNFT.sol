// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";

/**
 * @title MembershipNFT
 * @notice Simple ERC721 representing community membership with expiry and suspension
 * @dev Each token has an expiry timestamp and can be suspended by admins
 *      Tokens are scoped to a community via communityId for multi-community support
 *
 * Features:
 * - Admins (approved by owner) can mint and renew memberships
 * - Suspension toggles active status without burning the token
 * - Each wallet can have one active token per community
 * - Events emitted for indexing: MembershipMinted, MembershipRenewed, MembershipSuspended
 */
contract MembershipNFT is ERC721, Ownable {
    /// @notice Counter for token IDs, starts at 1
    uint256 public nextTokenId = 1;

    /// @notice Expiry timestamp for each token
    mapping(uint256 => uint256) public expiry;

    /// @notice Suspension status for each token
    mapping(uint256 => bool) public suspended;

    /// @notice Community ID associated with each token
    mapping(uint256 => string) public communityOf;

    /// @notice Approved admins who can mint and manage memberships
    mapping(address => bool) public admins;

    /// @notice Active token for a wallet in a specific community (wallet => community => tokenId)
    mapping(address => mapping(string => uint256)) public activeTokenOf;

    /// @notice Emitted when an admin is added or removed
    event AdminUpdated(address indexed admin, bool approved);

    /// @notice Emitted when a membership is minted
    /// @param to The recipient wallet address
    /// @param tokenId The newly minted token ID
    /// @param communityId The community this membership belongs to
    /// @param expiresAt Unix timestamp when the membership expires
    event MembershipMinted(address indexed to, uint256 indexed tokenId, string communityId, uint256 expiresAt);

    /// @notice Emitted when a membership is renewed
    /// @param tokenId The token ID being renewed
    /// @param newExpiresAt The new expiry timestamp
    event MembershipRenewed(uint256 indexed tokenId, uint256 newExpiresAt);

    /// @notice Emitted when a membership suspension status changes
    /// @param tokenId The token ID being suspended/unsuspended
    /// @param isSuspended True if suspended, false if unsuspended
    event MembershipSuspended(uint256 indexed tokenId, bool isSuspended);

    /// @notice Restricts function access to admins or owner
    modifier onlyAdmin() {
        require(admins[msg.sender] || msg.sender == owner(), "NOT_ADMIN");
        _;
    }

    /// @notice Creates a new MembershipNFT contract
    /// @param name_ The ERC721 token name
    /// @param symbol_ The ERC721 token symbol
    constructor(string memory name_, string memory symbol_) ERC721(name_, symbol_) Ownable(msg.sender) {}

    /// @notice Sets or removes an admin
    /// @param admin The address to update
    /// @param approved True to grant admin rights, false to revoke
    function setAdmin(address admin, bool approved) external onlyOwner {
        admins[admin] = approved;
        emit AdminUpdated(admin, approved);
    }

    /// @notice Mints a new membership token
    /// @param to The recipient wallet address
    /// @param communityId The community this membership is for
    /// @param validForSeconds Duration in seconds until expiry
    /// @return tokenId The newly minted token ID
    function mint(address to, string calldata communityId, uint256 validForSeconds) external onlyAdmin returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        _safeMint(to, tokenId);
        uint256 expiresAt = block.timestamp + validForSeconds;
        expiry[tokenId] = expiresAt;
        suspended[tokenId] = false;
        communityOf[tokenId] = communityId;
        // Overwrite any previous active token pointer for this wallet+community
        activeTokenOf[to][communityId] = tokenId;
        emit MembershipMinted(to, tokenId, communityId, expiresAt);
    }

    /// @notice Extends the expiry of an existing token
    /// @param tokenId The token to renew
    /// @param extendBySeconds Number of seconds to extend by
    function renew(uint256 tokenId, uint256 extendBySeconds) external onlyAdmin {
        require(_ownerOf(tokenId) != address(0), "NO_TOKEN");
        uint256 current = expiry[tokenId];
        // If expired, renew from now; otherwise extend from current expiry
        uint256 base = current > block.timestamp ? current : block.timestamp;
        uint256 newExpiry = base + extendBySeconds;
        expiry[tokenId] = newExpiry;
        emit MembershipRenewed(tokenId, newExpiry);
    }

    /// @notice Suspends or unsuspends a membership
    /// @param tokenId The token to update
    /// @param value True to suspend, false to unsuspend
    function setSuspended(uint256 tokenId, bool value) external onlyAdmin {
        require(_ownerOf(tokenId) != address(0), "NO_TOKEN");
        suspended[tokenId] = value;
        emit MembershipSuspended(tokenId, value);
    }

    /// @notice Checks if a token is currently active
    /// @param tokenId The token to check
    /// @return True if the token exists, is not suspended, and hasn't expired
    function isActive(uint256 tokenId) public view returns (bool) {
        if (_ownerOf(tokenId) == address(0)) return false;
        if (suspended[tokenId]) return false;
        return expiry[tokenId] > block.timestamp;
    }
}
