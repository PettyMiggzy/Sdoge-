// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SDOGEStaking
/// @notice Stake $SDOGE into one of 5 fixed lock tiers (7/30/90/180/365
///         days), earn native USDC. Longer locks earn faster (a per-tier
///         multiplier on the reward rate), not just longer.
///
/// Withdraw before your stake's tier matures and you forfeit ALL of that
/// stake's currently-accrued, unclaimed reward AND pay earlyWithdrawPenaltyBps
/// (default 15%) of the principal you're withdrawing. Both the forfeited
/// reward (native USDC) and the forfeited principal (SDOGE) stay in this
/// contract to fund everyone else's rewards - impatient stakers fund
/// patient ones, at zero cost to the project or Treasury. This is a real
/// design choice, not a minor detail: combined with reward forfeiture, it
/// is a harsher exit penalty than most staking contracts use. Deliberate,
/// per explicit instruction - not something to soften without asking.
///
/// Arc's native currency IS USDC (like ETH on mainnet) - NOT an ERC-20 - so
/// rewards are handled as native value (payable / call{value:}), while the
/// staked SDOGE is a normal ERC-20.
///
/// Reward accounting uses ONE global accumulator over "weighted shares"
/// (amount * tier multiplier) rather than raw staked amount - the standard
/// Synthetix StakingRewards shape (per-second rewardRate, a
/// rewardPerWeightedShare accumulator, O(1) per action regardless of
/// staker count), extended so a higher-tier token counts for more without
/// needing a separate pool per tier.
///
/// A user can hold multiple simultaneous stakes (even in the same tier,
/// e.g. adding to a position later without disturbing an earlier one) -
/// each is tracked as its own numbered position with its own unlock time
/// and reward checkpoint, not merged into a single per-user balance.
///
/// NFT staking (holding an NFT to boost a stake's reward, per the original
/// plan) is NOT implemented here - the collection doesn't exist yet and
/// bolting on that logic against an undesigned collection would mean
/// guessing. The intent, recorded for whoever builds it later: a staked
/// NFT would return to the wallet that staked it (not subject to the
/// multi-wallet withdrawal split below, since it isn't fungible) and would
/// add a second, separate reward stream or multiplier - not replace this
/// one.
contract SDOGEStaking is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable stakingToken;

    // ---------- Tiers ----------

    uint8 public constant NUM_TIERS = 5;
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant PRECISION = 1e18;
    uint256 public constant MAX_WITHDRAW_RECIPIENTS = 4;
    uint256 public constant MAX_EARLY_WITHDRAW_PENALTY_BPS = 3000; // 30% cap
    uint256 public constant MAX_TIER_MULTIPLIER_BPS = 100000; // 10x cap

    /// @notice Lock duration per tier index, in seconds. Index = tier id
    ///         used everywhere below (0 = 7 days, ... 4 = 365 days).
    ///         Owner-tunable going forward; changing this never affects the
    ///         unlockTime already stored on an existing stake.
    uint256[NUM_TIERS] public tierDuration = [uint256(7 days), 30 days, 90 days, 180 days, 365 days];

    /// @notice Reward-rate multiplier per tier, in basis points (10000 =
    ///         1.0x). Proposed defaults: 1.0x / 1.2x / 1.5x / 2.0x / 3.0x -
    ///         longer locks earn meaningfully faster per token, not just
    ///         longer. Tunable via setTierMultiplier, capped at 10x so a
    ///         mistake (or a compromised owner) can't wildly misprice the
    ///         pool against itself.
    uint256[NUM_TIERS] public tierMultiplierBps = [uint256(10000), 12000, 15000, 20000, 30000];

    // ---------- Early withdrawal penalty ----------

    uint256 public earlyWithdrawPenaltyBps = 1500; // 15%, applies to principal only

    /// @notice Reaching this fraction of a stake's committed lock counts as
    ///         fully unlocked - no principal penalty, no reward forfeiture -
    ///         even though block.timestamp hasn't reached unlockTime yet.
    ///         Default 80%: a 30-day stake is penalty-free after 24 days.
    ///         Rewards the commitment itself without demanding the staker
    ///         sit out the last, least-informative slice of it.
    uint256 public earlyUnlockThresholdBps = 8000; // 80%

    // ---------- Per-stake accounting ----------

    struct StakeInfo {
        address owner;
        uint8 tier;
        uint256 amount; // principal still locked in this stake
        uint256 weighted; // amount * tierMultiplierBps[tier] / BPS_DENOMINATOR
        uint256 startTime;
        uint256 unlockTime;
        uint256 rewardPerWeightedSharePaid;
        uint256 accruedReward; // settled, unpaid native USDC owed on this stake
        bool closed;
    }

    uint256 public nextStakeId = 1;
    mapping(uint256 => StakeInfo) public stakes;
    mapping(address => uint256[]) public stakeIdsByUser;

    uint256 public totalPrincipalStaked;
    uint256 public totalWeightedSupply;

    // ---------- Global reward accrual (native USDC, over weighted shares) ----------

    uint256 public rewardsDuration = 7 days;
    uint256 public periodFinish;
    uint256 public rewardRate;
    uint256 public lastUpdateTime;
    uint256 public rewardPerWeightedShareStored;

    /// @notice Native USDC not yet folded into the active reward rate:
    ///         forfeited-early-withdrawal rewards plus permissionless
    ///         contributeUSDC() calls. Auto-included the next time
    ///         notifyRewardAmount() runs.
    uint256 public unallocatedUsdc;

    /// @notice SDOGE not yet swept out: forfeited-early-withdrawal
    ///         principal penalties plus permissionless contributeTokens()
    ///         calls. Always <= this contract's stakingToken balance minus
    ///         totalPrincipalStaked - i.e. it can never be stakers'
    ///         principal, only what's already been forfeited or donated.
    uint256 public unallocatedTokens;

    /// @notice Address allowed to call notifyRewardAmount() / sweepTokens()
    ///         in addition to the owner. address(0) (the default) means
    ///         only the owner can.
    address public notifier;

    // ---------- Events ----------

    event Staked(
        address indexed user,
        uint256 indexed stakeId,
        uint8 tier,
        uint256 amount,
        uint256 weighted,
        uint256 unlockTime
    );
    event Withdrawn(address indexed user, uint256 indexed stakeId, uint256 amount, uint256 payout, bool early);
    event RewardPaid(address indexed user, uint256 indexed stakeId, uint256 amount);
    event RewardForfeited(address indexed user, uint256 indexed stakeId, uint256 amount);
    event EarlyWithdrawPenalty(address indexed user, uint256 indexed stakeId, uint256 penaltyAmount);
    event RewardAdded(uint256 amount, uint256 newRewardRate, uint256 periodFinish);
    event RewardsDurationUpdated(uint256 newDuration);
    event EarlyWithdrawPenaltyBpsUpdated(uint256 penaltyBps);
    event EarlyUnlockThresholdUpdated(uint256 thresholdBps);
    event TierMultiplierUpdated(uint8 indexed tier, uint256 multiplierBps);
    event TierDurationUpdated(uint8 indexed tier, uint256 duration);
    event NotifierUpdated(address indexed previousNotifier, address indexed newNotifier);
    event ERC20Recovered(address indexed token, uint256 amount);
    event TokensSwept(address indexed to, uint256 amount);
    event UsdcContributed(address indexed from, uint256 amount);
    event TokensContributed(address indexed from, uint256 amount);

    modifier onlyOwnerOrNotifier() {
        require(msg.sender == owner() || msg.sender == notifier, "not owner or notifier");
        _;
    }

    constructor(address _stakingToken, address _owner) Ownable(_owner) {
        require(_stakingToken != address(0), "staking token is zero address");
        stakingToken = IERC20(_stakingToken);
    }

    // ---------- Views ----------

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerWeightedShare() public view returns (uint256) {
        if (totalWeightedSupply == 0) return rewardPerWeightedShareStored;
        uint256 elapsed = lastTimeRewardApplicable() - lastUpdateTime;
        return rewardPerWeightedShareStored + (elapsed * rewardRate * PRECISION) / totalWeightedSupply;
    }

    /// @notice Read-only preview of what withdrawing/claiming this stake
    ///         right now would pay out, before any early-withdrawal
    ///         forfeiture is applied.
    function pendingReward(uint256 stakeId) public view returns (uint256) {
        StakeInfo storage s = stakes[stakeId];
        uint256 delta = rewardPerWeightedShare() - s.rewardPerWeightedSharePaid;
        return s.accruedReward + (s.weighted * delta) / PRECISION;
    }

    function getStakeIds(address user) external view returns (uint256[] memory) {
        return stakeIdsByUser[user];
    }

    /// @notice Reward projected over a full rewardsDuration at the current
    ///         rate - a display convenience only, not used in accounting.
    function getRewardForDuration() external view returns (uint256) {
        return rewardRate * rewardsDuration;
    }

    // ---------- Internal reward accounting ----------

    function _updateGlobalReward() internal {
        rewardPerWeightedShareStored = rewardPerWeightedShare();
        lastUpdateTime = lastTimeRewardApplicable();
    }

    function _settleStake(uint256 stakeId) internal {
        _updateGlobalReward();
        StakeInfo storage s = stakes[stakeId];
        uint256 delta = rewardPerWeightedShareStored - s.rewardPerWeightedSharePaid;
        s.accruedReward += (s.weighted * delta) / PRECISION;
        s.rewardPerWeightedSharePaid = rewardPerWeightedShareStored;
    }

    // ---------- Mutating: staking ----------

    function stake(uint8 tier, uint256 amount) external nonReentrant returns (uint256 stakeId) {
        require(amount > 0, "cannot stake 0");
        require(tier < NUM_TIERS, "invalid tier");
        _updateGlobalReward();

        uint256 weighted = (amount * tierMultiplierBps[tier]) / BPS_DENOMINATOR;
        uint256 unlockTime = block.timestamp + tierDuration[tier];

        stakeId = nextStakeId++;
        stakes[stakeId] = StakeInfo({
            owner: msg.sender,
            tier: tier,
            amount: amount,
            weighted: weighted,
            startTime: block.timestamp,
            unlockTime: unlockTime,
            rewardPerWeightedSharePaid: rewardPerWeightedShareStored,
            accruedReward: 0,
            closed: false
        });
        stakeIdsByUser[msg.sender].push(stakeId);

        totalPrincipalStaked += amount;
        totalWeightedSupply += weighted;

        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, stakeId, tier, amount, weighted, unlockTime);
    }

    /// @notice The timestamp at which `stakeId` counts as unlocked for
    ///         penalty purposes - earlyUnlockThresholdBps of the way
    ///         through its committed lock, not the full 100%.
    function effectiveUnlockTime(uint256 stakeId) public view returns (uint256) {
        StakeInfo storage s = stakes[stakeId];
        uint256 lockLength = s.unlockTime - s.startTime;
        return s.startTime + (lockLength * earlyUnlockThresholdBps) / BPS_DENOMINATOR;
    }

    /// @dev Shared accounting for both withdraw() and exitStake(): settles
    ///      the stake's reward, applies the early-withdrawal penalty and
    ///      reward forfeiture if applicable, updates all balances, and
    ///      pays the native-USDC reward (if any) to msg.sender. Does NOT
    ///      move the SDOGE principal payout - callers handle that
    ///      differently (split vs. single recipient).
    function _processWithdraw(
        uint256 stakeId,
        uint256 amount
    ) internal returns (uint256 payout, uint256 rewardPaid, bool early) {
        StakeInfo storage s = stakes[stakeId];
        require(s.owner == msg.sender, "not your stake");
        require(!s.closed, "stake already closed");
        require(amount > 0 && amount <= s.amount, "invalid amount");

        _settleStake(stakeId);

        early = block.timestamp < effectiveUnlockTime(stakeId);
        uint256 removedWeighted = (amount * tierMultiplierBps[s.tier]) / BPS_DENOMINATOR;

        s.amount -= amount;
        s.weighted -= removedWeighted;
        totalPrincipalStaked -= amount;
        totalWeightedSupply -= removedWeighted;

        if (early) {
            uint256 penalty = (amount * earlyWithdrawPenaltyBps) / BPS_DENOMINATOR;
            payout = amount - penalty;
            unallocatedTokens += penalty;
            emit EarlyWithdrawPenalty(msg.sender, stakeId, penalty);

            if (s.accruedReward > 0) {
                unallocatedUsdc += s.accruedReward;
                emit RewardForfeited(msg.sender, stakeId, s.accruedReward);
                s.accruedReward = 0;
            }
        } else {
            payout = amount;
            rewardPaid = s.accruedReward;
            s.accruedReward = 0;
        }

        if (s.amount == 0) {
            s.closed = true;
        }

        if (rewardPaid > 0) {
            emit RewardPaid(msg.sender, stakeId, rewardPaid);
            (bool sent, ) = msg.sender.call{value: rewardPaid}("");
            require(sent, "reward transfer failed");
        }

        emit Withdrawn(msg.sender, stakeId, amount, payout, early);
    }

    /// @notice Withdraw `amount` of principal from `stakeId`, paid out
    ///         split across 1-4 recipient wallets (`recipients`/`splitAmounts`
    ///         must be the same length and sum exactly to what's actually
    ///         paid out after any penalty). Any accrued reward for this
    ///         stake is settled here too: paid to msg.sender if the stake
    ///         has matured, forfeited entirely if it hasn't (see the
    ///         contract-level note on why that's deliberate). A partial
    ///         withdrawal from a still-locked stake forfeits that stake's
    ///         reward in full, not a pro-rated slice - touching a locked
    ///         stake at all is what forfeits it, so partial withdrawals
    ///         can't be used to dodge the deterrent. Requires knowing the
    ///         exact post-penalty payout in advance to fill `splitAmounts` -
    ///         use exitStake() instead for a single-wallet full exit that
    ///         computes it for you.
    function withdraw(
        uint256 stakeId,
        uint256 amount,
        address[] calldata recipients,
        uint256[] calldata splitAmounts
    ) external nonReentrant returns (uint256 payout, uint256 rewardPaid) {
        require(
            recipients.length > 0 && recipients.length <= MAX_WITHDRAW_RECIPIENTS,
            "1-4 recipients"
        );
        require(recipients.length == splitAmounts.length, "recipients/amounts length mismatch");

        bool early;
        (payout, rewardPaid, early) = _processWithdraw(stakeId, amount);

        uint256 sum;
        for (uint256 i = 0; i < splitAmounts.length; i++) {
            sum += splitAmounts[i];
        }
        require(sum == payout, "split amounts must sum to payout");

        for (uint256 i = 0; i < recipients.length; i++) {
            require(recipients[i] != address(0), "recipient is zero address");
            if (splitAmounts[i] > 0) {
                stakingToken.safeTransfer(recipients[i], splitAmounts[i]);
            }
        }
    }

    /// @notice Convenience full exit to a single wallet (msg.sender):
    ///         withdraws all remaining principal from `stakeId` and settles
    ///         its reward, without the caller needing to pre-compute the
    ///         post-penalty payout the way withdraw() requires. Same
    ///         early-withdrawal penalty and reward-forfeiture rules apply.
    function exitStake(uint256 stakeId) external nonReentrant returns (uint256 payout, uint256 rewardPaid) {
        uint256 amount = stakes[stakeId].amount;
        bool early;
        (payout, rewardPaid, early) = _processWithdraw(stakeId, amount);
        if (payout > 0) {
            stakingToken.safeTransfer(msg.sender, payout);
        }
    }

    /// @notice Claim a matured stake's accrued reward without withdrawing
    ///         principal - lets a staker keep compounding past maturity
    ///         while still collecting periodically. Reverts if the stake
    ///         is still locked: rewards on a locked stake stay "at risk"
    ///         (forfeitable) until either maturity or a deliberate early
    ///         exit, by design - see the contract-level note above.
    function claimReward(uint256 stakeId) external nonReentrant returns (uint256 rewardPaid) {
        StakeInfo storage s = stakes[stakeId];
        require(s.owner == msg.sender, "not your stake");
        require(!s.closed, "stake already closed");
        require(
            block.timestamp >= effectiveUnlockTime(stakeId),
            "still locked - matures or a full early exit settles reward"
        );

        _settleStake(stakeId);
        rewardPaid = s.accruedReward;
        s.accruedReward = 0;

        if (rewardPaid > 0) {
            emit RewardPaid(msg.sender, stakeId, rewardPaid);
            (bool sent, ) = msg.sender.call{value: rewardPaid}("");
            require(sent, "reward transfer failed");
        }
    }

    // ---------- Permissionless funding ----------

    /// @notice Anyone can add native USDC to the reward pool. Held in
    ///         unallocatedUsdc, not immediately active - the owner/notifier
    ///         still has to call notifyRewardAmount() to spread it into the
    ///         live rate, same as any other funding. Deliberately NOT
    ///         wired directly into notifyRewardAmount()'s own access
    ///         control: letting anyone reset the reward rate/period on
    ///         demand would let a griefer manipulate payout timing for
    ///         everyone by spamming tiny contributions.
    function contributeUSDC() external payable {
        require(msg.value > 0, "send some USDC");
        unallocatedUsdc += msg.value;
        emit UsdcContributed(msg.sender, msg.value);
    }

    /// @notice Anyone can donate $SDOGE directly into the reward pipeline -
    ///         held in unallocatedTokens alongside forfeited penalties,
    ///         swept out and converted to USDC the same way.
    function contributeTokens(uint256 amount) external nonReentrant {
        require(amount > 0, "cannot contribute 0");
        unallocatedTokens += amount;
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        emit TokensContributed(msg.sender, amount);
    }

    // ---------- Admin: funding & config ----------

    /// @notice Grants (or revokes, with address(0)) permission to call
    ///         notifyRewardAmount() / sweepTokens() without being the
    ///         owner. Intended for a hot wallet an automated keeper holds -
    ///         never grant this to anything that also needs the owner's
    ///         other privileges.
    function setNotifier(address _notifier) external onlyOwner {
        emit NotifierUpdated(notifier, _notifier);
        notifier = _notifier;
    }

    /// @notice Fund the next rewardsDuration with msg.value of native USDC,
    ///         automatically including any unallocatedUsdc (forfeited
    ///         rewards + permissionless contributions) already sitting
    ///         here. If a period is still running, its unpaid remainder
    ///         rolls into the new rate rather than being lost.
    function notifyRewardAmount() external payable onlyOwnerOrNotifier {
        _updateGlobalReward();

        uint256 totalNew = msg.value + unallocatedUsdc;
        unallocatedUsdc = 0;

        if (block.timestamp >= periodFinish) {
            rewardRate = totalNew / rewardsDuration;
        } else {
            uint256 remaining = periodFinish - block.timestamp;
            uint256 leftover = remaining * rewardRate;
            rewardRate = (totalNew + leftover) / rewardsDuration;
        }

        // Never promise more per second than this contract actually holds
        // for rewards (its native balance minus nothing, since reward is
        // the only use of native value here) - guards against a rate that
        // can't be paid.
        require(rewardRate > 0, "reward rate is 0 (amount too small for duration)");
        require(rewardRate * rewardsDuration <= address(this).balance, "reward too high for balance");

        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + rewardsDuration;
        emit RewardAdded(totalNew, rewardRate, periodFinish);
    }

    /// @notice Only changeable between reward periods, so it can't be used
    ///         to disrupt an active, already-promised payout schedule.
    function setRewardsDuration(uint256 _rewardsDuration) external onlyOwner {
        require(block.timestamp > periodFinish, "previous period still active");
        require(_rewardsDuration > 0, "duration must be > 0");
        rewardsDuration = _rewardsDuration;
        emit RewardsDurationUpdated(_rewardsDuration);
    }

    /// @notice Tune the early-withdrawal penalty. Capped well below 100% so
    ///         it can only ever be a deterrent, never a trap that confiscates
    ///         a staker's entire principal.
    function setEarlyWithdrawPenalty(uint256 _penaltyBps) external onlyOwner {
        require(_penaltyBps <= MAX_EARLY_WITHDRAW_PENALTY_BPS, "penalty too high");
        earlyWithdrawPenaltyBps = _penaltyBps;
        emit EarlyWithdrawPenaltyBpsUpdated(_penaltyBps);
    }

    /// @notice Tune how far into a stake's lock it counts as fully
    ///         unlocked. Bounded to (0%, 100%]: 0 would let a stake start
    ///         "matured," and anything above 100% is meaningless since
    ///         nothing outlasts the lock itself.
    function setEarlyUnlockThreshold(uint256 _thresholdBps) external onlyOwner {
        require(_thresholdBps > 0 && _thresholdBps <= BPS_DENOMINATOR, "threshold out of range");
        earlyUnlockThresholdBps = _thresholdBps;
        emit EarlyUnlockThresholdUpdated(_thresholdBps);
    }

    /// @notice Retune a tier's reward multiplier going forward. Never
    ///         affects the `weighted` value already locked into an
    ///         existing stake - only stakes created after this call use
    ///         the new multiplier.
    function setTierMultiplier(uint8 tier, uint256 multiplierBps) external onlyOwner {
        require(tier < NUM_TIERS, "invalid tier");
        require(multiplierBps > 0 && multiplierBps <= MAX_TIER_MULTIPLIER_BPS, "multiplier out of range");
        tierMultiplierBps[tier] = multiplierBps;
        emit TierMultiplierUpdated(tier, multiplierBps);
    }

    /// @notice Retune a tier's lock duration going forward. Never affects
    ///         the unlockTime already stored on an existing stake.
    function setTierDuration(uint8 tier, uint256 duration) external onlyOwner {
        require(tier < NUM_TIERS, "invalid tier");
        require(duration > 0, "duration must be > 0");
        tierDuration[tier] = duration;
        emit TierDurationUpdated(tier, duration);
    }

    /// @notice Moves accumulated unallocatedTokens (forfeited early-exit
    ///         penalties plus permissionless donations) to `to` for
    ///         conversion into stakers' USDC rewards - e.g. swapped for
    ///         USDC and passed to notifyRewardAmount(). Bounded by
    ///         unallocatedTokens, so it can never reach into stakers'
    ///         principal (totalPrincipalStaked is never touched here).
    function sweepTokens(address to) external onlyOwnerOrNotifier {
        require(to != address(0), "cannot sweep to zero address");
        uint256 amount = unallocatedTokens;
        require(amount > 0, "nothing to sweep");
        unallocatedTokens = 0;
        stakingToken.safeTransfer(to, amount);
        emit TokensSwept(to, amount);
    }

    /// @notice Rescue unrelated tokens accidentally sent here. Can never
    ///         touch the staking token itself - that's stakers' principal
    ///         (or already-accounted-for unallocatedTokens), not the
    ///         owner's to move via this path.
    function recoverERC20(address tokenAddress, uint256 amount) external onlyOwner {
        require(tokenAddress != address(stakingToken), "cannot withdraw the staking token");
        IERC20(tokenAddress).safeTransfer(owner(), amount);
        emit ERC20Recovered(tokenAddress, amount);
    }
}
