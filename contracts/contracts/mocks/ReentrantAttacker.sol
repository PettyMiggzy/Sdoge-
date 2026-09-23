// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ISDOGEStaking {
    function getReward() external;
    function stake(uint256 amount) external;
}

/// @notice Test-only: tries to re-enter getReward() from within the native
///         value transfer it triggers, to prove the guard holds. Exposes
///         approve/stake passthroughs so it can be the staker itself
///         (msg.sender inside SDOGEStaking) without needing account
///         impersonation in the test.
contract ReentrantAttacker {
    ISDOGEStaking public immutable staking;
    IERC20 public immutable stakingToken;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor(address _staking, address _stakingToken) {
        staking = ISDOGEStaking(_staking);
        stakingToken = IERC20(_stakingToken);
    }

    function approveAndStake(uint256 amount) external {
        stakingToken.approve(address(staking), amount);
        staking.stake(amount);
    }

    function claim() external {
        staking.getReward();
    }

    receive() external payable {
        if (!reentryAttempted) {
            reentryAttempted = true;
            try staking.getReward() {
                reentrySucceeded = true;
            } catch {
                reentrySucceeded = false;
            }
        }
    }
}
