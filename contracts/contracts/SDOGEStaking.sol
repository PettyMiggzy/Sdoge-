// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SDOGEStaking
/// @notice Stake $SDOGE, earn a share of yield the treasury earns elsewhere
///         (e.g. depositing the buy-tax's USDC into Aave/Morpho on Arc).
///
/// Arc's native currency IS USDC (like ETH on mainnet) - NOT an ERC-20 - so
/// rewards are handled as native value (payable / call{value:}), while the
/// staked SDOGE is a normal ERC-20. This is the standard Synthetix
/// StakingRewards accrual model (per-second rewardRate, a
/// rewardPerToken accumulator so reward math is O(1) regardless of staker
/// count), adapted for a native-currency reward instead of an ERC-20 one.
///
/// This contract never sources yield itself - it only distributes whatever
/// native USDC the owner sends via notifyRewardAmount(). Funding it (e.g.
/// from Aave/Morpho interest) is a separate, off-chain-triggered step.
contract SDOGEStaking is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable stakingToken;

    uint256 public rewardsDuration = 7 days;
    uint256 public periodFinish;
    uint256 public rewardRate;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;

    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 amount);
    event RewardAdded(uint256 amount, uint256 newRewardRate, uint256 periodFinish);
    event RewardsDurationUpdated(uint256 newDuration);
    event ERC20Recovered(address indexed token, uint256 amount);

    constructor(address _stakingToken, address _owner) Ownable(_owner) {
        require(_stakingToken != address(0), "staking token is zero address");
        stakingToken = IERC20(_stakingToken);
    }

    // ---------- Views ----------

    function totalSupply() external view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (_totalSupply == 0) return rewardPerTokenStored;
        uint256 elapsed = lastTimeRewardApplicable() - lastUpdateTime;
        return rewardPerTokenStored + (elapsed * rewardRate * 1e18) / _totalSupply;
    }

    function earned(address account) public view returns (uint256) {
        uint256 perTokenDelta = rewardPerToken() - userRewardPerTokenPaid[account];
        return (_balances[account] * perTokenDelta) / 1e18 + rewards[account];
    }

    /// @notice Reward projected over a full rewardsDuration at the current
    ///         rate - a display convenience only, not used in accounting.
    function getRewardForDuration() external view returns (uint256) {
        return rewardRate * rewardsDuration;
    }

    // ---------- Mutating ----------

    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    function stake(uint256 amount) external nonReentrant updateReward(msg.sender) {
        require(amount > 0, "cannot stake 0");
        _totalSupply += amount;
        _balances[msg.sender] += amount;
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function withdraw(uint256 amount) public nonReentrant updateReward(msg.sender) {
        require(amount > 0, "cannot withdraw 0");
        require(_balances[msg.sender] >= amount, "withdraw amount exceeds balance");
        _totalSupply -= amount;
        _balances[msg.sender] -= amount;
        stakingToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @dev Zeroes the reward before the external call (checks-effects-
    ///      interactions) - nonReentrant is defense in depth on top of that,
    ///      not the only thing preventing reentrancy here.
    function getReward() public nonReentrant updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward == 0) return;
        rewards[msg.sender] = 0;
        emit RewardPaid(msg.sender, reward);
        (bool sent, ) = msg.sender.call{value: reward}("");
        require(sent, "reward transfer failed");
    }

    function exit() external {
        withdraw(_balances[msg.sender]);
        getReward();
    }

    // ---------- Admin: funding & config ----------

    /// @notice Fund the next rewardsDuration with msg.value of native USDC.
    ///         If a period is still running, its unpaid remainder rolls
    ///         into the new rate rather than being lost.
    function notifyRewardAmount() external payable onlyOwner updateReward(address(0)) {
        if (block.timestamp >= periodFinish) {
            rewardRate = msg.value / rewardsDuration;
        } else {
            uint256 remaining = periodFinish - block.timestamp;
            uint256 leftover = remaining * rewardRate;
            rewardRate = (msg.value + leftover) / rewardsDuration;
        }

        // Never promise more per second than this contract actually holds
        // (all currently-held native balance, since reward is the only use
        // of native value here) - guards against a rate that can't be paid.
        require(rewardRate > 0, "reward rate is 0 (amount too small for duration)");
        require(rewardRate * rewardsDuration <= address(this).balance, "reward too high for balance");

        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + rewardsDuration;
        emit RewardAdded(msg.value, rewardRate, periodFinish);
    }

    /// @notice Only changeable between reward periods, so it can't be used
    ///         to disrupt an active, already-promised payout schedule.
    function setRewardsDuration(uint256 _rewardsDuration) external onlyOwner {
        require(block.timestamp > periodFinish, "previous period still active");
        require(_rewardsDuration > 0, "duration must be > 0");
        rewardsDuration = _rewardsDuration;
        emit RewardsDurationUpdated(_rewardsDuration);
    }

    /// @notice Rescue unrelated tokens accidentally sent here. Can never
    ///         touch the staking token itself - that's stakers' principal,
    ///         not the owner's to move.
    function recoverERC20(address tokenAddress, uint256 amount) external onlyOwner {
        require(tokenAddress != address(stakingToken), "cannot withdraw the staking token");
        IERC20(tokenAddress).safeTransfer(owner(), amount);
        emit ERC20Recovered(tokenAddress, amount);
    }
}
