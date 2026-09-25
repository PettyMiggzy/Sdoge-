// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ISDOGEStaking {
    function claimReward(uint256 stakeId) external returns (uint256, uint256);
    function stake(uint8 tier, uint256 amount, uint256 expectedDuration, uint256 expectedMultiplierBps)
        external
        returns (uint256);
    function tierDuration(uint256) external view returns (uint256);
    function tierMultiplierBps(uint256) external view returns (uint256);
}

/// @notice Test-only: tries to re-enter claimReward() from within the native value transfer it
///         triggers, to prove the guard holds. It is the staker itself (msg.sender inside
///         SDOGEStaking), so no account impersonation is needed.
contract ReentrantAttacker {
    ISDOGEStaking public immutable staking;
    IERC20 public immutable stakingToken;
    uint256 public stakeId;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor(address _staking, address _stakingToken) {
        staking = ISDOGEStaking(_staking);
        stakingToken = IERC20(_stakingToken);
    }

    function approveAndStake(uint8 tier, uint256 amount) external {
        stakingToken.approve(address(staking), amount);
        stakeId = staking.stake(tier, amount, staking.tierDuration(tier), staking.tierMultiplierBps(tier));
    }

    function claim() external {
        staking.claimReward(stakeId);
    }

    receive() external payable {
        if (!reentryAttempted) {
            reentryAttempted = true;
            try staking.claimReward(stakeId) {
                reentrySucceeded = true;
            } catch {
                reentrySucceeded = false;
            }
        }
    }
}
