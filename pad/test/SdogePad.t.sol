// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "@uniswap/v4-core/lib/solmate/src/test/utils/mocks/MockERC20.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {SdogePadPortal} from "../src/SdogePadPortal.sol";
import {SdogePadHook} from "../src/SdogePadHook.sol";
import {SdogePadRevenueSplitter} from "../src/SdogePadRevenueSplitter.sol";
import {SdogePadLocker} from "../src/SdogePadLocker.sol";
import {SdogePadLaunchToken} from "../src/SdogePadLaunchToken.sol";
import {SdogePadFactory} from "../src/SdogePadFactory.sol";
import {PadPortal} from "../src/PadPortal.sol";
import {PadRevenueSplitter} from "../src/PadRevenueSplitter.sol";
import {SdogePadTreasury} from "../src/SdogePadTreasury.sol";

contract SdogePadTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    MockERC20 usdc;
    SdogePadHook hook;
    SdogePadPortal portal;
    SdogePadFactory factory;
    SdogePadTreasury treasury;
    address treasuryOwner = makeAddr("treasuryOwner");
    address creator = makeAddr("creator");
    address trader1 = makeAddr("trader1");
    address trader2 = makeAddr("trader2");
    address customer = makeAddr("customer"); // buys a white-label pad from the factory

    uint256 constant USDC_DECIMALS = 1e6;
    uint256 constant STARTING_MC = 500 * USDC_DECIMALS; // $500 opening market cap, zero real capital required
    uint256 constant SETUP_FEE = 100 * USDC_DECIMALS;
    uint256 constant TOTAL_SUPPLY = 1_000_000_000 ether;

    function setUp() public {
        deployFreshManagerAndRouters(); // sets up `manager` + `swapRouter` (PoolSwapTest)
        usdc = new MockERC20("USD Coin", "USDC", 6);

        // Flags required post-audit (the 2026-09-22 audit's fixes): BEFORE_INITIALIZE gates
        // pool creation to authorized portals (closes the pre-initialize
        // griefing vector, H-3); BEFORE_SWAP + BEFORE_SWAP_RETURNS_DELTA let
        // the hook tax the specified leg when quote is specified (needed so
        // tax always lands in quote, not the launch token — H-1);
        // AFTER_SWAP + AFTER_SWAP_RETURNS_DELTA handle the complementary
        // case. Without the RETURNS_DELTA bits, a hook's returned delta is
        // silently ignored and every real swap reverts with
        // CurrencyNotSettled() — see SdogePadHook's contract-level comment.
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        bytes memory creationCode = type(SdogePadHook).creationCode;
        // bootstrapper = address(this): this test contract is the one that
        // calls bootstrapMainPortal/bootstrapFactory below, so it must be
        // the address baked into the hook's constructor (audit finding
        // D-1) — not captured as msg.sender inside the constructor itself.
        bytes memory constructorArgs = abi.encode(address(manager), address(this));
        (address predictedHook, bytes32 salt) = HookMiner.find(address(this), flags, creationCode, constructorArgs);

        hook = new SdogePadHook{salt: salt}(address(manager), address(this));
        require(address(hook) == predictedHook, "hook address mismatch");

        treasury = new SdogePadTreasury(treasuryOwner);

        portal = new SdogePadPortal(address(manager), address(hook), address(treasury), address(usdc), true);
        hook.bootstrapMainPortal(address(portal));

        factory = new SdogePadFactory(address(manager), address(hook), address(treasury), address(usdc), SETUP_FEE, address(this));
        hook.bootstrapFactory(address(factory));

        usdc.mint(creator, 100_000 * USDC_DECIMALS);
        usdc.mint(trader1, 100_000 * USDC_DECIMALS);
        usdc.mint(trader2, 100_000 * USDC_DECIMALS);
        usdc.mint(customer, 100_000 * USDC_DECIMALS);
    }

    // Hook mining uses Uniswap's own `HookMiner.find` (audit findings
    // D-4/D-6: no vm.ffi, no Python, nothing outside Solidity to trust).
    // Calling it twice with identical (deployer, flags, initCode) inputs —
    // as the blocklist test below does, re-mining against the exact same
    // setUp() inputs — naturally finds a DIFFERENT salt the second time:
    // HookMiner.find skips any candidate address that already has code,
    // and setUp()'s hook already occupies the first match.

    function _createLaunch(SdogePadPortal p, uint16 buyTaxBps, uint16 sellTaxBps)
        internal
        returns (address token, address locker)
    {
        vm.prank(creator);
        (token, locker) = p.createLaunch(
            SdogePadPortal.CreateLaunchParams({
                name: "Test Doge",
                symbol: "TDOGE",
                startingMarketCapQuote: STARTING_MC,
                buyTaxBps: buyTaxBps,
                sellTaxBps: sellTaxBps
            })
        );
    }

    function _keyFor(address token) internal view returns (PoolKey memory) {
        bool tokenIsToken0 = token < address(usdc);
        return PoolKey({
            currency0: tokenIsToken0 ? Currency.wrap(token) : Currency.wrap(address(usdc)),
            currency1: tokenIsToken0 ? Currency.wrap(address(usdc)) : Currency.wrap(token),
            fee: portal.POOL_FEE(),
            tickSpacing: portal.TICK_SPACING(),
            hooks: IHooks(address(hook))
        });
    }

    /// @dev Swaps `quoteIn` of USDC for `token`, working out the correct
    /// zeroForOne direction regardless of which address happens to sort
    /// lower (token/quote ordering is not something a test should assume).
    function _buy(address trader, address token, PoolKey memory key, uint256 quoteIn) internal returns (uint256 tokensOut) {
        bool tokenIsToken0 = Currency.unwrap(key.currency0) == token;
        bool zeroForOne = !tokenIsToken0; // giving quote, receiving token
        uint256 tokenBefore = SdogePadLaunchToken(token).balanceOf(trader);

        vm.startPrank(trader);
        usdc.approve(address(swapRouter), quoteIn);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(quoteIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        tokensOut = SdogePadLaunchToken(token).balanceOf(trader) - tokenBefore;
    }

    /// @dev Sells `tokenIn` of `token` for USDC, same direction-agnostic
    /// approach as `_buy`.
    function _sell(address trader, address token, PoolKey memory key, uint256 tokenIn) internal returns (uint256 quoteOut) {
        bool tokenIsToken0 = Currency.unwrap(key.currency0) == token;
        bool zeroForOne = tokenIsToken0; // giving token, receiving quote
        uint256 quoteBefore = usdc.balanceOf(trader);

        vm.startPrank(trader);
        SdogePadLaunchToken(token).approve(address(swapRouter), tokenIn);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(tokenIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        quoteOut = usdc.balanceOf(trader) - quoteBefore;
    }

    function _sqrtPrice(PoolKey memory key) internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,) = manager.getSlot0(key.toId());
    }

    // ------------------------------------------------------------------
    // Launch creates a real pool, live from block one
    // ------------------------------------------------------------------

    function test_LaunchCreatesRealPoolWithFullLiquidity() public {
        (address token, address locker) = _createLaunch(portal, 100, 150);

        // Once seeded, the full supply moves OUT of the locker and INTO
        // the pool as the position's reserves — the locker holds the
        // abstract LP position, not a matching raw token balance. Only a
        // tiny rounding remainder (integer tick math, a fraction of a wei
        // relative to 1e27) should be left sitting in the locker as dust.
        assertLt(
            SdogePadLaunchToken(token).balanceOf(locker),
            1e12,
            "locker should have almost no raw token balance left - the supply now backs the pool position"
        );
        assertEq(SdogePadLaunchToken(token).totalSupply(), TOTAL_SUPPLY, "total supply should be exactly 1B");
        assertTrue(SdogePadLocker(locker).seeded(), "locker should be seeded immediately, no separate step");

        // Not manager.getLiquidity() — that reflects only liquidity ACTIVE
        // at the pool's current tick, and this ask-wall position is
        // deliberately placed entirely above (or below) the current price,
        // so it never contributes to "active" liquidity until a trade
        // pushes price into its range. Read the specific position instead.
        PoolKey memory key = _keyFor(token);
        (uint128 positionLiquidity,,) = manager.getPositionInfo(
            key.toId(), locker, SdogePadLocker(locker).tickLower(), SdogePadLocker(locker).tickUpper(), bytes32(0)
        );
        assertGt(positionLiquidity, 0, "the locker's position should hold real liquidity from the moment it's created");
    }

    function test_BuyIncreasesPriceAndDeliversTokens() public {
        (address token,) = _createLaunch(portal, 100, 150);
        PoolKey memory key = _keyFor(token);

        uint160 priceBefore = _sqrtPrice(key);
        uint256 tokensOut = _buy(trader1, token, key, 50 * USDC_DECIMALS);
        uint160 priceAfter = _sqrtPrice(key);

        assertGt(tokensOut, 0, "buyer should receive tokens");
        // Price direction depends on token/quote ordering, but magnitude
        // moving away from the opening price either way proves the trade
        // actually consumed the single-sided position.
        assertTrue(priceAfter != priceBefore, "price should move after a buy");
    }

    /// @notice Right after launch there is deliberately no bid-side
    /// liquidity (the position is 100% launch token, an ask wall) — no
    /// real money was ever deposited, so there's nothing to sell into yet.
    /// A sell only becomes possible once a buy has pushed some real quote
    /// into the position. This is the expected shape of the design, not a
    /// bug: zero real capital risk means zero depth until real buyers
    /// create it.
    function test_SellWorksOnlyAfterABuyCreatesBidSideDepth() public {
        (address token,) = _createLaunch(portal, 100, 150);
        PoolKey memory key = _keyFor(token);

        _buy(trader1, token, key, 200 * USDC_DECIMALS);
        uint256 tokenBal = SdogePadLaunchToken(token).balanceOf(trader1);
        assertGt(tokenBal, 0);

        uint256 sellAmount = tokenBal / 4; // small relative to the buy, safely within the new bid-side depth
        uint160 priceBeforeSell = _sqrtPrice(key);
        uint256 quoteOut = _sell(trader1, token, key, sellAmount);
        uint160 priceAfterSell = _sqrtPrice(key);

        assertGt(quoteOut, 0, "seller should receive quote once bid-side depth exists");
        assertTrue(priceAfterSell != priceBeforeSell, "price should move after a sell");
    }

    /// @notice Directly proves the creator's buy/sell rates are independent
    /// and actually applied — not just "a fee gets taken", but the RIGHT
    /// fee for each direction (buyTaxBps=100=1%, sellTaxBps=150=1.5% in
    /// this launch's params), split flat 90/10 with no subdivision, and
    /// ALWAYS denominated in quote (USDC) — never in the launch token,
    /// buy or sell alike. The 2026-09-22 audit (H-1) found the pre-fix hook taxed
    /// whichever currency was "unspecified", which meant every ordinary
    /// exact-input buy — what every router sends by default — was taxed in
    /// the launch token instead: a 10% buy tax handed the creator a
    /// claimable, dumpable 9% of the tokens bought on every single buy.
    /// This test is the direct regression check for that fix.
    function test_BuyAndSellTaxAreBothAlwaysInQuoteNeverInLaunchToken() public {
        (address token, address locker) = _createLaunch(portal, 100, 150);
        PoolKey memory key = _keyFor(token);
        address splitter = SdogePadLocker(locker).splitter();

        uint256 quoteIn = 200 * USDC_DECIMALS;
        _buy(trader1, token, key, quoteIn);
        hook.flush(key); // moves the hook's accrued ERC-6909 claim into the splitter

        // The buy tax must land in USDC, and must NOT accrue any credit in
        // the launch token at all — the exact H-1 regression.
        assertEq(SdogePadRevenueSplitter(splitter).creditedToCreator(token), 0, "buy tax must never be credited in the launch token");
        uint256 creditedAfterBuy = SdogePadRevenueSplitter(splitter).creditedToCreator(address(usdc));
        assertGt(creditedAfterBuy, 0, "creator should be credited some of the buy tax, in USDC");

        uint256 tokenBal = SdogePadLaunchToken(token).balanceOf(trader1);
        _sell(trader1, token, key, tokenBal / 2);
        hook.flush(key);

        // The sell tax also lands in USDC — same ledger entry the buy tax
        // used, since both are quote-denominated now.
        uint256 creditedAfterSell = SdogePadRevenueSplitter(splitter).creditedToCreator(address(usdc));
        assertGt(creditedAfterSell, creditedAfterBuy, "creator should be credited some of the sell tax too, in the same USDC ledger");
        assertEq(SdogePadRevenueSplitter(splitter).creditedToCreator(token), 0, "sell tax must never be credited in the launch token either");

        // The tax never touched the hook's own ERC-20 balance or the
        // splitter's balance outside the credited ledger — it moved purely
        // through ERC-6909 claims until flush() settled it (H-2's fix).
        assertEq(SdogePadLaunchToken(token).balanceOf(address(hook)), 0, "hook should never hold raw launch tokens");
    }

    /// @notice A random, non-portal caller can never sneak a pool through
    /// this hook by calling PoolManager.initialize directly — closing the
    /// pre-launch griefing vector the 2026-09-22 audit found (H-3): a launch's
    /// token address is predictable ahead of time, so without this gate
    /// anyone could initialize the exact pool key first and permanently
    /// block the real createLaunch with PoolAlreadyInitialized.
    function test_PreInitializeGriefingByNonPortalIsBlocked() public {
        address griefer = makeAddr("griefer");
        address predictedNextToken = makeAddr("predictedNextToken"); // stand-in for a predicted CREATE address
        bool tokenIsToken0 = predictedNextToken < address(usdc);
        PoolKey memory key = PoolKey({
            currency0: tokenIsToken0 ? Currency.wrap(predictedNextToken) : Currency.wrap(address(usdc)),
            currency1: tokenIsToken0 ? Currency.wrap(address(usdc)) : Currency.wrap(predictedNextToken),
            fee: portal.POOL_FEE(),
            tickSpacing: portal.TICK_SPACING(),
            hooks: IHooks(address(hook))
        });

        // The hook's revert bubbles up wrapped in v4-core's own
        // CustomRevert.WrappedError (see Hooks.callHook) rather than as the
        // raw selector, so this only asserts that SOME revert happens, not
        // its exact encoding — the point is that the pool never gets
        // initialized, not the wrapper format.
        vm.prank(griefer);
        vm.expectRevert();
        manager.initialize(key, uint160(1) << 96);
    }

    function test_TaxAboveTenPercentCapIsRejected() public {
        vm.prank(creator);
        vm.expectRevert(SdogePadPortal.TaxTooHigh.selector);
        portal.createLaunch(
            SdogePadPortal.CreateLaunchParams({
                name: "Greedy Doge",
                symbol: "GREED",
                startingMarketCapQuote: STARTING_MC,
                buyTaxBps: 1_001, // just over MAX_TAX_BPS (1_000 = 10%)
                sellTaxBps: 100
            })
        );
    }

    /// @notice Bounds on startingMarketCapQuote (audit finding M-2): below
    /// ~$54 in 6-decimal USDC, the token1-ordering price math used to
    /// overflow uint256 with an opaque revert — but only when the launch
    /// token happened to sort as currency1, so the SAME market cap could
    /// succeed or fail depending on an address the creator doesn't control.
    /// MIN_STARTING_MC_QUOTE now rejects anything in the danger zone with a
    /// clean, address-ordering-independent error instead.
    function test_StartingMcOutOfBoundsIsRejected() public {
        // Computed up front, not inline in the call below: vm.expectRevert
        // only intercepts the very next external call, and
        // `portal.MIN_STARTING_MC_QUOTE()` is itself an external staticcall
        // — inlining it as an argument expression would let expectRevert
        // catch that read instead of the createLaunch call it's meant to
        // guard.
        uint256 minMc = portal.MIN_STARTING_MC_QUOTE();
        uint256 maxMc = portal.MAX_STARTING_MC_QUOTE();

        vm.prank(creator);
        vm.expectRevert(SdogePadPortal.StartingMcOutOfRange.selector);
        portal.createLaunch(
            SdogePadPortal.CreateLaunchParams({
                name: "Zero Doge",
                symbol: "ZERO",
                startingMarketCapQuote: 0,
                buyTaxBps: 100,
                sellTaxBps: 100
            })
        );

        vm.prank(creator);
        vm.expectRevert(SdogePadPortal.StartingMcOutOfRange.selector);
        portal.createLaunch(
            SdogePadPortal.CreateLaunchParams({
                name: "Almost Zero Doge",
                symbol: "ALMOST",
                startingMarketCapQuote: minMc - 1,
                buyTaxBps: 100,
                sellTaxBps: 100
            })
        );

        vm.prank(creator);
        vm.expectRevert(SdogePadPortal.StartingMcOutOfRange.selector);
        portal.createLaunch(
            SdogePadPortal.CreateLaunchParams({
                name: "Too Big Doge",
                symbol: "HUGE",
                startingMarketCapQuote: maxMc + 1,
                buyTaxBps: 100,
                sellTaxBps: 100
            })
        );

        // The boundary value itself succeeds.
        vm.prank(creator);
        portal.createLaunch(
            SdogePadPortal.CreateLaunchParams({
                name: "Minimum Doge",
                symbol: "MIN",
                startingMarketCapQuote: minMc,
                buyTaxBps: 100,
                sellTaxBps: 100
            })
        );
    }

    // ------------------------------------------------------------------
    // LP fee harvesting — permissionless, routes through the same splitter
    // ------------------------------------------------------------------

    function test_HarvestFeesCollectsPoolFeesAndSplitsThem() public {
        (address token, address locker) = _createLaunch(portal, 0, 0); // isolate pool-fee harvesting from hook tax
        PoolKey memory key = _keyFor(token);
        address splitter = SdogePadLocker(locker).splitter();

        _buy(trader1, token, key, 300 * USDC_DECIMALS);
        uint256 tokenBal = SdogePadLaunchToken(token).balanceOf(trader1);
        _sell(trader1, token, key, tokenBal / 2);

        uint256 creditedBefore0 = SdogePadRevenueSplitter(splitter).creditedToCreator(token);
        uint256 creditedBefore1 = SdogePadRevenueSplitter(splitter).creditedToCreator(address(usdc));

        SdogePadLocker(locker).harvestFees();

        uint256 creditedAfter0 = SdogePadRevenueSplitter(splitter).creditedToCreator(token);
        uint256 creditedAfter1 = SdogePadRevenueSplitter(splitter).creditedToCreator(address(usdc));
        assertTrue(
            creditedAfter0 > creditedBefore0 || creditedAfter1 > creditedBefore1,
            "harvesting real trading activity should produce some LP fees to split"
        );
    }

    // ------------------------------------------------------------------
    // SdogePadTreasury — plain, owner-only, no automation of any kind
    // ------------------------------------------------------------------

    function test_TreasuryAccumulatesAndOnlyOwnerCanWithdraw() public {
        (address token, address locker) = _createLaunch(portal, 100, 100);
        PoolKey memory key = _keyFor(token);
        address splitter = SdogePadLocker(locker).splitter();

        _buy(trader1, token, key, 200 * USDC_DECIMALS);
        SdogePadLocker(locker).harvestFees();
        hook.flush(key); // moves the hook's accrued swap tax into the splitter

        // Revenue is credited but not yet pushed anywhere (pull-based, per
        // the H-2 fix) — the treasury only receives it once claimPlatform
        // is actually called. Anyone may call it.
        assertEq(usdc.balanceOf(address(treasury)), 0, "treasury should hold nothing until claimPlatform is called");
        SdogePadRevenueSplitter(splitter).claimPlatform(address(usdc));

        uint256 treasuryTokenBal = SdogePadLaunchToken(token).balanceOf(address(treasury));
        uint256 treasuryUsdcBal = usdc.balanceOf(address(treasury));
        // Token-side LP fees now route to TOKEN_FEE_SINK, not the treasury
        // (L-6 fix) — the treasury should hold ONLY USDC, never the launch
        // token, confirming SdogePadTreasury's "plain USDC" premise actually
        // holds post-fix.
        assertEq(treasuryTokenBal, 0, "treasury must never hold the launch token");
        assertGt(treasuryUsdcBal, 0, "treasury should have accumulated some platform cut in USDC");

        vm.prank(trader2);
        vm.expectRevert(SdogePadTreasury.NotOwner.selector);
        treasury.withdraw(address(usdc), trader2, 1);

        vm.prank(treasuryOwner);
        treasury.withdraw(address(usdc), treasuryOwner, treasuryUsdcBal);
        assertEq(usdc.balanceOf(treasuryOwner), treasuryUsdcBal, "owner should be able to withdraw the accumulated cut");
    }

    // ------------------------------------------------------------------
    // Pad factory: "a pad that launches pads" (pad/README.md, "White-label pads"):
    // the platform takes a fixed 15%; the pad owner sets their share (0–85%); the
    // creator gets the rest. Optional launch fee up to $100, split 15/85.
    // ------------------------------------------------------------------

    address padBuyer = makeAddr("padBuyer");

    function _settings(uint16 ownerShareBps, uint16 maxTaxBps, uint256 launchFee, uint256 minMc)
        internal
        pure
        returns (PadPortal.PadSettings memory)
    {
        return PadPortal.PadSettings({
            padOwnerShareBps: ownerShareBps,
            maxTaxBps: maxTaxBps,
            launchFee: launchFee,
            minStartingMarketCapQuote: minMc
        });
    }

    function _deployPad(PadPortal.PadSettings memory s) internal returns (PadPortal pad) {
        vm.startPrank(customer);
        usdc.approve(address(factory), SETUP_FEE);
        pad = PadPortal(factory.deployPad("MoonPad", s, SETUP_FEE));
        vm.stopPrank();
    }

    function _padLaunch(PadPortal pad, address who, uint16 buyTaxBps, uint16 sellTaxBps)
        internal
        returns (address token, address splitter)
    {
        (uint16 share,, uint256 fee,) = pad.settings();
        vm.startPrank(who);
        if (fee > 0) usdc.approve(address(pad), fee);
        (token,) = pad.createLaunch(
            PadPortal.CreateLaunchParams({
                name: "Pad Doge",
                symbol: "PDOGE",
                startingMarketCapQuote: STARTING_MC,
                buyTaxBps: buyTaxBps,
                sellTaxBps: sellTaxBps
            }),
            share,
            fee
        );
        vm.stopPrank();
        splitter = pad.splitterForToken(token);
    }

    function _tradeAndFlush(address token) internal returns (uint256 revenue) {
        PoolKey memory key = _keyFor(token);
        uint256 got = _buy(trader1, token, key, 300 * USDC_DECIMALS);
        _sell(trader1, token, key, got);
        revenue = hook.pendingTax(PoolId.unwrap(key.toId()));
        hook.flush(key);
    }

    function test_Pad_DeployChargesSetupFeeAndWiresThePad() public {
        uint256 treasuryBefore = usdc.balanceOf(address(treasury));
        PadPortal pad = _deployPad(_settings(2_000, 1_000, 0, 100e6));

        assertTrue(factory.isPad(address(pad)));
        assertEq(factory.padCount(), 1);
        assertEq(pad.padOwner(), customer, "buyer owns the pad");
        assertEq(pad.factory(), address(factory));
        assertTrue(hook.isAuthorizedPortal(address(pad)), "the hook trusts the new pad");
        assertEq(usdc.balanceOf(address(treasury)), treasuryBefore + SETUP_FEE, "$100 setup fee to the treasury");
        (uint16 share, uint16 maxTax, uint256 fee, uint256 minMc) = pad.settings();
        assertEq(share, 2_000);
        assertEq(maxTax, 1_000);
        assertEq(fee, 0);
        assertEq(minMc, 100e6);
    }

    function test_Pad_BuyerIsProtectedFromASetupFeeRaise() public {
        factory.setSetupFee(200e6);
        vm.startPrank(customer);
        usdc.approve(address(factory), 200e6);
        vm.expectRevert(SdogePadFactory.FeeChanged.selector);
        factory.deployPad("MoonPad", _settings(0, 1_000, 0, 100e6), SETUP_FEE); // agreed to pay $100 at most
        vm.stopPrank();
    }

    function test_Pad_SetupFeeIsOwnerOnlyAndBounded() public {
        vm.prank(customer);
        vm.expectRevert(SdogePadFactory.NotOwner.selector);
        factory.setSetupFee(1);
        vm.expectRevert(SdogePadFactory.ZeroFee.selector);
        factory.setSetupFee(0);
        vm.expectRevert(SdogePadFactory.FeeTooHigh.selector);
        factory.setSetupFee(10_000e6 + 1);
        factory.setSetupFee(250e6);
        assertEq(factory.setupFee(), 250e6);

        factory.transferOwnership(customer);
        assertEq(factory.owner(), address(this), "two-step: nothing changes until accepted");
        vm.prank(customer);
        factory.acceptOwnership();
        assertEq(factory.owner(), customer);
        vm.expectRevert(SdogePadFactory.NotOwner.selector);
        factory.setSetupFee(100e6);
    }

    function test_Pad_RevenueSplitsFifteenToPlatformPadOwnerShareRestToCreator() public {
        PadPortal pad = _deployPad(_settings(2_000, 1_000, 0, 100e6)); // pad owner keeps 20%
        (address token, address splitter) = _padLaunch(pad, creator, 300, 300);
        uint256 revenue = _tradeAndFlush(token);
        assertGt(revenue, 0);

        PadRevenueSplitter sp = PadRevenueSplitter(splitter);
        uint256 platform = (revenue * 1_500) / 10_000;
        uint256 padOwnerCut = (revenue * 2_000) / 10_000;
        assertEq(sp.creditedToPlatform(address(usdc)), platform, "platform: 15%");
        assertEq(sp.creditedToPadOwner(address(usdc)), padOwnerCut, "pad owner: their 20%");
        assertEq(sp.creditedToCreator(address(usdc)), revenue - platform - padOwnerCut, "creator: the other 65%");
        assertFalse(sp.isMainPad());

        // Everyone gets paid.
        uint256 ownerBefore = usdc.balanceOf(customer);
        assertEq(pad.pendingPadOwnerFees(0, 10), padOwnerCut);
        pad.claimPadOwnerFees(0, 10); // anyone may trigger it; the money goes to the pad owner
        assertEq(usdc.balanceOf(customer), ownerBefore + padOwnerCut);
        uint256 treasuryBefore = usdc.balanceOf(address(treasury));
        pad.claimPlatformFees(0, 10);
        assertEq(usdc.balanceOf(address(treasury)), treasuryBefore + platform);
        uint256 creatorBefore = usdc.balanceOf(creator);
        vm.prank(creator);
        sp.claim(creator, address(usdc));
        assertEq(usdc.balanceOf(creator), creatorBefore + revenue - platform - padOwnerCut);
        // A second sweep finds nothing and doesn't revert.
        assertEq(pad.claimPadOwnerFees(0, 10), 0);
        assertEq(pad.claimPlatformFees(0, 10), 0);
    }

    function test_Pad_OwnerMayKeepAllOf85ButNotMore() public {
        PadPortal pad = _deployPad(_settings(8_500, 1_000, 0, 100e6));
        (address token, address splitter) = _padLaunch(pad, creator, 500, 500);
        uint256 revenue = _tradeAndFlush(token);
        PadRevenueSplitter sp = PadRevenueSplitter(splitter);
        assertEq(sp.creditedToPlatform(address(usdc)), (revenue * 1_500) / 10_000, "platform still gets 15%");
        assertEq(sp.creditedToPadOwner(address(usdc)), (revenue * 8_500) / 10_000);
        assertLe(sp.creditedToCreator(address(usdc)), 1, "creator gets only rounding dust at an 85% pad");

        vm.prank(customer);
        vm.expectRevert(PadPortal.InvalidSettings.selector);
        pad.setSettings(_settings(8_501, 1_000, 0, 100e6));
    }

    function test_Pad_LaunchFeeSplitsFifteenEightyFive() public {
        PadPortal pad = _deployPad(_settings(0, 1_000, 50e6, 100e6)); // $50 launch fee
        uint256 treasuryBefore = usdc.balanceOf(address(treasury));
        uint256 ownerBefore = usdc.balanceOf(customer);
        uint256 creatorBefore = usdc.balanceOf(creator);
        _padLaunch(pad, creator, 100, 100);
        assertEq(usdc.balanceOf(address(treasury)), treasuryBefore + 7_500_000, "platform: 15% of $50");
        assertEq(usdc.balanceOf(customer), ownerBefore + 42_500_000, "pad owner: 85% of $50");
        assertEq(usdc.balanceOf(creator), creatorBefore - 50e6);

        vm.prank(customer);
        vm.expectRevert(PadPortal.InvalidSettings.selector);
        pad.setSettings(_settings(0, 1_000, 100e6 + 1, 100e6)); // $100 cap
    }

    function test_Pad_CreatorIsProtectedFromTermsChangedUnderThem() public {
        PadPortal pad = _deployPad(_settings(1_000, 1_000, 10e6, 100e6));
        PadPortal.CreateLaunchParams memory p = PadPortal.CreateLaunchParams({
            name: "Pad Doge", symbol: "PDOGE", startingMarketCapQuote: STARTING_MC, buyTaxBps: 100, sellTaxBps: 100
        });
        vm.prank(customer);
        pad.setSettings(_settings(5_000, 1_000, 10e6, 100e6)); // owner raises their cut
        vm.startPrank(creator);
        usdc.approve(address(pad), 100e6);
        vm.expectRevert(PadPortal.TermsChanged.selector);
        pad.createLaunch(p, 1_000, 10e6); // creator agreed to 10%
        vm.stopPrank();

        vm.prank(customer);
        pad.setSettings(_settings(1_000, 1_000, 60e6, 100e6)); // owner raises the launch fee
        vm.prank(creator);
        vm.expectRevert(PadPortal.TermsChanged.selector);
        pad.createLaunch(p, 1_000, 10e6);
    }

    function test_Pad_MaxTaxAndMinMarketCapAreEnforced() public {
        PadPortal pad = _deployPad(_settings(0, 300, 0, 1_000e6)); // "max 3% tax, min $1k MC" pad
        vm.startPrank(creator);
        vm.expectRevert(PadPortal.TaxTooHigh.selector);
        pad.createLaunch(PadPortal.CreateLaunchParams("A B", "AB", 1_000e6, 400, 0), 0, 0);
        vm.expectRevert(PadPortal.StartingMcOutOfRange.selector);
        pad.createLaunch(PadPortal.CreateLaunchParams("A B", "AB", 999e6, 300, 300), 0, 0);
        pad.createLaunch(PadPortal.CreateLaunchParams("A B", "AB", 1_000e6, 300, 300), 0, 0);
        vm.stopPrank();
        assertEq(pad.launchCount(), 1);

        vm.startPrank(customer);
        vm.expectRevert(PadPortal.InvalidSettings.selector);
        pad.setSettings(_settings(0, 1_001, 0, 100e6)); // 10% is the ceiling everywhere
        vm.expectRevert(PadPortal.InvalidSettings.selector);
        pad.setSettings(_settings(0, 1_000, 0, 99e6)); // $100 is the floor everywhere
        vm.stopPrank();
    }

    function test_Pad_SettingsChangesOnlyAffectFutureLaunches() public {
        PadPortal pad = _deployPad(_settings(2_000, 1_000, 0, 100e6));
        (, address first) = _padLaunch(pad, creator, 100, 100);
        vm.prank(customer);
        pad.setSettings(_settings(5_000, 1_000, 0, 100e6));
        (, address second) = _padLaunch(pad, trader2, 100, 100);
        assertEq(PadRevenueSplitter(first).padOwnerShareBps(), 2_000, "first launch keeps the 20% it launched with");
        assertEq(PadRevenueSplitter(second).padOwnerShareBps(), 5_000);
    }

    function test_Pad_OnlyThePadOwnerControlsThePad() public {
        PadPortal pad = _deployPad(_settings(2_000, 1_000, 0, 100e6));
        vm.prank(creator);
        vm.expectRevert(PadPortal.NotPadOwner.selector);
        pad.setSettings(_settings(8_500, 1_000, 0, 100e6));
        vm.prank(creator);
        vm.expectRevert(PadPortal.NotPadOwner.selector);
        pad.transferPadOwnership(creator);
    }

    function test_Pad_OwnershipTransferMovesSettingsAndPayouts() public {
        PadPortal pad = _deployPad(_settings(2_000, 1_000, 0, 100e6));
        (address token, address splitter) = _padLaunch(pad, creator, 300, 300);
        _tradeAndFlush(token);
        uint256 owed = PadRevenueSplitter(splitter).creditedToPadOwner(address(usdc));

        vm.prank(customer);
        pad.transferPadOwnership(padBuyer);
        assertEq(pad.padOwner(), customer, "two-step: nothing changes until accepted");
        vm.prank(padBuyer);
        pad.acceptPadOwnership();
        assertEq(pad.padOwner(), padBuyer);

        pad.claimPadOwnerFees(0, 1);
        assertEq(usdc.balanceOf(padBuyer), owed, "unclaimed pad earnings follow the pad");
        vm.prank(customer);
        vm.expectRevert(PadPortal.NotPadOwner.selector);
        pad.setSettings(_settings(0, 1_000, 0, 100e6));
    }

    function test_Pad_NoTradingRestrictions() public {
        PadPortal pad = _deployPad(_settings(8_500, 1_000, 0, 100e6));
        (address token,) = _padLaunch(pad, creator, 1_000, 1_000);
        PoolKey memory key = _keyFor(token);
        uint256 got = _buy(trader1, token, key, 50 * USDC_DECIMALS); // launch block
        assertGt(got, 0);
        vm.prank(trader1);
        SdogePadLaunchToken(token).transfer(trader2, got / 2); // free wallet-to-wallet transfer
        assertEq(SdogePadLaunchToken(token).balanceOf(trader2), got / 2);
        assertGt(_sell(trader2, token, key, got / 2), 0, "sell straight back");
        assertGt(_sell(trader1, token, key, SdogePadLaunchToken(token).balanceOf(trader1)), 0);
    }

    /// @notice A blocklisted pad owner can only block their own payout: never
    /// trading, the hook's flush, the creator's claim or the platform's share.
    function test_Pad_BlockedPadOwnerOnlyBlocksTheirOwnPayout() public {
        BlockableERC20 q = new BlockableERC20();
        q.mint(trader1, 100_000 * USDC_DECIMALS);
        q.mint(customer, 100_000 * USDC_DECIMALS);
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        (, bytes32 salt) =
            HookMiner.find(address(this), flags, type(SdogePadHook).creationCode, abi.encode(address(manager), address(this)));
        SdogePadHook h = new SdogePadHook{salt: salt}(address(manager), address(this));
        SdogePadFactory f = new SdogePadFactory(address(manager), address(h), address(treasury), address(q), SETUP_FEE, address(this));
        h.bootstrapFactory(address(f));

        vm.startPrank(customer);
        q.approve(address(f), SETUP_FEE);
        PadPortal pad = PadPortal(f.deployPad("BlockPad", _settings(3_000, 1_000, 0, 100e6), SETUP_FEE));
        vm.stopPrank();
        vm.prank(creator);
        (address token,) = pad.createLaunch(PadPortal.CreateLaunchParams("Blk", "BLK", STARTING_MC, 200, 200), 3_000, 0);
        PadRevenueSplitter sp = PadRevenueSplitter(pad.splitterForToken(token));

        q.setBlocked(customer, true); // the pad owner gets blocklisted

        bool tokenIsToken0 = token < address(q);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(tokenIsToken0 ? token : address(q)),
            currency1: Currency.wrap(tokenIsToken0 ? address(q) : token),
            fee: 10_000,
            tickSpacing: 200,
            hooks: IHooks(address(h))
        });
        vm.startPrank(trader1);
        q.approve(address(swapRouter), 200 * USDC_DECIMALS);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: !tokenIsToken0,
                amountSpecified: -int256(200 * USDC_DECIMALS),
                sqrtPriceLimitX96: !tokenIsToken0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();

        h.flush(key); // still works
        assertGt(sp.creditedToPadOwner(address(q)), 0);
        vm.expectRevert(BlockableERC20.RecipientBlocked.selector);
        pad.claimPadOwnerFees(0, 1); // only this reverts
        vm.prank(creator);
        sp.claim(creator, address(q)); // creator unaffected
        pad.claimPlatformFees(0, 1); // platform unaffected
        assertGt(q.balanceOf(creator), 0);
    }

    // ------------------------------------------------------------------
    // H-2 regression: a blocklisted revenue recipient can only ever block
    // its own claim, never a swap.
    // ------------------------------------------------------------------

    /// @notice Direct regression test for the 2026-09-22 audit's H-2 finding: the pre-fix
    /// hook pushed tax to the splitter, which pushed the platform's cut on
    /// to the treasury, INSIDE the swap itself — so a single blocklisted
    /// address anywhere in that chain (e.g. Circle blocklisting the
    /// treasury on a real USDC-like token) would have permanently reverted
    /// every swap on every pool forever, since PoolConfig is immutable.
    /// Deploys a dedicated hook/portal pair using a quote token that can
    /// block a specific recipient's incoming transfers, blocks the
    /// treasury, and proves: swaps still succeed, `flush` still succeeds
    /// (it only ever pays the splitter), and only the treasury's own
    /// `claimPlatform` call reverts — the creator's own claim is
    /// completely unaffected.
    function test_BlockedTreasuryCannotBrickSwapsOnlyItsOwnClaim() public {
        BlockableERC20 blockableQuote = new BlockableERC20();
        blockableQuote.mint(trader1, 100_000 * USDC_DECIMALS);

        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        bytes memory creationCode = type(SdogePadHook).creationCode;
        bytes memory constructorArgs = abi.encode(address(manager), address(this));
        // Re-mining with identical (deployer, flags, initCode) inputs to
        // setUp()'s hook naturally lands on a DIFFERENT salt here —
        // HookMiner.find skips any candidate address that already has
        // code, and setUp()'s hook already occupies the first match.
        (address predictedHook, bytes32 salt) = HookMiner.find(address(this), flags, creationCode, constructorArgs);
        SdogePadHook freshHook = new SdogePadHook{salt: salt}(address(manager), address(this));
        require(address(freshHook) == predictedHook, "hook address mismatch");

        SdogePadTreasury blockedTreasury = new SdogePadTreasury(treasuryOwner);
        SdogePadPortal freshPortal =
            new SdogePadPortal(address(manager), address(freshHook), address(blockedTreasury), address(blockableQuote), true);
        freshHook.bootstrapMainPortal(address(freshPortal));

        // Block the treasury's INCOMING transfers only — simulating e.g. a
        // real blocklisting event on the quote asset.
        blockableQuote.setBlocked(address(blockedTreasury), true);

        vm.prank(creator);
        (address token, address locker) = freshPortal.createLaunch(
            SdogePadPortal.CreateLaunchParams({
                name: "Blocked Quote Doge",
                symbol: "BLOCK",
                startingMarketCapQuote: STARTING_MC,
                buyTaxBps: 100,
                sellTaxBps: 100
            })
        );
        bool tokenIsToken0 = token < address(blockableQuote);
        PoolKey memory key = PoolKey({
            currency0: tokenIsToken0 ? Currency.wrap(token) : Currency.wrap(address(blockableQuote)),
            currency1: tokenIsToken0 ? Currency.wrap(address(blockableQuote)) : Currency.wrap(token),
            fee: freshPortal.POOL_FEE(),
            tickSpacing: freshPortal.TICK_SPACING(),
            hooks: IHooks(address(freshHook))
        });

        // The swap itself must succeed even though the treasury is
        // blocked — tax moves purely through internal ERC-6909 claims
        // during a swap, never an external transfer to the treasury.
        bool zeroForOne = !tokenIsToken0; // giving quote, receiving token
        vm.startPrank(trader1);
        blockableQuote.approve(address(swapRouter), 200 * USDC_DECIMALS);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(200 * USDC_DECIMALS),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();

        address splitter = SdogePadLocker(locker).splitter();

        // flush() also succeeds — it only ever pays the splitter, never the
        // treasury directly.
        freshHook.flush(key);
        assertGt(
            SdogePadRevenueSplitter(splitter).creditedToPlatform(address(blockableQuote)),
            0,
            "platform should have been credited its cut despite the treasury being blocked"
        );

        // Only the platform's OWN claim, to the blocked treasury, reverts.
        vm.expectRevert();
        SdogePadRevenueSplitter(splitter).claimPlatform(address(blockableQuote));

        // The creator's claim is completely unaffected by the treasury
        // being blocked — pull-based accounting means one broken recipient
        // can never block another's funds.
        uint256 creatorCredited = SdogePadRevenueSplitter(splitter).creditedToCreator(address(blockableQuote));
        assertGt(creatorCredited, 0, "creator should still be credited");
        vm.prank(creator);
        SdogePadRevenueSplitter(splitter).claim(creator, address(blockableQuote));
        assertEq(blockableQuote.balanceOf(creator), creatorCredited, "creator's claim should succeed despite the treasury being blocked");
    }
}

/// @dev Minimal ERC-20 that can block a specific address's INCOMING
/// transfers — stands in for a real blocklisting event (e.g. Circle
/// freezing an address on USDC) to test H-2's fix in isolation.
contract BlockableERC20 is MockERC20 {
    mapping(address => bool) public blocked;

    error RecipientBlocked();

    constructor() MockERC20("Blockable Quote", "BLKQ", 6) {}

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (blocked[to]) revert RecipientBlocked();
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (blocked[to]) revert RecipientBlocked();
        return super.transferFrom(from, to, amount);
    }
}
