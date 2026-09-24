// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {LaunchpadRouter} from "../src/LaunchpadRouter.sol";
import {LaunchpadFactory} from "../src/LaunchpadFactory.sol";
import {LaunchpadHook} from "../src/LaunchpadHook.sol";
import {LaunchpadBase} from "./utils/LaunchpadBase.sol";

contract LaunchpadRouterTest is LaunchpadBase {
    function test_quoteBuy_equalsTheRealBuy() public {
        uint256 q = router.quoteBuy(address(token), 750e6);
        assertEq(buy(alice, 750e6), q);
    }

    function test_quoteSell_equalsTheRealSell() public {
        uint256 a = buy(alice, 750e6);
        uint256 q = router.quoteSell(address(token), a / 3);
        assertEq(sell(alice, a / 3), q);
    }

    function test_quotesChangeNothing() public {
        uint160 p = sqrtPrice();
        router.quoteBuy(address(token), 1000e6);
        assertEq(sqrtPrice(), p);
        assertEq(vault.backing(), 0);
    }

    function test_buyWithNative_isOneTransaction_andLeavesNothingBehind() public {
        uint256 q = router.quoteBuy(address(token), 100e6);
        vm.deal(alice, 100e18);
        vm.prank(alice);
        uint256 out = router.buyWithNative{value: 100e18}(address(token), q, alice, block.timestamp);
        assertEq(out, q);
        assertEq(token.balanceOf(alice), q);
        assertEq(alice.balance, 0);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(token.balanceOf(address(router)), 0);
    }

    function test_buyWithNative_rejectsValueThatIsNotWholeUsdcUnits() public {
        vm.deal(alice, 2e18);
        vm.prank(alice);
        vm.expectRevert(LaunchpadRouter.BadNativeAmount.selector);
        router.buyWithNative{value: 1e18 + 1}(address(token), 0, alice, block.timestamp);
    }

    function test_buy_sell_sendOutputToAnotherAddress() public {
        fund(alice, 100e6);
        vm.startPrank(alice);
        usdc.approve(address(router), 100e6);
        uint256 out = router.buy(address(token), 100e6, 1, bob, block.timestamp);
        vm.stopPrank();
        assertEq(token.balanceOf(bob), out);
        assertEq(token.balanceOf(alice), 0);

        vm.startPrank(bob);
        token.approve(address(router), out);
        uint256 got = router.sell(address(token), out, 1, carol, block.timestamp);
        vm.stopPrank();
        assertEq(usdc.balanceOf(carol), got);
    }

    function test_minOut_deadline_amount_andRecipientChecks() public {
        fund(alice, 100e6);
        uint256 q = router.quoteBuy(address(token), 100e6);
        vm.startPrank(alice);
        usdc.approve(address(router), 100e6);
        vm.expectRevert(abi.encodeWithSelector(LaunchpadRouter.InsufficientOutput.selector, q, q + 1));
        router.buy(address(token), 100e6, q + 1, alice, block.timestamp);
        vm.expectRevert(LaunchpadRouter.Expired.selector);
        router.buy(address(token), 100e6, 0, alice, block.timestamp - 1);
        vm.expectRevert(LaunchpadRouter.BadAmount.selector);
        router.buy(address(token), 0, 0, alice, block.timestamp);
        vm.expectRevert(LaunchpadRouter.ZeroAddress.selector);
        router.buy(address(token), 100e6, 0, address(0), block.timestamp);
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), 100e6, "nothing spent");
    }

    function test_onlyTokensTheFactoryLaunched() public {
        vm.expectRevert(LaunchpadFactory.UnknownToken.selector);
        router.quoteBuy(USDC, 1e6);
        fund(alice, 1e6);
        vm.startPrank(alice);
        usdc.approve(address(router), 1e6);
        vm.expectRevert(LaunchpadFactory.UnknownToken.selector);
        router.buy(alice, 1e6, 0, alice, block.timestamp);
        vm.stopPrank();
    }

    function test_cantSellMoreThanEverLeftThePool() public {
        uint256 a = buy(alice, 100e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.afterSwap.selector,
                abi.encodeWithSelector(LaunchpadHook.PriceAboveStart.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        router.quoteSell(address(token), a + 1e18);
    }

    function test_unlockCallback_onlyPoolManager() public {
        vm.expectRevert(LaunchpadRouter.NotPoolManager.selector);
        router.unlockCallback("");
    }

    function test_approvalsAreExact_theRouterCantSpendMore() public {
        fund(alice, 200e6);
        vm.startPrank(alice);
        usdc.approve(address(router), 100e6);
        router.buy(address(token), 100e6, 1, alice, block.timestamp);
        vm.expectRevert(); // allowance used up
        router.buy(address(token), 100e6, 1, alice, block.timestamp);
        vm.stopPrank();
        assertEq(usdc.allowance(alice, address(router)), 0);
    }
}
