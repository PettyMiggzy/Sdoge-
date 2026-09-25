// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SDOGEStaking
/// @notice Stake $SDOGE into one of 5 lock tiers (7/30/90/180/365 days) and earn native USDC and
///         $SDOGE. Longer locks earn faster: each tier multiplies the stake's share of both reward
///         streams, and staking an SDOGE Collectible with the stake raises that share further.
///
/// Early exit: leave before your stake matures and you forfeit ALL of that stake's accrued,
/// unclaimed rewards AND pay a 15% penalty on the principal you take out. None of it leaves the
/// pool: the SDOGE penalty and the forfeited SDOGE are streamed to the stakers who stay, and the
/// forfeited USDC goes back into the USDC reward pool. Deliberately harsh, per explicit instruction.
///
/// The terms are fixed in the code and nobody can change them: the five lock lengths and
/// multipliers, the 15% penalty, and maturity at 80% of the way through the lock (a 30-day stake
/// is penalty-free after 24 days). Each stake is its own position with its own lock.
///
/// NFT boost: a stake can be opened by sending one SDOGE Collectible here together with the
/// stake's terms (the staking page does it). The stake's share is multiplied by 1 + that design's
/// boost (at most +50%), fixed when the stake opens. The NFT is held until the stake closes, early
/// or not, and is never penalized. The owner sets each design's boost and can lock them for good.
///
/// Where the rewards come from:
/// - USDC: the Treasury (notifyRewardAmount), marketplace and Studio revenue (contributeUSDC),
///   forfeited USDC rewards and anything else sent in. The USDC pool is NOT self-funding: with no
///   Treasury or marketplace USDC, USDC rewards are close to zero.
/// - SDOGE: early-exit penalties, forfeited SDOGE rewards, donations (contributeTokens) and the
///   Treasury (notifySdogeRewards). Once rewards have started, new SDOGE joins the stream on its
///   own as stakers come and go; nobody has to schedule it.
///
/// Arc's native currency IS USDC, so USDC rewards are native value (18 decimals). The same balance
/// is also visible as a 6-decimal ERC-20 at 0x3600...0000; this contract never lets that view be
/// used to move its USDC out.
///
/// Accounting: one accumulator per reward currency over "weighted shares" (amount x tier
/// multiplier x NFT boost), the Synthetix StakingRewards shape, O(1) per action. The contract
/// tracks everything it owes in each currency and refuses to promise more than it holds.
contract SDOGEStaking is Ownable2Step, ReentrancyGuard, IERC1155Receiver {
    using SafeERC20 for IERC20;

    /// @notice Arc's USDC system token: a 6-decimal ERC-20 view of every account's NATIVE balance.
    address public constant USDC_ERC20_VIEW = 0x3600000000000000000000000000000000000000;

    IERC20 public immutable stakingToken;

    /// @notice The SDOGE Collectibles (ERC-1155) whose NFTs boost a stake. address(0): no boosts.
    IERC1155 public immutable boostCollection;

    // ---------- Tiers and limits ----------

    uint8 public constant NUM_TIERS = 5;
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant PRECISION = 1e18;
    uint256 public constant MAX_WITHDRAW_RECIPIENTS = 4;
    uint256 public constant MIN_REWARDS_DURATION = 1 days;
    uint256 public constant MAX_REWARDS_DURATION = 90 days;
    /// @notice After a USDC reward period has been over this long, anyone may start a new one
    ///         from unallocatedUsdc, so the pool never depends on the owner being around.
    uint256 public constant IDLE_NOTIFY_DELAY = 7 days;
    /// @notice New SDOGE rewards (penalties, forfeits, donations) stream out over this long.
    uint256 public constant SDOGE_REWARDS_DURATION = 7 days;
    /// @notice The most an NFT can raise a stake's share: +50%.
    uint256 public constant MAX_BOOST_BPS = 5000;

    /// @notice Principal penalty for leaving before maturity: 15%.
    uint256 public constant earlyWithdrawPenaltyBps = 1500;

    /// @notice How far into its lock a stake matures (no penalty, no forfeiture from then on): 80%.
    uint256 public constant earlyUnlockThresholdBps = 8000;

    /// @notice Lock length per tier: 7, 30, 90, 180 and 365 days.
    function tierDuration(uint256 tier) public pure returns (uint256) {
        if (tier == 0) return 7 days;
        if (tier == 1) return 30 days;
        if (tier == 2) return 90 days;
        if (tier == 3) return 180 days;
        if (tier == 4) return 365 days;
        revert("invalid tier");
    }

    /// @notice Reward multiplier per tier in bps (10000 = 1.0x): 1.0x, 1.2x, 1.5x, 2.0x and 3.0x.
    function tierMultiplierBps(uint256 tier) public pure returns (uint256) {
        if (tier == 0) return 10000;
        if (tier == 1) return 12000;
        if (tier == 2) return 15000;
        if (tier == 3) return 20000;
        if (tier == 4) return 30000;
        revert("invalid tier");
    }

    /// @notice A stake's share of both reward streams: amount x tier multiplier x (1 + NFT boost).
    function weightOf(uint256 amount, uint256 multiplierBps, uint256 boostBps) public pure returns (uint256) {
        return (amount * multiplierBps * (BPS_DENOMINATOR + boostBps)) / (BPS_DENOMINATOR * BPS_DENOMINATOR);
    }

    // ---------- Per-stake accounting ----------

    struct StakeInfo {
        address owner;
        uint8 tier;
        uint32 multiplierBps; // the tier's multiplier
        uint16 penaltyBps; // the early-exit penalty
        uint16 boostBps; // the staked NFT's boost; 0 = no NFT
        bool closed;
        bool holdsNft; // this contract holds the stake's NFT (until the stake closes)
        uint256 nftId; // the staked NFT's design id
        uint256 amount; // principal still in this stake
        uint256 weighted; // this stake's share of the reward streams
        uint256 startTime;
        uint256 unlockTime; // end of the full lock
        uint256 matureTime; // penalty-free from here on
        uint256 rewardPerWeightedSharePaid;
        uint256 accruedReward; // settled, unpaid native USDC owed on this stake
        uint256 sdogeRewardPerWeightedSharePaid;
        uint256 accruedSdogeReward; // settled, unpaid SDOGE owed on this stake
    }

    uint256 public nextStakeId = 1;
    mapping(uint256 => StakeInfo) private _stakes;
    mapping(address => uint256[]) public stakeIdsByUser;

    /// @notice Open stakes per wallet, and how many wallets have at least one.
    mapping(address => uint256) public openStakeCount;
    uint256 public activeStakers;

    uint256 public totalPrincipalStaked;
    uint256 public totalWeightedSupply;

    // ---------- USDC reward stream (native, over weighted shares) ----------

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

    // ---------- SDOGE reward stream (over the same weighted shares) ----------

    uint256 public sdogePeriodFinish;
    uint256 public sdogeRewardRate;
    uint256 public sdogeLastUpdateTime;
    uint256 public sdogeRewardPerWeightedShareStored;

    /// @notice SDOGE waiting to join the stream: early-exit penalties, forfeited SDOGE rewards,
    ///         donations, SDOGE that streamed while nobody was staked, rounding remainders, and
    ///         absorbed surplus.
    uint256 public unallocatedSdoge;

    /// @notice SDOGE already promised to stakers: scheduled but not yet streamed, or streamed but
    ///         not yet paid. The SDOGE balance is always at least totalPrincipalStaked +
    ///         unallocatedSdoge + sdogeRewardsOutstanding.
    uint256 public sdogeRewardsOutstanding;

    /// @notice Set by the owner's (or notifier's) first notifyRewardAmount / notifySdogeRewards.
    ///         From then on new SDOGE joins the stream on its own. Before it, nothing streams to
    ///         whoever happens to be staked, so the team's seed stake can go in first.
    bool public rewardsStarted;

    // ---------- Running totals (for display) ----------

    uint256 public totalUsdcRewardsPaid;
    uint256 public totalSdogeRewardsPaid;
    uint256 public totalPenalties;

    // ---------- NFT boosts ----------

    /// @notice Each Collectible design's boost in bps (2500 = +25%); 0 = can't be staked.
    mapping(uint256 => uint256) public designBoostBps;
    /// @notice Once locked, no design's boost can ever change again.
    bool public boostsLocked;
    /// @notice NFTs held for open stakes.
    uint256 public nftsStaked;
    /// @notice NFTs whose return failed when their stake closed (the wallet refused it). The
    ///         owner of the stake pulls them with claimDeferredNft; no exit is held up by this.
    mapping(address => mapping(uint256 => uint256)) public deferredNfts;

    /// @notice May start reward periods besides the owner (a keeper).
    address public notifier;

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
    event NftStaked(address indexed user, uint256 indexed stakeId, uint256 indexed designId, uint256 boostBps);
    event NftReturned(address indexed user, uint256 indexed stakeId, uint256 indexed designId);
    event NftReturnDeferred(address indexed user, uint256 indexed stakeId, uint256 indexed designId);
    event DeferredNftClaimed(address indexed user, address indexed to, uint256 indexed designId);
    event Withdrawn(address indexed user, uint256 indexed stakeId, uint256 amount, uint256 payout, bool early);
    event RewardPaid(address indexed user, uint256 indexed stakeId, uint256 amount);
    event RewardDeferred(address indexed user, uint256 indexed stakeId, uint256 amount);
    event DeferredRewardClaimed(address indexed user, address indexed to, uint256 amount);
    event RewardForfeited(address indexed user, uint256 indexed stakeId, uint256 amount);
    event SdogeRewardPaid(address indexed user, uint256 indexed stakeId, uint256 amount);
    event SdogeRewardForfeited(address indexed user, uint256 indexed stakeId, uint256 amount);
    event EarlyWithdrawPenalty(address indexed user, uint256 indexed stakeId, uint256 penaltyAmount);
    /// `amount` is what was newly added to the stream (on top of what a running period still had).
    event RewardAdded(uint256 amount, uint256 newRewardRate, uint256 periodFinish);
    event SdogeRewardAdded(uint256 amount, uint256 newRewardRate, uint256 periodFinish);
    event IdleRewardsReturned(uint256 amount);
    event IdleSdogeReturned(uint256 amount);
    event RewardsDurationUpdated(uint256 newDuration);
    event NotifierUpdated(address indexed previousNotifier, address indexed newNotifier);
    event DesignBoostSet(uint256 indexed designId, uint256 boostBps);
    event BoostsLocked();
    event ERC20Recovered(address indexed token, uint256 amount);
    event UsdcContributed(address indexed from, uint256 amount);
    event TokensContributed(address indexed from, uint256 amount);
    event SurplusAbsorbed(uint256 usdc, uint256 tokens);

    modifier onlyOwnerOrNotifier() {
        require(msg.sender == owner() || msg.sender == notifier, "not owner or notifier");
        _;
    }

    constructor(address _stakingToken, address _boostCollection, address _owner) Ownable(_owner) {
        require(_stakingToken != address(0), "staking token is zero address");
        require(_stakingToken != USDC_ERC20_VIEW, "staking token cannot be USDC");
        require(_boostCollection != _stakingToken && _boostCollection != USDC_ERC20_VIEW, "bad boost collection");
        stakingToken = IERC20(_stakingToken);
        boostCollection = IERC1155(_boostCollection);
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

    function lastTimeSdogeRewardApplicable() public view returns (uint256) {
        return block.timestamp < sdogePeriodFinish ? block.timestamp : sdogePeriodFinish;
    }

    function sdogeRewardPerWeightedShare() public view returns (uint256) {
        if (totalWeightedSupply == 0) return sdogeRewardPerWeightedShareStored;
        uint256 elapsed = lastTimeSdogeRewardApplicable() - sdogeLastUpdateTime;
        return sdogeRewardPerWeightedShareStored + (elapsed * sdogeRewardRate * PRECISION) / totalWeightedSupply;
    }

    /// @notice The USDC this stake has earned so far (forfeited instead if it exits early).
    function pendingReward(uint256 stakeId) public view returns (uint256) {
        StakeInfo storage s = _stakes[stakeId];
        uint256 delta = rewardPerWeightedShare() - s.rewardPerWeightedSharePaid;
        return s.accruedReward + (s.weighted * delta) / PRECISION;
    }

    /// @notice The SDOGE this stake has earned so far (forfeited instead if it exits early).
    function pendingSdogeReward(uint256 stakeId) public view returns (uint256) {
        StakeInfo storage s = _stakes[stakeId];
        uint256 delta = sdogeRewardPerWeightedShare() - s.sdogeRewardPerWeightedSharePaid;
        return s.accruedSdogeReward + (s.weighted * delta) / PRECISION;
    }

    /// @notice When `stakeId` matures: from then on it can exit or claim with no penalty.
    function effectiveUnlockTime(uint256 stakeId) public view returns (uint256) {
        return _stakes[stakeId].matureTime;
    }

    function isMature(uint256 stakeId) public view returns (bool) {
        return block.timestamp >= _stakes[stakeId].matureTime;
    }

    /// @notice What exitStake(stakeId, true) would do right now.
    function previewExit(uint256 stakeId)
        external
        view
        returns (
            uint256 payout,
            uint256 reward,
            uint256 sdogeReward,
            uint256 penalty,
            uint256 forfeitedReward,
            uint256 forfeitedSdogeReward,
            bool early
        )
    {
        StakeInfo storage s = _stakes[stakeId];
        if (s.closed || s.amount == 0) return (0, 0, 0, 0, 0, 0, false);
        early = block.timestamp < s.matureTime;
        if (early) {
            penalty = (s.amount * s.penaltyBps) / BPS_DENOMINATOR;
            payout = s.amount - penalty;
            forfeitedReward = pendingReward(stakeId);
            forfeitedSdogeReward = pendingSdogeReward(stakeId);
        } else {
            payout = s.amount;
            reward = pendingReward(stakeId);
            sdogeReward = pendingSdogeReward(stakeId);
        }
    }

    function getStake(uint256 stakeId) external view returns (StakeInfo memory) {
        return _stakes[stakeId];
    }

    function getStakeIds(address user) external view returns (uint256[] memory) {
        return stakeIdsByUser[user];
    }

    /// @notice USDC still to be streamed in the current period (a display convenience).
    function rewardsRemaining() public view returns (uint256) {
        return block.timestamp >= periodFinish ? 0 : (periodFinish - block.timestamp) * rewardRate;
    }

    /// @notice USDC reward projected over a full rewardsDuration at the current rate (display only).
    function getRewardForDuration() external view returns (uint256) {
        return rewardRate * rewardsDuration;
    }

    /// @notice SDOGE still to be streamed in the current SDOGE period (a display convenience).
    function sdogeRewardsRemaining() public view returns (uint256) {
        return block.timestamp >= sdogePeriodFinish ? 0 : (sdogePeriodFinish - block.timestamp) * sdogeRewardRate;
    }

    // ---------- Internal reward accounting ----------

    function _updateGlobalReward() internal {
        _updateUsdcReward();
        _updateSdogeReward();
    }

    function _updateUsdcReward() internal {
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

    function _updateSdogeReward() internal {
        uint256 applicable = lastTimeSdogeRewardApplicable();
        if (totalWeightedSupply == 0) {
            // Same as USDC: what streams while nobody is staked goes back to unallocatedSdoge,
            // and so does the rounding dust once the stream is over (SDOGE is never deferred).
            uint256 idle;
            if (applicable > sdogeLastUpdateTime && sdogeRewardRate > 0) {
                idle = (applicable - sdogeLastUpdateTime) * sdogeRewardRate;
                sdogeRewardsOutstanding -= idle;
            }
            if (block.timestamp >= sdogePeriodFinish && sdogeRewardsOutstanding > 0) {
                idle += sdogeRewardsOutstanding;
                sdogeRewardsOutstanding = 0;
            }
            if (idle > 0) {
                unallocatedSdoge += idle;
                emit IdleSdogeReturned(idle);
            }
        } else {
            sdogeRewardPerWeightedShareStored = sdogeRewardPerWeightedShare();
        }
        sdogeLastUpdateTime = applicable;
    }

    function _settleStake(StakeInfo storage s) internal {
        _updateGlobalReward();
        uint256 usdcPerShare = rewardPerWeightedShareStored;
        s.accruedReward += (s.weighted * (usdcPerShare - s.rewardPerWeightedSharePaid)) / PRECISION;
        s.rewardPerWeightedSharePaid = usdcPerShare;
        uint256 sdogePerShare = sdogeRewardPerWeightedShareStored;
        s.accruedSdogeReward += (s.weighted * (sdogePerShare - s.sdogeRewardPerWeightedSharePaid)) / PRECISION;
        s.sdogeRewardPerWeightedSharePaid = sdogePerShare;
    }

    /// @dev Pays a matured USDC reward. If the staker can't receive native USDC (a contract
    ///      without receive(), a blocklisted address), the reward is kept for them in
    ///      deferredRewards instead of blocking the exit.
    function _payReward(address staker, uint256 stakeId, uint256 amount) internal {
        if (amount == 0) return;
        rewardsOutstanding -= amount;
        (bool sent,) = payable(staker).call{value: amount}("");
        if (sent) {
            totalUsdcRewardsPaid += amount;
            emit RewardPaid(staker, stakeId, amount);
        } else {
            rewardsOutstanding += amount;
            deferredRewards[staker] += amount;
            totalDeferredRewards += amount;
            emit RewardDeferred(staker, stakeId, amount);
        }
    }

    function _paySdogeReward(address staker, uint256 stakeId, uint256 amount) internal {
        if (amount == 0) return;
        sdogeRewardsOutstanding -= amount;
        totalSdogeRewardsPaid += amount;
        stakingToken.safeTransfer(staker, amount);
        emit SdogeRewardPaid(staker, stakeId, amount);
    }

    /// @dev Moves a stake's accrued rewards back into the pools (an early exit).
    function _forfeit(StakeInfo storage s, uint256 stakeId) internal {
        uint256 usdc = s.accruedReward;
        if (usdc > 0) {
            s.accruedReward = 0;
            rewardsOutstanding -= usdc;
            unallocatedUsdc += usdc;
            emit RewardForfeited(msg.sender, stakeId, usdc);
        }
        uint256 sdoge = s.accruedSdogeReward;
        if (sdoge > 0) {
            s.accruedSdogeReward = 0;
            sdogeRewardsOutstanding -= sdoge;
            unallocatedSdoge += sdoge;
            emit SdogeRewardForfeited(msg.sender, stakeId, sdoge);
        }
    }

    /// @dev Schedules `pot` (unallocatedSdoge plus a running period's unstreamed `leftover`) over
    ///      the next SDOGE_REWARDS_DURATION at `newRate`. The rounding remainder waits in
    ///      unallocatedSdoge.
    function _scheduleSdoge(uint256 pot, uint256 leftover, uint256 newRate) internal {
        uint256 scheduled = newRate * SDOGE_REWARDS_DURATION;
        sdogeRewardsOutstanding = sdogeRewardsOutstanding - leftover + scheduled;
        unallocatedSdoge = pot - scheduled;
        sdogeRewardRate = newRate;
        sdogeLastUpdateTime = block.timestamp;
        sdogePeriodFinish = block.timestamp + SDOGE_REWARDS_DURATION;
        emit SdogeRewardAdded(scheduled - leftover, newRate, sdogePeriodFinish);
    }

    /// @dev Streams unallocated SDOGE (penalties, forfeits, donations) to the stakers, once rewards
    ///      have started and someone is staked, whenever that can't slow down what a running
    ///      period already promised; otherwise it waits for a later action. Never reverts.
    function _rollSdoge() internal returns (bool) {
        _updateSdogeReward();
        uint256 unallocated = unallocatedSdoge;
        if (!rewardsStarted || totalWeightedSupply == 0 || unallocated == 0) return false;
        bool running = block.timestamp < sdogePeriodFinish;
        uint256 leftover = running ? (sdogePeriodFinish - block.timestamp) * sdogeRewardRate : 0;
        uint256 pot = unallocated + leftover;
        uint256 newRate = pot / SDOGE_REWARDS_DURATION;
        if (newRate == 0 || (running && newRate < sdogeRewardRate)) return false;
        _scheduleSdoge(pot, leftover, newRate);
        return true;
    }

    // ---------- Staking ----------

    /// @notice Opens a stake. `expectedDuration` and `expectedMultiplierBps` must match the tier's
    ///         terms, so a page showing the wrong terms can't stake on them.
    function stake(uint8 tier, uint256 amount, uint256 expectedDuration, uint256 expectedMultiplierBps)
        external
        nonReentrant
        returns (uint256 stakeId)
    {
        stakeId = _openStake(msg.sender, tier, amount, expectedDuration, expectedMultiplierBps, 0, 0);
    }

    /// @notice Opens a stake with an NFT boost. Called by the boost collection when a holder
    ///         sends it one of their own NFTs with
    ///         safeTransferFrom(holder, this, designId, 1, abi.encode(tier, amount,
    ///         expectedDuration, expectedMultiplierBps, expectedBoostBps)).
    ///         The SDOGE is pulled from the holder, who must have approved it. No blanket NFT
    ///         approval is ever needed. Anything else sent here (another collection, a design with
    ///         no boost, no terms, someone else's NFT, more than one) is refused.
    function onERC1155Received(address operator, address from, uint256 id, uint256 value, bytes calldata data)
        external
        nonReentrant
        returns (bytes4)
    {
        require(msg.sender == address(boostCollection), "not a boost NFT");
        require(operator == from, "stake your own NFT");
        require(value == 1, "one NFT per stake");
        _stakeWithNft(from, id, data);
        return IERC1155Receiver.onERC1155Received.selector;
    }

    /// @dev What the NFT transfer's data must hold: abi.encode(tier, amount, expectedDuration,
    ///      expectedMultiplierBps, expectedBoostBps).
    struct NftStakeTerms {
        uint8 tier;
        uint256 amount;
        uint256 expectedDuration;
        uint256 expectedMultiplierBps;
        uint256 expectedBoostBps;
    }

    function _stakeWithNft(address from, uint256 designId, bytes calldata data) internal {
        require(data.length == 160, "send the NFT with the stake's terms");
        NftStakeTerms memory t = abi.decode(data, (NftStakeTerms));
        uint256 boost = designBoostBps[designId];
        require(boost > 0, "this NFT gives no boost");
        require(boost == t.expectedBoostBps, "boost changed");
        _openStake(from, t.tier, t.amount, t.expectedDuration, t.expectedMultiplierBps, boost, designId);
    }

    /// @notice One NFT per stake: batches are refused.
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert("one NFT per stake");
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function _openStake(
        address staker,
        uint8 tier,
        uint256 amount,
        uint256 expectedDuration,
        uint256 expectedMultiplierBps,
        uint256 boostBps,
        uint256 designId
    ) internal returns (uint256 stakeId) {
        require(amount > 0, "cannot stake 0");
        require(tier < NUM_TIERS, "invalid tier");
        uint256 duration = tierDuration(tier);
        uint256 multiplier = tierMultiplierBps(tier);
        require(duration == expectedDuration && multiplier == expectedMultiplierBps, "tier terms changed");

        _updateGlobalReward();

        uint256 weighted = weightOf(amount, multiplier, boostBps);
        stakeId = nextStakeId++;
        StakeInfo storage s = _stakes[stakeId];
        s.owner = staker;
        s.tier = tier;
        s.multiplierBps = uint32(multiplier);
        s.penaltyBps = uint16(earlyWithdrawPenaltyBps);
        s.amount = amount;
        s.weighted = weighted;
        s.startTime = block.timestamp;
        s.unlockTime = block.timestamp + duration;
        s.matureTime = block.timestamp + (duration * earlyUnlockThresholdBps) / BPS_DENOMINATOR;
        s.rewardPerWeightedSharePaid = rewardPerWeightedShareStored;
        s.sdogeRewardPerWeightedSharePaid = sdogeRewardPerWeightedShareStored;
        if (boostBps > 0) {
            s.boostBps = uint16(boostBps);
            s.holdsNft = true;
            s.nftId = designId;
            nftsStaked++;
        }
        stakeIdsByUser[staker].push(stakeId);
        if (openStakeCount[staker]++ == 0) activeStakers++;

        totalPrincipalStaked += amount;
        totalWeightedSupply += weighted;

        stakingToken.safeTransferFrom(staker, address(this), amount);
        emit Staked(staker, stakeId, tier, amount, weighted, s.unlockTime, s.matureTime, earlyWithdrawPenaltyBps);
        if (boostBps > 0) emit NftStaked(staker, stakeId, designId, boostBps);
        _rollSdoge();
    }

    /// @dev Shared by withdraw() and exitStake(): settles the stake, applies the early-exit
    ///      penalty and forfeiture when it hasn't matured, and updates every balance. Moves no
    ///      tokens; callers send the SDOGE first, then finish with _finishExit.
    function _processWithdraw(uint256 stakeId, uint256 amount, bool allowEarly)
        internal
        returns (uint256 payout, uint256 reward, uint256 sdogeReward, bool closedNow)
    {
        StakeInfo storage s = _stakes[stakeId];
        require(s.owner == msg.sender, "not your stake");
        require(!s.closed, "stake already closed");
        require(amount > 0 && amount <= s.amount, "invalid amount");

        _settleStake(s);

        bool early = block.timestamp < s.matureTime;
        require(allowEarly || !early, "exit would be early");

        // Remove this stake's OWN weight in proportion, never the tier's current multiplier; a
        // full exit removes all of it.
        uint256 removedWeighted = amount == s.amount ? s.weighted : (s.weighted * amount) / s.amount;
        s.amount -= amount;
        s.weighted -= removedWeighted;
        totalPrincipalStaked -= amount;
        totalWeightedSupply -= removedWeighted;

        if (early) {
            // The penalty stays in the pool, for the stakers who stay.
            uint256 penalty = (amount * s.penaltyBps) / BPS_DENOMINATOR;
            payout = amount - penalty;
            unallocatedSdoge += penalty;
            totalPenalties += penalty;
            emit EarlyWithdrawPenalty(msg.sender, stakeId, penalty);
            _forfeit(s, stakeId);
        } else {
            payout = amount;
            reward = s.accruedReward;
            sdogeReward = s.accruedSdogeReward;
            s.accruedReward = 0;
            s.accruedSdogeReward = 0;
        }

        if (s.amount == 0) {
            s.closed = true;
            closedNow = true;
            if (--openStakeCount[msg.sender] == 0) activeStakers--;
        }
        emit Withdrawn(msg.sender, stakeId, amount, payout, early);
    }

    /// @dev After an exit's SDOGE is sent: pays the SDOGE reward, streams what the exit left in
    ///      the pool, returns the NFT of a stake that just closed, and pays the USDC reward last.
    function _finishExit(uint256 stakeId, uint256 reward, uint256 sdogeReward, bool closedNow) internal {
        _paySdogeReward(msg.sender, stakeId, sdogeReward);
        _rollSdoge();
        if (closedNow) _returnNft(stakeId);
        _payReward(msg.sender, stakeId, reward);
    }

    /// @dev Returns a closing stake's NFT. If the wallet refuses it (a contract that can't take
    ///      ERC-1155 tokens), it's kept for them in deferredNfts instead of blocking the exit.
    function _returnNft(uint256 stakeId) internal {
        StakeInfo storage s = _stakes[stakeId];
        if (!s.holdsNft) return;
        s.holdsNft = false;
        nftsStaked--;
        address to = s.owner;
        uint256 designId = s.nftId;
        try boostCollection.safeTransferFrom(address(this), to, designId, 1, "") {
            emit NftReturned(to, stakeId, designId);
        } catch {
            deferredNfts[to][designId] += 1;
            emit NftReturnDeferred(to, stakeId, designId);
        }
    }

    /// @notice Withdraws `amount` of principal from `stakeId`, paid to 1-4 wallets. `splitAmounts`
    ///         must add up to exactly what is paid out after any penalty. Pass allowEarly = false
    ///         unless you mean to leave early: then a withdrawal that would land before maturity
    ///         reverts instead of charging the penalty and forfeiting the stake's whole reward.
    ///         A matured stake's rewards go to msg.sender, and so does the NFT of a stake this
    ///         closes. Each stake is its own position: leaving one early forfeits that stake's
    ///         whole reward, not your other stakes'.
    function withdraw(
        uint256 stakeId,
        uint256 amount,
        address[] calldata recipients,
        uint256[] calldata splitAmounts,
        bool allowEarly
    ) external nonReentrant returns (uint256 payout, uint256 reward, uint256 sdogeReward) {
        require(recipients.length > 0 && recipients.length <= MAX_WITHDRAW_RECIPIENTS, "1-4 recipients");
        require(recipients.length == splitAmounts.length, "recipients/amounts length mismatch");

        bool closedNow;
        (payout, reward, sdogeReward, closedNow) = _processWithdraw(stakeId, amount, allowEarly);

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
        _finishExit(stakeId, reward, sdogeReward, closedNow);
    }

    /// @notice Full exit to your own wallet, NFT included. Pass allowEarly = false unless you
    ///         mean to leave early: then an exit that would land before maturity (even by a
    ///         second) reverts instead of charging the penalty and forfeiting the rewards.
    function exitStake(uint256 stakeId, bool allowEarly)
        external
        nonReentrant
        returns (uint256 payout, uint256 reward, uint256 sdogeReward)
    {
        bool closedNow;
        (payout, reward, sdogeReward, closedNow) = _processWithdraw(stakeId, _stakes[stakeId].amount, allowEarly);
        if (payout > 0) stakingToken.safeTransfer(msg.sender, payout);
        _finishExit(stakeId, reward, sdogeReward, closedNow);
    }

    /// @notice Collects a matured stake's USDC and SDOGE rewards and keeps the stake running. A
    ///         stake that hasn't matured keeps its rewards at risk until it matures or exits early.
    function claimReward(uint256 stakeId) external nonReentrant returns (uint256 reward, uint256 sdogeReward) {
        StakeInfo storage s = _stakes[stakeId];
        require(s.owner == msg.sender, "not your stake");
        require(!s.closed, "stake already closed");
        require(block.timestamp >= s.matureTime, "still locked - matures or a full early exit settles reward");

        _settleStake(s);
        reward = s.accruedReward;
        sdogeReward = s.accruedSdogeReward;
        s.accruedReward = 0;
        s.accruedSdogeReward = 0;
        _finishExit(stakeId, reward, sdogeReward, false);
    }

    /// @notice Sends your deferred USDC rewards (payouts that failed earlier) to `to`.
    function claimDeferredRewards(address payable to) external nonReentrant returns (uint256 amount) {
        require(to != address(0) && to != address(this), "bad recipient");
        amount = deferredRewards[msg.sender];
        require(amount > 0, "nothing deferred");
        deferredRewards[msg.sender] = 0;
        totalDeferredRewards -= amount;
        rewardsOutstanding -= amount;
        totalUsdcRewardsPaid += amount;
        (bool sent,) = to.call{value: amount}("");
        require(sent, "transfer failed");
        emit DeferredRewardClaimed(msg.sender, to, amount);
    }

    /// @notice Sends one of your deferred NFTs (a return that failed earlier) to `to`.
    function claimDeferredNft(uint256 designId, address to) external nonReentrant {
        require(to != address(0) && to != address(this), "bad recipient");
        require(deferredNfts[msg.sender][designId] > 0, "nothing deferred");
        deferredNfts[msg.sender][designId] -= 1;
        boostCollection.safeTransferFrom(address(this), to, designId, 1, "");
        emit DeferredNftClaimed(msg.sender, to, designId);
    }

    // ---------- Funding ----------

    /// @notice Anyone can add native USDC to the reward pool (the marketplace sends its fees
    ///         here). It waits in unallocatedUsdc until the next reward period is scheduled.
    function contributeUSDC() external payable {
        require(msg.value > 0, "send some USDC");
        unallocatedUsdc += msg.value;
        emit UsdcContributed(msg.sender, msg.value);
    }

    /// @notice Anyone can add $SDOGE to the SDOGE rewards; it joins the stream like the penalties.
    function contributeTokens(uint256 amount) external nonReentrant {
        require(amount > 0, "cannot contribute 0");
        unallocatedSdoge += amount;
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        emit TokensContributed(msg.sender, amount);
        _rollSdoge();
    }

    /// @notice Counts anything sent here outside the normal paths (USDC through the 0x3600 ERC-20
    ///         view, a SELFDESTRUCT, SDOGE transferred directly) as pool money: surplus USDC joins
    ///         unallocatedUsdc and surplus SDOGE joins unallocatedSdoge. Anyone can call it.
    function absorbSurplus() external nonReentrant returns (uint256 usdc, uint256 tokens) {
        uint256 owedUsdc = unallocatedUsdc + rewardsOutstanding;
        if (address(this).balance > owedUsdc) {
            usdc = address(this).balance - owedUsdc;
            unallocatedUsdc += usdc;
        }
        uint256 owedTokens = totalPrincipalStaked + unallocatedSdoge + sdogeRewardsOutstanding;
        uint256 held = stakingToken.balanceOf(address(this));
        if (held > owedTokens) {
            tokens = held - owedTokens;
            unallocatedSdoge += tokens;
        }
        emit SurplusAbsorbed(usdc, tokens);
        if (tokens > 0) _rollSdoge();
    }

    /// @notice Schedules msg.value plus unallocatedUsdc over the next rewardsDuration. A running
    ///         period's unstreamed remainder rolls in. While a period is running, a new one may not
    ///         pay out slower than the current one, so re-notifying can never postpone rewards
    ///         that were already promised.
    function notifyRewardAmount() external payable onlyOwnerOrNotifier {
        rewardsStarted = true;
        _notify();
    }

    /// @notice Once the last USDC period has been over for IDLE_NOTIFY_DELAY, anyone can start a
    ///         new one from unallocatedUsdc. Keeps rewards flowing without the owner. The very
    ///         first period is always started by the owner or notifier.
    function notifyUnallocated() external {
        require(periodFinish != 0, "the owner starts the first period");
        require(block.timestamp >= periodFinish + IDLE_NOTIFY_DELAY, "owner or notifier schedules for now");
        require(totalWeightedSupply > 0, "nobody is staked");
        _notify();
    }

    function _notify() internal {
        _updateUsdcReward();

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
        emit RewardAdded(scheduled - leftover, newRate, periodFinish);
    }

    /// @notice Pulls `amount` SDOGE from the caller (0 for none) and streams it, with everything
    ///         in unallocatedSdoge, over the next SDOGE_REWARDS_DURATION. Like the USDC side, it
    ///         can never slow a running period down. The first call (or the first
    ///         notifyRewardAmount) starts rewards; from then on SDOGE also streams on its own.
    function notifySdogeRewards(uint256 amount) external nonReentrant onlyOwnerOrNotifier {
        rewardsStarted = true;
        if (amount > 0) {
            unallocatedSdoge += amount;
            stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        }
        _updateSdogeReward();

        bool running = block.timestamp < sdogePeriodFinish;
        uint256 leftover = running ? (sdogePeriodFinish - block.timestamp) * sdogeRewardRate : 0;
        uint256 pot = unallocatedSdoge + leftover;
        uint256 newRate = pot / SDOGE_REWARDS_DURATION;
        require(newRate > 0, "reward rate is 0 (amount too small for duration)");
        if (running) require(newRate >= sdogeRewardRate, "would slow the current payout");
        _scheduleSdoge(pot, leftover, newRate);

        require(
            stakingToken.balanceOf(address(this)) >= totalPrincipalStaked + unallocatedSdoge + sdogeRewardsOutstanding,
            "not enough SDOGE for what's owed"
        );
    }

    /// @notice Anyone can stream what's waiting in unallocatedSdoge, once rewards have started.
    ///         Every stake, exit and claim already does this; it's here for quiet stretches.
    function notifyUnallocatedSdoge() external nonReentrant {
        require(rewardsStarted, "the owner starts the first period");
        require(_rollSdoge(), "nothing to stream right now");
    }

    // ---------- Admin ----------

    /// @notice Grants (or revokes, with address(0)) the right to start reward periods to a keeper.
    function setNotifier(address _notifier) external onlyOwner {
        emit NotifierUpdated(notifier, _notifier);
        notifier = _notifier;
    }

    /// @notice The USDC reward period's length: only between periods, and between 1 and 90 days.
    function setRewardsDuration(uint256 _rewardsDuration) external onlyOwner {
        require(block.timestamp > periodFinish, "previous period still active");
        require(
            _rewardsDuration >= MIN_REWARDS_DURATION && _rewardsDuration <= MAX_REWARDS_DURATION,
            "duration out of range"
        );
        rewardsDuration = _rewardsDuration;
        emit RewardsDurationUpdated(_rewardsDuration);
    }

    /// @notice Sets Collectible designs' boosts (bps, at most MAX_BOOST_BPS; 0 = can't be staked)
    ///         until lockBoosts(). A stake keeps the boost it opened with.
    function setDesignBoosts(uint256[] calldata designIds, uint256[] calldata boostBps) external onlyOwner {
        require(address(boostCollection) != address(0), "no boost collection");
        require(!boostsLocked, "boosts are locked");
        require(designIds.length == boostBps.length, "ids/boosts length mismatch");
        for (uint256 i = 0; i < designIds.length; i++) {
            require(boostBps[i] <= MAX_BOOST_BPS, "boost above the maximum");
            designBoostBps[designIds[i]] = boostBps[i];
            emit DesignBoostSet(designIds[i], boostBps[i]);
        }
    }

    /// @notice Fixes every design's boost for good.
    function lockBoosts() external onlyOwner {
        require(!boostsLocked, "boosts are locked");
        boostsLocked = true;
        emit BoostsLocked();
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
