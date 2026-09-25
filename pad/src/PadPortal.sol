// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {SdogePadLaunchToken} from "./SdogePadLaunchToken.sol";
import {PadRevenueSplitter} from "./PadRevenueSplitter.sol";
import {SdogePadHook} from "./SdogePadHook.sol";
import {SdogePadLocker} from "./SdogePadLocker.sol";

/// @notice A white-label launchpad, deployed by SdogePadFactory for a paying
/// pad owner. Launches work exactly like the main SdogePadPortal: the full 1B
/// supply goes into a real Uniswap v4 pool on the shared SdogePadHook in one
/// transaction, the liquidity is locked forever, and the token is a plain
/// ERC-20 with no trading restrictions. What's different is the money:
/// every launch gets a PadRevenueSplitter that pays the platform a fixed 15%, the
/// pad owner whatever share the pad charges (0–85%), and the creator the
/// rest. The pad owner may also charge a launch fee of up to $100, split
/// the same 15/85 way.
///
/// The pad owner controls their pad's settings, and changes only apply to
/// launches after the change: each launch's split is locked into its own
/// splitter. A creator passes the highest pad share and launch fee they
/// accept, so a settings change can't catch them out mid-transaction.
/// The launch mechanics (_seedLaunchPool) are SdogePadPortal's, audited and
/// fork-tested; keep the two in step.
contract PadPortal {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    struct PadSettings {
        uint16 padOwnerShareBps; // pad owner's share of each launch's revenue, 0–8500 (the platform always takes 1500)
        uint16 maxTaxBps; // highest buy/sell tax a creator may pick on this pad, 0–1000
        uint256 launchFee; // charged per launch in quoteAsset raw units, 0–MAX_LAUNCH_FEE
        uint256 minStartingMarketCapQuote; // at least MIN_STARTING_MC_QUOTE
    }

    struct CreateLaunchParams {
        string name;
        string symbol;
        uint256 startingMarketCapQuote; // opening market cap in quoteAsset raw units, e.g. 1000e6 = $1,000
        uint16 buyTaxBps;
        uint16 sellTaxBps;
    }

    struct SeedResult {
        PoolKey key;
        address locker;
        bool tokenIsToken0;
        int24 tickLower;
        int24 tickUpper;
        uint160 initSqrtPriceX96;
    }

    address public immutable poolManager;
    address public immutable hook;
    address public immutable treasury;
    address public immutable quoteAsset; // USDC on Arc
    address public immutable factory;
    bool public constant isMainPad = false;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;
    uint16 public constant MAX_TAX_BPS = 1_000; // 10% per side
    uint24 public constant POOL_FEE = 10_000; // 1%
    int24 public constant TICK_SPACING = 200;
    uint256 public constant MIN_STARTING_MC_QUOTE = 100e6; // $100, see SdogePadPortal (audit M-2)
    uint256 public constant MAX_STARTING_MC_QUOTE = 1_000_000_000_000e6; // $1T
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant PLATFORM_SHARE_BPS = 1_500; // the platform's 15%, of revenue and of launch fees
    uint16 public constant MAX_PAD_OWNER_SHARE_BPS = 8_500;
    uint256 public constant MAX_LAUNCH_FEE = 100e6; // $100

    address public padOwner;
    address public pendingPadOwner;
    PadSettings public settings;

    address[] public allLaunches;
    mapping(address => address) public lockerForToken;
    mapping(address => address) public splitterForToken;

    error TaxTooHigh();
    error StartingMcOutOfRange();
    error ZeroAddress();
    error NotPadOwner();
    error InvalidSettings();
    error TermsChanged();

    // Same signature as SdogePadPortal.LaunchCreated, so the indexer and the
    // site read pad launches unchanged.
    event LaunchCreated(
        address indexed token,
        address indexed creator,
        address locker,
        address splitter,
        bytes32 poolId,
        address quoteAsset,
        bool tokenIsToken0,
        uint16 buyTaxBps,
        uint16 sellTaxBps,
        int24 tickLower,
        int24 tickUpper,
        uint160 initSqrtPriceX96,
        string name,
        string symbol
    );
    event LaunchTerms(address indexed token, uint16 padOwnerShareBps, uint256 launchFee);
    event SettingsUpdated(uint16 padOwnerShareBps, uint16 maxTaxBps, uint256 launchFee, uint256 minStartingMarketCapQuote);
    event PadOwnershipTransferStarted(address indexed from, address indexed to);
    event PadOwnershipTransferred(address indexed from, address indexed to);
    event PadOwnerFeesClaimed(address indexed to, uint256 amount);
    event PlatformFeesClaimed(uint256 amount);

    constructor(
        address poolManager_,
        address hook_,
        address treasury_,
        address quoteAsset_,
        address padOwner_,
        PadSettings memory settings_
    ) {
        if (
            poolManager_ == address(0) || hook_ == address(0) || treasury_ == address(0) || quoteAsset_ == address(0)
                || padOwner_ == address(0)
        ) revert ZeroAddress();
        poolManager = poolManager_;
        hook = hook_;
        treasury = treasury_;
        quoteAsset = quoteAsset_;
        factory = msg.sender;
        padOwner = padOwner_;
        _setSettings(settings_);
    }

    modifier onlyPadOwner() {
        if (msg.sender != padOwner) revert NotPadOwner();
        _;
    }

    // ---------------------------------------------------------------- pad owner

    /// @notice Changes the pad's settings. Applies to launches from now on;
    /// every token already launched keeps the split it launched with.
    function setSettings(PadSettings calldata settings_) external onlyPadOwner {
        _setSettings(settings_);
    }

    function _setSettings(PadSettings memory s) internal {
        if (
            s.padOwnerShareBps > MAX_PAD_OWNER_SHARE_BPS || s.maxTaxBps > MAX_TAX_BPS || s.launchFee > MAX_LAUNCH_FEE
                || s.minStartingMarketCapQuote < MIN_STARTING_MC_QUOTE || s.minStartingMarketCapQuote > MAX_STARTING_MC_QUOTE
        ) revert InvalidSettings();
        settings = s;
        emit SettingsUpdated(s.padOwnerShareBps, s.maxTaxBps, s.launchFee, s.minStartingMarketCapQuote);
    }

    /// @notice Step 1 of 2: offer the pad (settings, launch fees and every
    /// unclaimed and future pad-owner share) to `newOwner`.
    function transferPadOwnership(address newOwner) external onlyPadOwner {
        pendingPadOwner = newOwner;
        emit PadOwnershipTransferStarted(padOwner, newOwner);
    }

    /// @notice Step 2 of 2: the offered address accepts.
    function acceptPadOwnership() external {
        if (msg.sender != pendingPadOwner || msg.sender == address(0)) revert NotPadOwner();
        emit PadOwnershipTransferred(padOwner, msg.sender);
        padOwner = msg.sender;
        pendingPadOwner = address(0);
    }

    // ------------------------------------------------------------------ launch

    /// @notice Launch a token on this pad. `maxPadOwnerShareBps` and
    /// `maxLaunchFee` are the highest terms the creator accepts, normally
    /// exactly what the site showed them; if the pad owner changed them in
    /// the meantime, this reverts with TermsChanged instead of launching on
    /// worse terms. With a launch fee, the creator must have approved this
    /// portal for `launchFee` of quoteAsset.
    function createLaunch(CreateLaunchParams calldata p, uint16 maxPadOwnerShareBps, uint256 maxLaunchFee)
        external
        returns (address token, address locker)
    {
        PadSettings memory s = settings;
        if (s.padOwnerShareBps > maxPadOwnerShareBps || s.launchFee > maxLaunchFee) revert TermsChanged();
        if (p.buyTaxBps > s.maxTaxBps || p.sellTaxBps > s.maxTaxBps) revert TaxTooHigh();
        if (p.startingMarketCapQuote < s.minStartingMarketCapQuote || p.startingMarketCapQuote > MAX_STARTING_MC_QUOTE) {
            revert StartingMcOutOfRange();
        }

        if (s.launchFee > 0) {
            uint256 platformCut = (s.launchFee * PLATFORM_SHARE_BPS) / BPS_DENOMINATOR;
            IERC20(quoteAsset).safeTransferFrom(msg.sender, treasury, platformCut);
            IERC20(quoteAsset).safeTransferFrom(msg.sender, padOwner, s.launchFee - platformCut);
        }

        token = address(new SdogePadLaunchToken(p.name, p.symbol, TOTAL_SUPPLY, address(this)));
        address splitter = address(new PadRevenueSplitter(msg.sender, treasury, address(this), s.padOwnerShareBps));

        SeedResult memory r = _seedLaunchPool(token, splitter, p.startingMarketCapQuote, p.buyTaxBps, p.sellTaxBps);
        locker = r.locker;

        lockerForToken[token] = locker;
        splitterForToken[token] = splitter;
        allLaunches.push(token);

        emit LaunchCreated(
            token,
            msg.sender,
            locker,
            splitter,
            PoolId.unwrap(r.key.toId()),
            quoteAsset,
            r.tokenIsToken0,
            p.buyTaxBps,
            p.sellTaxBps,
            r.tickLower,
            r.tickUpper,
            r.initSqrtPriceX96,
            p.name,
            p.symbol
        );
        emit LaunchTerms(token, s.padOwnerShareBps, s.launchFee);
    }

    // ----------------------------------------------------------------- payouts

    /// @notice Pays the pad owner their share from launches [from, to) in one
    /// transaction. Anyone may call; the money only goes to `padOwner`.
    /// Page through a big pad with several calls.
    function claimPadOwnerFees(uint256 from, uint256 to) external returns (uint256 total) {
        uint256 end = to < allLaunches.length ? to : allLaunches.length;
        for (uint256 i = from; i < end; i++) {
            total += PadRevenueSplitter(splitterForToken[allLaunches[i]]).claimPadOwner(quoteAsset);
        }
        emit PadOwnerFeesClaimed(padOwner, total);
    }

    /// @notice Sends the platform's share from launches [from, to) to the treasury.
    /// Anyone may call.
    function claimPlatformFees(uint256 from, uint256 to) external returns (uint256 total) {
        uint256 end = to < allLaunches.length ? to : allLaunches.length;
        for (uint256 i = from; i < end; i++) {
            PadRevenueSplitter splitter = PadRevenueSplitter(splitterForToken[allLaunches[i]]);
            uint256 owed = splitter.creditedToPlatform(quoteAsset);
            if (owed == 0) continue;
            splitter.claimPlatform(quoteAsset);
            total += owed;
        }
        emit PlatformFeesClaimed(total);
    }

    /// @notice What the pad owner can claim from launches [from, to) right
    /// now. Tax still sitting in the hook (not yet flushed) isn't included.
    function pendingPadOwnerFees(uint256 from, uint256 to) external view returns (uint256 total) {
        uint256 end = to < allLaunches.length ? to : allLaunches.length;
        for (uint256 i = from; i < end; i++) {
            total += PadRevenueSplitter(splitterForToken[allLaunches[i]]).creditedToPadOwner(quoteAsset);
        }
    }

    function launchCount() external view returns (uint256) {
        return allLaunches.length;
    }

    // ------------------------------------------------------ launch mechanics

    /// @dev SdogePadPortal._seedLaunchPool, unchanged: initialize the pool at
    /// the position's near edge, deploy the locker, register with the hook,
    /// seed the full supply as one single-sided position, and lock the
    /// splitter's revenue sources to the hook and the locker. See
    /// SdogePadPortal for the full reasoning behind each step.
    function _seedLaunchPool(
        address token,
        address splitter,
        uint256 startingMarketCapQuote,
        uint16 buyTaxBps,
        uint16 sellTaxBps
    ) internal returns (SeedResult memory r) {
        bool tokenIsToken0 = token < quoteAsset;
        Currency currency0 = Currency.wrap(tokenIsToken0 ? token : quoteAsset);
        Currency currency1 = Currency.wrap(tokenIsToken0 ? quoteAsset : token);

        uint256 amount0 = tokenIsToken0 ? TOTAL_SUPPLY : startingMarketCapQuote;
        uint256 amount1 = tokenIsToken0 ? startingMarketCapQuote : TOTAL_SUPPLY;
        uint256 ratioX192 = FullMath.mulDiv(amount1, 1 << 192, amount0);
        uint160 startingSqrtPriceX96 = uint160(Math.sqrt(ratioX192));

        PoolKey memory key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
        int24 flooredTick = _floorToSpacing(TickMath.getTickAtSqrtPrice(startingSqrtPriceX96), TICK_SPACING);
        int24 usableTickLow = (TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING;
        int24 usableTickHigh = (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING;

        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        if (tokenIsToken0) {
            tickLower = flooredTick + TICK_SPACING;
            tickUpper = usableTickHigh;
            liquidity = LiquidityAmounts.getLiquidityForAmount0(
                TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), TOTAL_SUPPLY
            );
        } else {
            tickLower = usableTickLow;
            tickUpper = flooredTick;
            liquidity = LiquidityAmounts.getLiquidityForAmount1(
                TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), TOTAL_SUPPLY
            );
        }

        startingSqrtPriceX96 = TickMath.getSqrtPriceAtTick(tokenIsToken0 ? tickLower : tickUpper);
        IPoolManager(poolManager).initialize(key, startingSqrtPriceX96);

        SdogePadLocker lockerContract =
            new SdogePadLocker(poolManager, splitter, address(this), key, tickLower, tickUpper, tokenIsToken0);
        r.locker = address(lockerContract);

        SdogePadHook(hook).registerPool(key, splitter, r.locker, quoteAsset, tokenIsToken0, buyTaxBps, sellTaxBps);

        IERC20(token).safeTransfer(r.locker, TOTAL_SUPPLY);
        lockerContract.seedLiquidity(liquidity);

        PadRevenueSplitter(splitter).authorizeSource(hook);
        PadRevenueSplitter(splitter).authorizeSource(r.locker);
        PadRevenueSplitter(splitter).lockSources();

        r.key = key;
        r.tokenIsToken0 = tokenIsToken0;
        r.tickLower = tickLower;
        r.tickUpper = tickUpper;
        r.initSqrtPriceX96 = startingSqrtPriceX96;
    }

    function _floorToSpacing(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 quotient = tick / spacing;
        if (tick % spacing != 0 && tick < 0) {
            quotient -= 1;
        }
        return quotient * spacing;
    }
}
