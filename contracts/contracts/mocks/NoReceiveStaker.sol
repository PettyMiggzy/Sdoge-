// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IStakingForNoReceive {
    function stake(uint8 tier, uint256 amount, uint256 expectedDuration, uint256 expectedMultiplierBps)
        external
        returns (uint256);
    function exitStake(uint256 stakeId, bool allowEarly) external returns (uint256, uint256);
    function claimReward(uint256 stakeId) external returns (uint256);
    function claimDeferredRewards(address payable to) external returns (uint256);
    function tierDuration(uint256) external view returns (uint256);
    function tierMultiplierBps(uint256) external view returns (uint256);
}

/// @notice Test-only staker with no receive()/fallback: native USDC sent to it reverts, like a
///         contract wallet without a payable receive, or a Circle-blocklisted address on Arc.
contract NoReceiveStaker {
    IStakingForNoReceive public immutable staking;
    IERC20 public immutable token;
    uint256 public stakeId;

    constructor(address staking_, address token_) {
        staking = IStakingForNoReceive(staking_);
        token = IERC20(token_);
    }

    function approveAndStake(uint8 tier, uint256 amount) external {
        token.approve(address(staking), amount);
        stakeId = staking.stake(tier, amount, staking.tierDuration(tier), staking.tierMultiplierBps(tier));
    }

    function exit() external {
        staking.exitStake(stakeId, false);
    }

    function claim() external {
        staking.claimReward(stakeId);
    }

    function claimDeferred(address payable to) external {
        staking.claimDeferredRewards(to);
    }
}
