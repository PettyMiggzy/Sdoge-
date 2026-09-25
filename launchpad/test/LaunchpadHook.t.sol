// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolDonateTest} from "v4-core/src/test/PoolDonateTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {ImmutableState} from "v4-periphery/src/base/ImmutableState.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LaunchpadHook} from "../src/LaunchpadHook.sol";
import {LaunchpadBase} from "./utils/LaunchpadBase.sol";
import {InUnlockCaller} from "./utils/Actors.sol";

contract LaunchpadHookTest is LaunchpadBase {
    using StateLibrary for IPoolManager;

    uint256 internal constant USDC_ID = uint256(uint160(USDC));

    function wrapped(bytes4 hookFn, bytes4 err) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            hookFn,
            abi.encodeWithSelector(err),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function totalFees() internal view returns (uint256) {
        return vaultClaims() + hook.owed(creator) + hook.platformOwed();
    }

    // ------------------------------------------------------------------ fee math, all four swap shapes

    function test_exactInBuy_takes2pctOfUsdcIn_split25_25_50() public {
        uint256 out = buy(alice, 1000e6);
        assertGt(out, 0);
        assertEq(usdc.balanceOf(alice), 0, "paid exactly the 1000 USDC asked, fee included");
        assertEq(vaultClaims(), 5e6, "0.5% to the vault");
        assertEq(hook.owed(creator), 5e6, "0.5% to the creator");
        assertEq(hook.platformOwed(), 10e6, "1% to the platform");
        assertEq(pm.balanceOf(address(hook), USDC_ID), 15e6, "the hook holds claims for creator + platform");
        assertEq(usdc.balanceOf(address(pm)), 1000e6, "fees stay inside the PoolManager as claims");
    }

    function test_exactOutBuy_feeIs2pctOfEverythingPaid() public {
        fund(alice, 5000e6);
        uint256 before = usdc.balanceOf(alice);
        BalanceDelta d = rawSwap(alice, true, int256(50_000_000e18), maxLimit(true));
        uint256 paid = before - usdc.balanceOf(alice);
        assertEq(int256(d.amount1()), int256(50_000_000e18), "got exactly the tokens asked for");
        uint256 fee = totalFees();
        assertEq(fee, Math.mulDiv(paid - fee, 200, 9800, Math.Rounding.Ceil));
        assertApproxEqAbs(fee * 10_000, paid * 200, 10_000, "2.00% of the total paid, not 1.96%");
    }

    function test_exactInSell_takes2pctOfUsdcOut_allToPlatform() public {
        uint256 tokens = buy(alice, 1000e6);
        uint256 platformBefore = hook.platformOwed();
        uint256 vaultBefore = vaultClaims();
        uint256 got = sell(alice, tokens / 2);
        uint256 fee = hook.platformOwed() - platformBefore;
        assertEq(fee, (got + fee) * 200 / 10_000);
        assertEq(vaultClaims(), vaultBefore, "sells don't feed the vault");
    }

    function test_exactOutSell_sellerGetsExactlyTheAmountAsked() public {
        buy(alice, 1000e6);
        uint256 before = usdc.balanceOf(alice);
        uint256 platformBefore = hook.platformOwed();
        rawSwap(alice, false, int256(100e6), maxLimit(false));
        assertEq(usdc.balanceOf(alice) - before, 100e6);
        assertEq(hook.platformOwed() - platformBefore, Math.mulDiv(100e6, 200, 9800, Math.Rounding.Ceil));
    }

    function test_exactInBuy_mustFillCompletely() public {
        fund(alice, 1000e6);
        uint160 limit = uint160(uint256(sqrtPrice()) * 9_999 / 10_000); // stops the swap almost at once
        vm.expectRevert(wrapped(IHooks.afterSwap.selector, LaunchpadHook.PartialFill.selector));
        rawSwap(alice, true, -int256(1000e6), limit);
    }

    function test_exactOutSell_mustFillCompletely() public {
        buy(alice, 100e6);
        // asks for more USDC than the pool holds
        vm.expectRevert();
        rawSwap(alice, false, int256(500e6), maxLimit(false));
    }

    // ------------------------------------------------------------------ price and pool guards

    function test_nobodyCanPushThePriceAboveLaunch() public {
        // Right after launch there's no liquidity above the price. A 1-wei sell used to jump it to
        // MAX_SQRT_PRICE for free.
        vm.expectRevert(wrapped(IHooks.afterSwap.selector, LaunchpadHook.PriceAboveStart.selector));
        rawSwap(alice, false, -1, maxLimit(false));
        assertEq(sqrtPrice(), factory.startSqrtPriceX96());
    }

    function test_sellingEveryBoughtTokenBack_worksAndEndsAtOrBelowLaunch() public {
        uint256 a = buy(alice, 500e6);
        uint256 b = buy(bob, 300e6);
        uint256 c = buy(carol, 7e6);
        sell(bob, b);
        sell(carol, c);
        sell(alice, a);
        assertLe(sqrtPrice(), factory.startSqrtPriceX96());
        assertEq(token.balanceOf(alice) + token.balanceOf(bob) + token.balanceOf(carol), 0);
    }

    function test_cannotSellMoreThanThePoolCanTake() public {
        uint256 a = buy(alice, 500e6);
        vm.prank(alice);
        token.transfer(bob, a);
        // flash-sell more than ever left the pool: bob has a, and tries a + 1
        vm.expectRevert();
        rawSwap(bob, false, -int256(a + 1), maxLimit(false));
    }

    function test_donationsBlocked() public {
        PoolDonateTest donor = new PoolDonateTest(pm);
        fund(alice, 10e6);
        vm.startPrank(alice);
        usdc.approve(address(donor), type(uint256).max);
        vm.expectRevert(wrapped(IHooks.beforeDonate.selector, LaunchpadHook.DonationsDisabled.selector));
        donor.donate(key, 10e6, 0, "");
        vm.stopPrank();
    }

    function test_onlyTheFactoryAddsLiquidity() public {
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(pm);
        vm.expectRevert(wrapped(IHooks.beforeAddLiquidity.selector, LaunchpadHook.NotFactory.selector));
        lp.modifyLiquidity(key, ModifyLiquidityParams(-887_220, 398_400, 1e18, 0), "");
    }

    function test_onlyTheFactoryCreatesPoolsWithThisHook() public {
        PoolKey memory k = key;
        k.tickSpacing = 120;
        uint160 start = factory.startSqrtPriceX96();
        vm.expectRevert(wrapped(IHooks.beforeInitialize.selector, LaunchpadHook.NotFactory.selector));
        pm.initialize(k, start);
    }

    function test_registerOnlyByFactory() public {
        vm.expectRevert(LaunchpadHook.NotFactory.selector);
        hook.register(key, alice, alice);
        vm.prank(address(factory));
        vm.expectRevert(LaunchpadHook.AlreadyRegistered.selector);
        hook.register(key, alice, alice);
    }

    function test_hookAddressCarriesExactlyItsFlags() public view {
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, FLAGS);
        assertEq(hook.factory(), address(factory));
    }

    // ------------------------------------------------------------------ claims

    function test_claims_payCreatorAndPlatform_inUsdc_fullyBacked() public {
        buy(alice, 1000e6);
        buy(bob, 1000e6);
        assertEq(hook.owed(creator), 10e6);
        assertEq(hook.platformOwed(), 20e6);

        vm.prank(carol); // anyone may trigger it; the money only goes to the creator
        assertEq(hook.claim(creator), 10e6);
        assertEq(usdc.balanceOf(creator), 10e6);
        assertEq(hook.owed(creator), 0);
        assertEq(hook.claim(creator), 0);

        vm.prank(carol);
        vm.expectRevert(LaunchpadHook.NotOwner.selector); // only the factory's owner pays the platform out
        hook.claimPlatform();
        vm.prank(owner);
        assertEq(hook.claimPlatform(), 20e6);
        assertEq(usdc.balanceOf(feeRecipient), 20e6);
        assertEq(pm.balanceOf(address(hook), USDC_ID), 0, "every claim was backed");
    }

    function test_platformFeesGoToTheCurrentRecipient() public {
        buy(alice, 1000e6);
        vm.prank(owner);
        factory.setFeeRecipient(carol);
        vm.prank(owner);
        hook.claimPlatform();
        assertEq(usdc.balanceOf(carol), 10e6);
        assertEq(usdc.balanceOf(feeRecipient), 0);
    }

    function test_claimInsideAnUnlockReverts() public {
        buy(alice, 1000e6);
        InUnlockCaller c = new InUnlockCaller(pm);
        vm.expectRevert(IPoolManager.AlreadyUnlocked.selector);
        c.run(address(hook), abi.encodeCall(LaunchpadHook.claim, (creator)));
    }

    function test_transferCreator_isTwoStep_andOnlyMovesFutureFees() public {
        vm.prank(alice);
        vm.expectRevert(LaunchpadHook.NotCreator.selector);
        hook.transferCreator(id, alice);

        vm.prank(creator);
        hook.transferCreator(id, alice);
        vm.prank(bob);
        vm.expectRevert(LaunchpadHook.NotPendingCreator.selector);
        hook.acceptCreator(id);

        buy(bob, 1000e6);
        assertEq(hook.owed(creator), 5e6, "not accepted yet");
        vm.prank(alice);
        hook.acceptCreator(id);
        buy(bob, 1000e6);
        assertEq(hook.owed(alice), 5e6);
        assertEq(hook.owed(creator), 5e6, "what the old creator earned stays theirs");
        (address c,,) = hook.pools(id);
        assertEq(c, alice);
    }

    function test_unlockCallback_onlyPoolManager() public {
        vm.expectRevert(ImmutableState.NotPoolManager.selector);
        hook.unlockCallback(abi.encode(alice, uint256(1)));
    }
}
