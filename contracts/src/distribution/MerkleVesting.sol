// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title MerkleVesting
 * @notice Highly gas-optimized token distribution contract that compresses 10,000+ linear vesting
 * schedules into a single 32-byte Merkle root stored on-chain (O(1) storage deployment).
 *
 * @dev Leaf nodes encode `keccak256(bytes.concat(keccak256(abi.encode(account, totalAllocation, duration))))`
 * to protect against second preimage attacks. Linear vesting claims can be called incrementally over time.
 */
contract MerkleVesting is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The ERC20 token being distributed
    IERC20 public immutable token;

    /// @notice The 32-byte Merkle root compressing all vesting schedules
    bytes32 public immutable merkleRoot;

    /// @notice Start timestamp of the vesting schedule (in seconds)
    uint256 public immutable startTimestamp;

    /// @notice Amount of tokens already claimed per beneficiary address
    mapping(address => uint256) public claimed;

    /// @notice Emitted when a beneficiary claims vested tokens
    event Claimed(address indexed account, uint256 amount, uint256 totalClaimed);

    /// @notice Custom errors
    error InvalidProof();
    error NothingToClaim();
    error InvalidDuration();
    error ZeroAddress();

    /**
     * @notice Constructor initializing the Merkle vesting distribution.
     * @param _token The ERC-20 token address
     * @param _merkleRoot The 32-byte root hash of the Merkle tree
     * @param _startTimestamp Unix timestamp when linear vesting commences
     */
    constructor(address _token, bytes32 _merkleRoot, uint256 _startTimestamp) {
        if (_token == address(0)) revert ZeroAddress();
        token = IERC20(_token);
        merkleRoot = _merkleRoot;
        startTimestamp = _startTimestamp;
    }

    /**
     * @notice Calculates the total cumulative vested amount for a beneficiary at a given timestamp.
     * @dev Handles linear vesting progression and guards against division by zero and precision loss.
     *
     * @param totalAllocation Total allocated tokens for the beneficiary
     * @param duration Vesting duration in seconds
     * @param currentTime Current Unix timestamp
     * @return Cumulative vested tokens up to currentTime
     */
    function calculateVestedAmount(
        uint256 totalAllocation,
        uint256 duration,
        uint256 currentTime
    ) public view returns (uint256) {
        if (currentTime < startTimestamp) {
            return 0;
        }
        if (duration == 0) {
            revert InvalidDuration();
        }
        uint256 elapsedTime = currentTime - startTimestamp;
        if (elapsedTime >= duration) {
            return totalAllocation;
        }
        // Multiply totalAllocation by elapsedTime prior to dividing by duration to preserve accuracy over time
        return (totalAllocation * elapsedTime) / duration;
    }

    /**
     * @notice Returns the current claimable token amount for a beneficiary.
     * @param account Beneficiary address
     * @param totalAllocation Total allocated tokens
     * @param duration Vesting duration in seconds
     * @return Claimable token amount right now
     */
    function getClaimableAmount(
        address account,
        uint256 totalAllocation,
        uint256 duration
    ) external view returns (uint256) {
        uint256 totalVested = calculateVestedAmount(totalAllocation, duration, block.timestamp);
        uint256 alreadyClaimed = claimed[account];
        if (totalVested <= alreadyClaimed) {
            return 0;
        }
        return totalVested - alreadyClaimed;
    }

    /**
     * @notice Claims any unlocked, vested tokens for a beneficiary by providing a valid Merkle proof.
     *
     * @param account Beneficiary address receiving the tokens
     * @param totalAllocation Total allocated tokens in the schedule
     * @param duration Total vesting duration in seconds
     * @param merkleProof Array of 32-byte Merkle proof hashes
     * @return claimable Amount of tokens claimed and transferred in this transaction
     */
    function claim(
        address account,
        uint256 totalAllocation,
        uint256 duration,
        bytes32[] calldata merkleProof
    ) external nonReentrant returns (uint256 claimable) {
        // Double-hash leaf node encoding matching OpenZeppelin MerkleProof standard
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, totalAllocation, duration))));

        if (!MerkleProof.verify(merkleProof, merkleRoot, leaf)) {
            revert InvalidProof();
        }

        uint256 totalVested = calculateVestedAmount(totalAllocation, duration, block.timestamp);
        uint256 alreadyClaimed = claimed[account];

        if (totalVested <= alreadyClaimed) {
            revert NothingToClaim();
        }

        claimable = totalVested - alreadyClaimed;
        claimed[account] = totalVested;

        token.safeTransfer(account, claimable);
        emit Claimed(account, claimable, totalVested);
    }
}
