// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SDOGEStaking
/// @notice Stake $SDOGE, earn a direct share of the 1% trade tax (paid out
///         as native USDC) - not yield the treasury earns elsewhere. The
///         same tax that funds the Treasury and Buyback also funds this.
///
/// Arc's native currency IS USDC (like ETH on mainnet) - NOT an ERC-20 - so
/// rewards are handled as native value (payable / call{value:}), while the
/// staked SDOGE is a normal ERC-20. This is the standard Synthetix
/// StakingRewards accrual model (per-second rewardRate, a
/// rewardPerToken accumulator so reward math is O(1) regardless of staker
/// count), adapted for a native-currency reward instead of an ERC-20 one.
///
/// This contract never sources revenue itself - it only distributes
/// whatever native USDC is sent via notifyRewardAmount(). That's called
/// either by the owner directly, or by a separate `notifier` address the
/// owner designates - deliberately split so the owner key can stay a cold
/// multisig while `notifier` is a hot key an automated keeper holds,
/// scoped to just this one action.
///
/// One source of that USDC is fully self-funded and needs no treasury
/// money or outside yield at all: an early-withdrawal penalty. Withdraw
/// within `earlyWithdrawWindow` of your last stake and `earlyWithdrawPenaltyBps`
/// of what you're withdrawing stays behind in the staking token instead of
/// going to you, tracked separately in `pendingPenalties`. Sweeping that out
/// (via `sweepPenalties`) and converting it to USDC for notifyRewardAmount()
/// is the same "accumulate, then feed the reward stream" shape already used
/// for tax revenue - impatient stakers fund patient ones, at zero cost to
/// the project.
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

    /// @notice Address allowed to call notifyRewardAmount() in addition to
    ///         the owner. address(0) (the default) means only the owner can.
    address public notifier;

    /// @notice Penalty on withdrawals made within earlyWithdrawWindow of the
    ///         staker's last stake() call, in basis points of the amount
    ///         withdrawn. Capped at 30% (see setEarlyWithdrawSettings) so
    ///         even a compromised owner can't turn this punitive.
    uint256 public earlyWithdrawPenaltyBps = 1500; // 15%
    uint256 public earlyWithdrawWindow = 7 days;
    uint256 public constant MAX_EARLY_WITHDRAW_PENALTY_BPS = 3000;

    /// @dev Resets on every stake() - a top-up restarts the window for the
    ///      staker's whole balance rather than tracking per-deposit lots.
    ///      Simpler and cheaper; documented here because it's a real
    ///      behavioral tradeoff, not hidden as an oversight.
    mapping(address => uint256) public lastStakeTime;

    /// @notice Forfeited early-withdrawal penalties, held in the staking
    ///         token, not yet swept out. Always <= this contract's
    ///         stakingToken balance minus _totalSupply - i.e. it can never
    ///         be stakers' principal, only what's already been forfeited.
    uint256 public pendingPenalties;

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 amount);
    event RewardAdded(uint256 amount, uint256 newRewardRate, uint256 periodFinish);
    event RewardsDurationUpdated(uint256 newDuration);
    event ERC20Recovered(address indexed token, uint256 amount);
    event NotifierUpdated(address indexed previousNotifier, address indexed newNotifier);
    event EarlyWithdrawPenalty(address indexed user, uint256 penaltyAmount);
    event EarlyWithdrawSettingsUpdated(uint256 penaltyBps, uint256 window);
    event PenaltiesSwept(address indexed to, uint256 amount);

    modifier onlyOwnerOrNotifier() {
        require(msg.sender == owner() || msg.sender == notifier, "not owner or notifier");
        _;
    }

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
        lastStakeTime[msg.sender] = block.timestamp;
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    /// @dev The full `amount` leaves the staker's tracked balance either
    ///      way - only the transfer to them is reduced when a penalty
    ///      applies, with the difference kept in pendingPenalties instead
    ///      of paid out.
    function withdraw(uint256 amount) public nonReentrant updateReward(msg.sender) {
        require(amount > 0, "cannot withdraw 0");
        require(_balances[msg.sender] >= amount, "withdraw amount exceeds balance");
        _totalSupply -= amount;
        _balances[msg.sender] -= amount;

        uint256 payout = amount;
        if (block.timestamp < lastStakeTime[msg.sender] + earlyWithdrawWindow) {
            uint256 penalty = (amount * earlyWithdrawPenaltyBps) / 10000;
            if (penalty > 0) {
                payout -= penalty;
                pendingPenalties += penalty;
                emit EarlyWithdrawPenalty(msg.sender, penalty);
            }
        }

        stakingToken.safeTransfer(msg.sender, payout);
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

    /// @notice Grants (or revokes, with address(0)) permission to call
    ///         notifyRewardAmount() without being the owner. Intended for a
    ///         hot wallet an automated keeper holds - never grant this to
    ///         anything that also needs the owner's other privileges.
    function setNotifier(address _notifier) external onlyOwner {
        emit NotifierUpdated(notifier, _notifier);
        notifier = _notifier;
    }

    /// @notice Fund the next rewardsDuration with msg.value of native USDC.
    ///         If a period is still running, its unpaid remainder rolls
    ///         into the new rate rather than being lost. Callable by the
    ///         owner or the designated notifier (see setNotifier).
    function notifyRewardAmount() external payable onlyOwnerOrNotifier updateReward(address(0)) {
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

    /// @notice Tune the early-withdrawal penalty. Capped well below 100% so
    ///         it can only ever be a deterrent, never a trap that confiscates
    ///         a staker's principal.
    function setEarlyWithdrawSettings(uint256 _penaltyBps, uint256 _window) external onlyOwner {
        require(_penaltyBps <= MAX_EARLY_WITHDRAW_PENALTY_BPS, "penalty too high");
        earlyWithdrawPenaltyBps = _penaltyBps;
        earlyWithdrawWindow = _window;
        emit EarlyWithdrawSettingsUpdated(_penaltyBps, _window);
    }

    /// @notice Moves accumulated early-withdrawal penalties (in the staking
    ///         token) to `to` for conversion into stakers' USDC rewards -
    ///         e.g. swapped for USDC and passed to notifyRewardAmount(),
    ///         the same way tax revenue already is. Bounded by
    ///         pendingPenalties, so it can never reach into stakers'
    ///         principal. Owner-or-notifier: routine and repeatable, same
    ///         as notifyRewardAmount() itself.
    function sweepPenalties(address to) external onlyOwnerOrNotifier {
        require(to != address(0), "cannot sweep to zero address");
        uint256 amount = pendingPenalties;
        require(amount > 0, "no penalties to sweep");
        pendingPenalties = 0;
        stakingToken.safeTransfer(to, amount);
        emit PenaltiesSwept(to, amount);
    }
}
