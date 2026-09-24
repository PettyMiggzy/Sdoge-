// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SDOGEStaking
/// @notice Stake $SDOGE into one of 5 lock tiers (7/30/90/180/365 days) and earn native USDC.
///         Longer locks earn faster: each tier multiplies the stake's share of the reward stream.
///
/// Early exit: leave before your stake matures and you forfeit ALL of that stake's accrued,
/// unclaimed reward AND pay a penalty on the principal you take out (15% by default). The
/// forfeited USDC goes back into the reward pool; the SDOGE penalty is swept to the Treasury's
/// token sink to be turned into rewards. Deliberately harsh, per explicit instruction.
///
/// Each stake is its own position, with its own terms fixed the moment it's opened: the tier's
/// lock length and multiplier, the penalty rate, and the time it matures (80% of the way through
/// its lock by default). Later admin changes only ever apply to NEW stakes.
///
/// Where the USDC comes from: the Treasury (notifyRewardAmount), marketplace resale fees
/// (contributeUSDC), forfeited rewards and anything else sent in. The pool is NOT self-funding:
/// with no Treasury or marketplace USDC, rewards are close to zero.
///
/// Arc's native currency IS USDC, so rewards are native value (18 decimals). The same balance is
/// also visible as a 6-decimal ERC-20 at 0x3600...0000; this contract never lets that view be used
/// to move its USDC out.
///
/// Accounting: one global accumulator over "weighted shares" (amount x tier multiplier), the
/// Synthetix StakingRewards shape, O(1) per action. The contract tracks everything it owes in USDC
/// (rewardsOutstanding + unallocatedUsdc) and refuses to promise more than it holds.
contract SDOGEStaking is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Arc's USDC system token: a 6-decimal ERC-20 view of every account's NATIVE balance.
    address public constant USDC_ERC20_VIEW = 0x3600000000000000000000000000000000000000;

    IERC20 public immutable stakingToken;

    // ---------- Tiers and limits ----------

    uint8 public constant NUM_TIERS = 5;
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant PRECISION = 1e18;
    uint256 public constant MAX_WITHDRAW_RECIPIENTS = 4;
    uint256 public constant MAX_EARLY_WITHDRAW_PENALTY_BPS = 3000; // 30% cap
    uint256 public constant MIN_TIER_MULTIPLIER_BPS = 10000; // 1.0x
    uint256 public constant MAX_TIER_MULTIPLIER_BPS = 100000; // 10x
    uint256 public constant MIN_TIER_DURATION = 1 days;
    uint256 public constant MAX_TIER_DURATION = 5 * 365 days;
    uint256 public constant MIN_REWARDS_DURATION = 1 days;
    uint256 public constant MAX_REWARDS_DURATION = 90 days;
    /// @notice After a reward period has been over this long, anyone may start a new one from
    ///         unallocatedUsdc, so the pool never depends on the owner being around.
    uint256 public constant IDLE_NOTIFY_DELAY = 7 days;

    /// @notice Lock length per tier. Tiers must stay strictly increasing in length.
    uint256[NUM_TIERS] public tierDuration = [uint256(7 days), 30 days, 90 days, 180 days, 365 days];

    /// @notice Reward multiplier per tier in bps (10000 = 1.0x). Non-decreasing across tiers.
    uint256[NUM_TIERS] public tierMultiplierBps = [uint256(10000), 12000, 15000, 20000, 30000];

    /// @notice Principal penalty for leaving early, for stakes opened from now on.
    uint256 public earlyWithdrawPenaltyBps = 1500; // 15%

    /// @notice How far into its lock a NEW stake matures (no penalty, no forfeiture from then on).
    ///         Default 80%: a 30-day stake is penalty-free after 24 days.
    uint256 public earlyUnlockThresholdBps = 8000;

    // ---------- Per-stake accounting ----------

    struct StakeInfo {
        address owner;
        uint8 tier;
        uint32 multiplierBps; // the tier's multiplier when this stake was opened
        uint16 penaltyBps; // the early-exit penalty when this stake was opened
        bool closed;
        uint256 amount; // principal still in this stake
        uint256 weighted; // this stake's share of the reward stream
        uint256 startTime;
        uint256 unlockTime; // end of the full lock
        uint256 matureTime; // penalty-free from here on (fixed when the stake was opened)
        uint256 rewardPerWeightedSharePaid;
        uint256 accruedReward; // settled, unpaid native USDC owed on this stake
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

    /// @notice Native USDC waiting to be scheduled into a reward period: forfeited rewards,
    ///         contributions (marketplace fees), rewards that streamed while nobody was staked,
    ///         rounding remainders, and absorbed surplus.
    uint256 public unallocatedUsdc;

    /// @notice Native USDC already promised to stakers: scheduled but not yet streamed, streamed
    ///         but not yet paid, and deferred payouts. unallocatedUsdc + rewardsOutstanding is
    ///         everything this contract owes; its balance never drops below it.
    uint256 public rewardsOutstanding;

    /// @notice Rewards whose payout failed (the staker couldn't receive native USDC). The staker
    ///         pulls them with claimDeferredRewards(to); principal is never held up by this.
    mapping(address => uint256) public deferredRewards;
    uint256 public totalDeferredRewards;

    /// @notice SDOGE waiting to be swept to tokenSink: early-exit penalties, donations, surplus.
    uint256 public unallocatedTokens;

    /// @notice May call notifyRewardAmount() and sweepTokens() besides the owner (a keeper).
    address public notifier;

    /// @notice The only place sweepTokens() can send SDOGE. Set by the owner.
    address public tokenSink;

    // ---------- Events ----------

    event Staked(
        address indexed user,
        uint256 indexed stakeId,
        uint8 tier,
        uint256 amount,
        uint256 weighted,
        uint256 unlockTime,
        uint256 matureTime,
        uint256 penaltyBps
    );
    event Withdrawn(address indexed user, uint256 indexed stakeId, uint256 amount, uint256 payout, bool early);
    event RewardPaid(address indexed user, uint256 indexed stakeId, uint256 amount);
    event RewardDeferred(address indexed user, uint256 indexed stakeId, uint256 amount);
    event DeferredRewardClaimed(address indexed user, address indexed to, uint256 amount);
    event RewardForfeited(address indexed user, uint256 indexed stakeId, uint256 amount);
    event EarlyWithdrawPenalty(address indexed user, uint256 indexed stakeId, uint256 penaltyAmount);
    event RewardAdded(uint256 amount, uint256 newRewardRate, uint256 periodFinish);
    event IdleRewardsReturned(uint256 amount);
    event RewardsDurationUpdated(uint256 newDuration);
    event EarlyWithdrawPenaltyBpsUpdated(uint256 penaltyBps);
    event EarlyUnlockThresholdUpdated(uint256 thresholdBps);
    event TierMultiplierUpdated(uint8 indexed tier, uint256 multiplierBps);
    event TierDurationUpdated(uint8 indexed tier, uint256 duration);
    event NotifierUpdated(address indexed previousNotifier, address indexed newNotifier);
    event TokenSinkUpdated(address indexed previousSink, address indexed newSink);
    event ERC20Recovered(address indexed token, uint256 amount);
    event TokensSwept(address indexed to, uint256 amount);
    event UsdcContributed(address indexed from, uint256 amount);
    event TokensContributed(address indexed from, uint256 amount);
    event SurplusAbsorbed(uint256 usdc, uint256 tokens);

    modifier onlyOwnerOrNotifier() {
        require(msg.sender == owner() || msg.sender == notifier, "not owner or notifier");
        _;
    }

    constructor(address _stakingToken, address _owner) Ownable(_owner) {
        require(_stakingToken != address(0), "staking token is zero address");
        require(_stakingToken != USDC_ERC20_VIEW, "staking token cannot be USDC");
        stakingToken = IERC20(_stakingToken);
        tokenSink = _owner;
        emit TokenSinkUpdated(address(0), _owner);
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

    /// @notice What this stake has earned so far (forfeited instead if it exits early).
    function pendingReward(uint256 stakeId) public view returns (uint256) {
        StakeInfo storage s = stakes[stakeId];
        uint256 delta = rewardPerWeightedShare() - s.rewardPerWeightedSharePaid;
        return s.accruedReward + (s.weighted * delta) / PRECISION;
    }

    /// @notice When `stakeId` matures: from then on it can exit or claim with no penalty.
    function effectiveUnlockTime(uint256 stakeId) public view returns (uint256) {
        return stakes[stakeId].matureTime;
    }

    function isMature(uint256 stakeId) public view returns (bool) {
        return block.timestamp >= stakes[stakeId].matureTime;
    }

    /// @notice What exitStake(stakeId, true) would do right now.
    function previewExit(uint256 stakeId)
        external
        view
        returns (uint256 payout, uint256 reward, uint256 penalty, uint256 forfeitedReward, bool early)
    {
        StakeInfo storage s = stakes[stakeId];
        if (s.closed || s.amount == 0) return (0, 0, 0, 0, false);
        uint256 pending = pendingReward(stakeId);
        early = block.timestamp < s.matureTime;
        if (early) {
            penalty = (s.amount * s.penaltyBps) / BPS_DENOMINATOR;
            payout = s.amount - penalty;
            forfeitedReward = pending;
        } else {
            payout = s.amount;
            reward = pending;
        }
    }

    function getStake(uint256 stakeId) external view returns (StakeInfo memory) {
        return stakes[stakeId];
    }

    function getStakeIds(address user) external view returns (uint256[] memory) {
        return stakeIdsByUser[user];
    }

    /// @notice USDC still to be streamed in the current period (a display convenience).
    function rewardsRemaining() public view returns (uint256) {
        return block.timestamp >= periodFinish ? 0 : (periodFinish - block.timestamp) * rewardRate;
    }

    /// @notice Reward projected over a full rewardsDuration at the current rate (display only).
    function getRewardForDuration() external view returns (uint256) {
        return rewardRate * rewardsDuration;
    }

    // ---------- Internal reward accounting ----------

    function _updateGlobalReward() internal {
        uint256 applicable = lastTimeRewardApplicable();
        if (totalWeightedSupply == 0) {
            // Nobody is staked, so this stretch of the stream has nobody to go to: put it back
            // in unallocatedUsdc instead of losing it.
            uint256 idle;
            if (applicable > lastUpdateTime && rewardRate > 0) {
                idle = (applicable - lastUpdateTime) * rewardRate;
                rewardsOutstanding -= idle;
            }
            // With no open stake and the stream over, only deferred payouts are still owed;
            // anything else in rewardsOutstanding is per-stake rounding dust. Return it too.
            if (block.timestamp >= periodFinish && rewardsOutstanding > totalDeferredRewards) {
                idle += rewardsOutstanding - totalDeferredRewards;
                rewardsOutstanding = totalDeferredRewards;
            }
            if (idle > 0) {
                unallocatedUsdc += idle;
                emit IdleRewardsReturned(idle);
            }
        } else {
            rewardPerWeightedShareStored = rewardPerWeightedShare();
        }
        lastUpdateTime = applicable;
    }

    function _settleStake(uint256 stakeId) internal {
        _updateGlobalReward();
        StakeInfo storage s = stakes[stakeId];
        uint256 delta = rewardPerWeightedShareStored - s.rewardPerWeightedSharePaid;
        s.accruedReward += (s.weighted * delta) / PRECISION;
        s.rewardPerWeightedSharePaid = rewardPerWeightedShareStored;
    }

    /// @dev Pays a matured reward. If the staker can't receive native USDC (a contract without
    ///      receive(), a blocklisted address), the reward is kept for them in deferredRewards
    ///      instead of blocking the exit.
    function _payReward(address staker, uint256 stakeId, uint256 amount) internal {
        if (amount == 0) return;
        rewardsOutstanding -= amount;
        (bool sent,) = payable(staker).call{value: amount}("");
        if (sent) {
            emit RewardPaid(staker, stakeId, amount);
        } else {
            rewardsOutstanding += amount;
            deferredRewards[staker] += amount;
            totalDeferredRewards += amount;
            emit RewardDeferred(staker, stakeId, amount);
        }
    }

    // ---------- Staking ----------

    /// @notice Opens a stake. `expectedDuration` and `expectedMultiplierBps` must match the tier's
    ///         current terms, so a change landing just before this transaction can't surprise you.
    function stake(uint8 tier, uint256 amount, uint256 expectedDuration, uint256 expectedMultiplierBps)
        external
        nonReentrant
        returns (uint256 stakeId)
    {
        require(amount > 0, "cannot stake 0");
        require(tier < NUM_TIERS, "invalid tier");
        uint256 duration = tierDuration[tier];
        uint256 multiplier = tierMultiplierBps[tier];
        require(duration == expectedDuration && multiplier == expectedMultiplierBps, "tier terms changed");

        _updateGlobalReward();

        uint256 weighted = (amount * multiplier) / BPS_DENOMINATOR;
        uint256 unlockTime = block.timestamp + duration;
        uint256 matureTime = block.timestamp + (duration * earlyUnlockThresholdBps) / BPS_DENOMINATOR;

        stakeId = nextStakeId++;
        stakes[stakeId] = StakeInfo({
            owner: msg.sender,
            tier: tier,
            multiplierBps: uint32(multiplier),
            penaltyBps: uint16(earlyWithdrawPenaltyBps),
            closed: false,
            amount: amount,
            weighted: weighted,
            startTime: block.timestamp,
            unlockTime: unlockTime,
            matureTime: matureTime,
            rewardPerWeightedSharePaid: rewardPerWeightedShareStored,
            accruedReward: 0
        });
        stakeIdsByUser[msg.sender].push(stakeId);

        totalPrincipalStaked += amount;
        totalWeightedSupply += weighted;

        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, stakeId, tier, amount, weighted, unlockTime, matureTime, earlyWithdrawPenaltyBps);
    }

    /// @dev Shared by withdraw() and exitStake(): settles the stake, applies the early-exit
    ///      penalty and forfeiture when it hasn't matured, and updates every balance. Moves no
    ///      tokens; callers send the SDOGE first, then the reward.
    function _processWithdraw(uint256 stakeId, uint256 amount, bool allowEarly)
        internal
        returns (uint256 payout, uint256 reward, bool early)
    {
        StakeInfo storage s = stakes[stakeId];
        require(s.owner == msg.sender, "not your stake");
        require(!s.closed, "stake already closed");
        require(amount > 0 && amount <= s.amount, "invalid amount");

        _settleStake(stakeId);

        early = block.timestamp < s.matureTime;
        require(allowEarly || !early, "exit would be early");

        // Remove this stake's OWN weight in proportion, never the tier's current multiplier; a
        // full exit removes all of it.
        uint256 removedWeighted = amount == s.amount ? s.weighted : (s.weighted * amount) / s.amount;
        s.amount -= amount;
        s.weighted -= removedWeighted;
        totalPrincipalStaked -= amount;
        totalWeightedSupply -= removedWeighted;

        if (early) {
            uint256 penalty = (amount * s.penaltyBps) / BPS_DENOMINATOR;
            payout = amount - penalty;
            unallocatedTokens += penalty;
            emit EarlyWithdrawPenalty(msg.sender, stakeId, penalty);

            uint256 forfeited = s.accruedReward;
            if (forfeited > 0) {
                s.accruedReward = 0;
                rewardsOutstanding -= forfeited;
                unallocatedUsdc += forfeited;
                emit RewardForfeited(msg.sender, stakeId, forfeited);
            }
        } else {
            payout = amount;
            reward = s.accruedReward;
            s.accruedReward = 0;
        }

        if (s.amount == 0) s.closed = true;
        emit Withdrawn(msg.sender, stakeId, amount, payout, early);
    }

    /// @notice Withdraws `amount` of principal from `stakeId`, paid to 1-4 wallets. `splitAmounts`
    ///         must add up to exactly what is paid out after any penalty, which doubles as a guard:
    ///         a split computed for a matured exit reverts if the stake turns out to be early.
    ///         A matured stake's reward goes to msg.sender. Each stake is its own position:
    ///         leaving one early forfeits that stake's whole reward, not your other stakes'.
    function withdraw(uint256 stakeId, uint256 amount, address[] calldata recipients, uint256[] calldata splitAmounts)
        external
        nonReentrant
        returns (uint256 payout, uint256 reward)
    {
        require(recipients.length > 0 && recipients.length <= MAX_WITHDRAW_RECIPIENTS, "1-4 recipients");
        require(recipients.length == splitAmounts.length, "recipients/amounts length mismatch");

        (payout, reward,) = _processWithdraw(stakeId, amount, true);

        uint256 sum;
        for (uint256 i = 0; i < splitAmounts.length; i++) {
            sum += splitAmounts[i];
        }
        require(sum == payout, "split amounts must sum to payout");

        for (uint256 i = 0; i < recipients.length; i++) {
            require(recipients[i] != address(0), "recipient is zero address");
            require(recipients[i] != address(this), "recipient is the staking contract");
            if (splitAmounts[i] > 0) stakingToken.safeTransfer(recipients[i], splitAmounts[i]);
        }
        _payReward(msg.sender, stakeId, reward);
    }

    /// @notice Full exit to your own wallet. Pass allowEarly = false unless you mean to leave
    ///         early: then an exit that would land before maturity (even by a second) reverts
    ///         instead of charging the penalty and forfeiting the reward.
    function exitStake(uint256 stakeId, bool allowEarly) external nonReentrant returns (uint256 payout, uint256 reward) {
        (payout, reward,) = _processWithdraw(stakeId, stakes[stakeId].amount, allowEarly);
        if (payout > 0) stakingToken.safeTransfer(msg.sender, payout);
        _payReward(msg.sender, stakeId, reward);
    }

    /// @notice Collects a matured stake's reward and keeps the stake running. A stake that hasn't
    ///         matured keeps its reward at risk until it matures or exits early.
    function claimReward(uint256 stakeId) external nonReentrant returns (uint256 reward) {
        StakeInfo storage s = stakes[stakeId];
        require(s.owner == msg.sender, "not your stake");
        require(!s.closed, "stake already closed");
        require(block.timestamp >= s.matureTime, "still locked - matures or a full early exit settles reward");

        _settleStake(stakeId);
        reward = s.accruedReward;
        s.accruedReward = 0;
        _payReward(msg.sender, stakeId, reward);
    }

    /// @notice Sends your deferred rewards (payouts that failed earlier) to `to`.
    function claimDeferredRewards(address payable to) external nonReentrant returns (uint256 amount) {
        require(to != address(0) && to != address(this), "bad recipient");
        amount = deferredRewards[msg.sender];
        require(amount > 0, "nothing deferred");
        deferredRewards[msg.sender] = 0;
        totalDeferredRewards -= amount;
        rewardsOutstanding -= amount;
        (bool sent,) = to.call{value: amount}("");
        require(sent, "transfer failed");
        emit DeferredRewardClaimed(msg.sender, to, amount);
    }

    // ---------- Funding ----------

    /// @notice Anyone can add native USDC to the reward pool (the marketplace sends its fees
    ///         here). It waits in unallocatedUsdc until the next reward period is scheduled.
    function contributeUSDC() external payable {
        require(msg.value > 0, "send some USDC");
        unallocatedUsdc += msg.value;
        emit UsdcContributed(msg.sender, msg.value);
    }

    /// @notice Anyone can donate $SDOGE; it's swept to tokenSink with the penalties.
    function contributeTokens(uint256 amount) external nonReentrant {
        require(amount > 0, "cannot contribute 0");
        unallocatedTokens += amount;
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        emit TokensContributed(msg.sender, amount);
    }

    /// @notice Counts anything sent here outside the normal paths (USDC through the 0x3600 ERC-20
    ///         view, a SELFDESTRUCT, SDOGE transferred directly) as pool money: surplus USDC joins
    ///         unallocatedUsdc and surplus SDOGE joins unallocatedTokens. Anyone can call it.
    function absorbSurplus() external nonReentrant returns (uint256 usdc, uint256 tokens) {
        uint256 owedUsdc = unallocatedUsdc + rewardsOutstanding;
        if (address(this).balance > owedUsdc) {
            usdc = address(this).balance - owedUsdc;
            unallocatedUsdc += usdc;
        }
        uint256 owedTokens = totalPrincipalStaked + unallocatedTokens;
        uint256 held = stakingToken.balanceOf(address(this));
        if (held > owedTokens) {
            tokens = held - owedTokens;
            unallocatedTokens += tokens;
        }
        emit SurplusAbsorbed(usdc, tokens);
    }

    /// @notice Schedules msg.value plus unallocatedUsdc over the next rewardsDuration. A running
    ///         period's unstreamed remainder rolls in. While a period is running, a new one may not
    ///         pay out slower than the current one, so re-notifying can never postpone rewards
    ///         that were already promised.
    function notifyRewardAmount() external payable onlyOwnerOrNotifier {
        _notify();
    }

    /// @notice Once the last period has been over for IDLE_NOTIFY_DELAY, anyone can start a new
    ///         one from unallocatedUsdc. Keeps rewards flowing without the owner.
    function notifyUnallocated() external {
        require(block.timestamp >= periodFinish + IDLE_NOTIFY_DELAY, "owner or notifier schedules for now");
        require(totalWeightedSupply > 0, "nobody is staked");
        _notify();
    }

    function _notify() internal {
        _updateGlobalReward();

        bool running = block.timestamp < periodFinish;
        uint256 leftover = running ? (periodFinish - block.timestamp) * rewardRate : 0;
        uint256 pot = msg.value + unallocatedUsdc + leftover;
        uint256 newRate = pot / rewardsDuration;
        require(newRate > 0, "reward rate is 0 (amount too small for duration)");
        if (running) require(newRate >= rewardRate, "would slow the current payout");

        uint256 scheduled = newRate * rewardsDuration;
        rewardsOutstanding = rewardsOutstanding - leftover + scheduled;
        unallocatedUsdc = pot - scheduled; // the rounding remainder waits for next time
        rewardRate = newRate;
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + rewardsDuration;

        require(address(this).balance >= unallocatedUsdc + rewardsOutstanding, "not enough USDC for what's owed");
        emit RewardAdded(msg.value, newRate, periodFinish);
    }

    // ---------- Admin ----------

    /// @notice Grants (or revokes, with address(0)) notify and sweep rights to a keeper.
    function setNotifier(address _notifier) external onlyOwner {
        emit NotifierUpdated(notifier, _notifier);
        notifier = _notifier;
    }

    /// @notice Where swept SDOGE goes (the Treasury or a converter). The notifier can trigger a
    ///         sweep but can never choose the destination.
    function setTokenSink(address sink) external onlyOwner {
        require(sink != address(0) && sink != address(this), "bad sink");
        emit TokenSinkUpdated(tokenSink, sink);
        tokenSink = sink;
    }

    /// @notice Only between reward periods, and between 1 and 90 days.
    function setRewardsDuration(uint256 _rewardsDuration) external onlyOwner {
        require(block.timestamp > periodFinish, "previous period still active");
        require(
            _rewardsDuration >= MIN_REWARDS_DURATION && _rewardsDuration <= MAX_REWARDS_DURATION,
            "duration out of range"
        );
        rewardsDuration = _rewardsDuration;
        emit RewardsDurationUpdated(_rewardsDuration);
    }

    /// @notice Penalty for stakes opened from now on. Capped at 30%. Never changes open stakes.
    function setEarlyWithdrawPenalty(uint256 _penaltyBps) external onlyOwner {
        require(_penaltyBps <= MAX_EARLY_WITHDRAW_PENALTY_BPS, "penalty too high");
        earlyWithdrawPenaltyBps = _penaltyBps;
        emit EarlyWithdrawPenaltyBpsUpdated(_penaltyBps);
    }

    /// @notice Maturity point for stakes opened from now on, in (0%, 100%]. Never changes open stakes.
    function setEarlyUnlockThreshold(uint256 _thresholdBps) external onlyOwner {
        require(_thresholdBps > 0 && _thresholdBps <= BPS_DENOMINATOR, "threshold out of range");
        earlyUnlockThresholdBps = _thresholdBps;
        emit EarlyUnlockThresholdUpdated(_thresholdBps);
    }

    /// @notice Multiplier for stakes opened from now on, 1.0x-10x, and never below the tier under
    ///         it or above the tier over it. Never changes open stakes.
    function setTierMultiplier(uint8 tier, uint256 multiplierBps) external onlyOwner {
        require(tier < NUM_TIERS, "invalid tier");
        require(
            multiplierBps >= MIN_TIER_MULTIPLIER_BPS && multiplierBps <= MAX_TIER_MULTIPLIER_BPS,
            "multiplier out of range"
        );
        require(tier == 0 || tierMultiplierBps[tier - 1] <= multiplierBps, "below the tier under it");
        require(tier == NUM_TIERS - 1 || multiplierBps <= tierMultiplierBps[tier + 1], "above the tier over it");
        tierMultiplierBps[tier] = multiplierBps;
        emit TierMultiplierUpdated(tier, multiplierBps);
    }

    /// @notice Lock length for stakes opened from now on, 1 day to 5 years, strictly between its
    ///         neighbours. Never changes open stakes.
    function setTierDuration(uint8 tier, uint256 duration) external onlyOwner {
        require(tier < NUM_TIERS, "invalid tier");
        require(duration >= MIN_TIER_DURATION && duration <= MAX_TIER_DURATION, "duration out of range");
        require(tier == 0 || tierDuration[tier - 1] < duration, "not longer than the tier under it");
        require(tier == NUM_TIERS - 1 || duration < tierDuration[tier + 1], "not shorter than the tier over it");
        tierDuration[tier] = duration;
        emit TierDurationUpdated(tier, duration);
    }

    /// @notice Sends unallocatedTokens (penalties, donations, surplus) to tokenSink to be turned
    ///         into rewards. Never touches principal.
    function sweepTokens() external onlyOwnerOrNotifier {
        uint256 amount = unallocatedTokens;
        require(amount > 0, "nothing to sweep");
        unallocatedTokens = 0;
        stakingToken.safeTransfer(tokenSink, amount);
        emit TokensSwept(tokenSink, amount);
    }

    /// @notice Rescues unrelated tokens sent here by mistake. Can never move the staking token or
    ///         USDC: 0x3600... is this contract's own native balance in ERC-20 form.
    function recoverERC20(address tokenAddress, uint256 amount) external onlyOwner {
        require(tokenAddress != address(stakingToken), "cannot withdraw the staking token");
        require(tokenAddress != USDC_ERC20_VIEW, "cannot withdraw USDC");
        IERC20(tokenAddress).safeTransfer(owner(), amount);
        emit ERC20Recovered(tokenAddress, amount);
    }

    /// @notice Disabled: without an owner, nothing could ever be scheduled or fixed again.
    function renounceOwnership() public view override onlyOwner {
        revert("renounce disabled");
    }
}
