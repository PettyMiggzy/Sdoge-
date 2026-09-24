// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {MemeVault} from "../src/MemeVault.sol";
import {LaunchpadBase} from "./utils/LaunchpadBase.sol";
import {FlashAttacker, InUnlockCaller} from "./utils/Actors.sol";

contract MemeVaultTest is LaunchpadBase {
    // ------------------------------------------------------------------ backing and floor

    function test_backingIsHalfAPercentOfEveryBuy_withNoClaimStep() public {
        buy(alice, 1000e6);
        buy(bob, 3000e6);
        assertEq(vault.backing(), 20e6);
        assertEq(vaultClaims(), 20e6, "held as PoolManager claims, counted at once");
    }

    function test_floorPrice_isUsdcPerWholeToken_18Decimals() public {
        buy(alice, 100_000e6); // $500 of backing
        uint256 supply = token.totalSupply();
        assertEq(vault.floorPrice(), Math.mulDiv(500e6, 1e30, supply));
        // about $0.0000005 per token: nonzero and readable (the old floor() returned 0 here)
        assertApproxEqRel(vault.floorPrice(), 0.0000005e18, 0.001e18);
    }

    function test_quoteRedeem_andFloor_areZeroSafe() public view {
        assertEq(vault.backing(), 0);
        assertEq(vault.floorPrice(), 0);
        assertEq(vault.quoteRedeem(1e18), 0);
    }

    // ------------------------------------------------------------------ redeem

    function test_redeem_paysExactlyItsShare_burns_andTheFloorDoesNotDrop() public {
        uint256 a = buy(alice, 20_000e6);
        buy(bob, 5_000e6);
        uint256 floorBefore = vault.floorPrice();
        uint256 supplyBefore = token.totalSupply();
        uint256 expected = Math.mulDiv(a / 2, vault.backing(), vault.effectiveSupply());
        assertEq(vault.quoteRedeem(a / 2), expected);

        uint256 pay = redeem(alice, a / 2);
        assertEq(pay, expected);
        assertEq(usdc.balanceOf(alice), pay);
        assertEq(token.totalSupply(), supplyBefore - a / 2, "redeemed tokens are burned");
        assertGe(vault.floorPrice(), floorBefore, "the floor never drops on a redemption");
    }

    function test_redeem_respectsMinOut_andNeverBurnsForNothing() public {
        uint256 a = buy(alice, 1000e6);
        uint256 q = vault.quoteRedeem(a);
        vm.startPrank(alice);
        token.approve(address(vault), a);
        vm.expectRevert(abi.encodeWithSelector(MemeVault.InsufficientOutput.selector, q, q + 1));
        vault.redeem(a, q + 1, alice);
        vm.expectRevert(MemeVault.NothingToPay.selector);
        vault.redeem(1, 0, alice); // 1 wei of token is worth 0 USDC units
        vm.expectRevert(MemeVault.ZeroAddress.selector);
        vault.redeem(a, 0, address(0));
        vm.stopPrank();
        assertEq(token.balanceOf(alice), a, "nothing burned");
    }

    function test_redeem_needsAnApproval() public {
        uint256 a = buy(alice, 1000e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(vault), 0, a));
        vault.redeem(a, 0, alice);
    }

    function test_redeem_paysFromDirectUsdcFirst_thenFromClaims() public {
        uint256 a = buy(alice, 10_000e6); // 50 USDC of claims
        fund(carol, 30e6);
        vm.prank(carol);
        usdc.transfer(address(vault), 30e6); // a donation: 30 USDC held directly
        assertEq(vault.backing(), 80e6);

        uint256 pay = redeem(alice, a);
        assertEq(pay, Math.mulDiv(a, 80e6, token.totalSupply() + a));
        assertGt(pay, 30e6, "needs both sources");
        assertEq(usdc.balanceOf(address(vault)), 0, "cash spent first");
        assertEq(vaultClaims(), 80e6 - pay);
    }

    function test_redeemToAnotherAddress() public {
        uint256 a = buy(alice, 1000e6);
        vm.startPrank(alice);
        token.approve(address(vault), a);
        uint256 pay = vault.redeem(a, 0, bob);
        vm.stopPrank();
        assertEq(usdc.balanceOf(bob), pay);
    }

    function test_deadAndVaultHeldTokens_raiseTheFloorLikeBurns() public {
        uint256 a = buy(alice, 10_000e6);
        uint256 f0 = vault.floorPrice();
        vm.startPrank(alice);
        token.transfer(DEAD, a / 4);
        uint256 f1 = vault.floorPrice();
        token.transfer(address(vault), a / 4);
        uint256 f2 = vault.floorPrice();
        token.burn(a / 4);
        vm.stopPrank();
        uint256 f3 = vault.floorPrice();
        assertGt(f1, f0);
        assertGt(f2, f1);
        assertGt(f3, f2);
        assertEq(vault.effectiveSupply(), token.totalSupply() - 2 * (a / 4));
    }

    function test_redeemInsideAnUnlockReverts() public {
        uint256 a = buy(alice, 1000e6);
        InUnlockCaller c = new InUnlockCaller(pm);
        vm.prank(alice);
        token.transfer(address(c), a);
        c.approve(token, address(vault), a);
        vm.expectRevert(MemeVault.PoolManagerUnlocked.selector);
        c.run(address(vault), abi.encodeCall(MemeVault.redeem, (a, 0, address(c))));
    }

    function test_unlockCallback_onlyPoolManager() public {
        vm.expectRevert(MemeVault.NotPoolManager.selector);
        vault.unlockCallback(abi.encode(alice, uint256(1)));
    }

    // ------------------------------------------------------------------ LAUNCH-01 regressions

    /// The audit's drain: inside one unlock, flash-sell tokens you don't own so the old
    /// "circulating" denominator collapses, redeem, buy back. The denominator is now the token's
    /// supply, which no swap touches, so the vault quotes the same before and during the dump...
    function test_LAUNCH01_flashDumpInsideAnUnlockDoesNotMoveTheRedemptionValue() public {
        uint256 a = buy(alice, 100_000e6);
        FlashAttacker attacker = new FlashAttacker(pm, vault, key);
        fund(address(attacker), 20_000e6); // pays the round-trip fees
        attacker.attack(a * 99 / 100, 1_000_000e18, false);
        assertGt(attacker.quoteBefore(), 0);
        assertEq(attacker.quoteDuring(), attacker.quoteBefore());
    }

    /// ...and a redeem from inside any unlock is refused outright.
    function test_LAUNCH01_redeemDuringTheFlashDumpReverts() public {
        uint256 a = buy(alice, 100_000e6);
        FlashAttacker attacker = new FlashAttacker(pm, vault, key);
        fund(address(attacker), 20_000e6);
        vm.prank(alice);
        token.transfer(address(attacker), 1_000_000e18);
        vm.expectRevert(MemeVault.PoolManagerUnlocked.selector);
        attacker.attack(a * 90 / 100, 1_000_000e18, true);
    }

    /// The external-flash variant: dump in one unlock, redeem while the PoolManager is locked,
    /// buy back in another unlock, all in one transaction. The redemption still pays only the
    /// holder's fair share, exactly what it would have paid before the dump.
    function test_LAUNCH01_dumpRedeemBuyback_paysOnlyTheFairShare() public {
        uint256 a = buy(alice, 100_000e6);
        buy(bob, 1_000e6);
        address eve = makeAddr("eve");
        vm.prank(alice);
        token.transfer(eve, a);

        uint256 r = 10_000_000e18;
        uint256 fair = Math.mulDiv(r, vault.backing(), vault.effectiveSupply());

        sell(eve, a - r); // dump nearly everything into the pool
        uint256 pay = redeem(eve, r);
        assertEq(pay, fair);
    }

    // ------------------------------------------------------------------ the floor only goes up

    function testFuzz_floorNeverDecreases(uint256[16] calldata ops) public {
        address[3] memory who = [alice, bob, carol];
        uint256 last = vault.floorPrice();
        for (uint256 i; i < ops.length; ++i) {
            uint256 op = ops[i];
            address w = who[op % 3];
            uint256 kind = (op >> 8) % 5;
            uint256 bal = token.balanceOf(w);
            if (kind <= 1) {
                buy(w, bound(op >> 16, 1e6, 20_000e6));
            } else if (kind == 2 && bal > 0) {
                uint256 amt = bound(op >> 16, 1, bal);
                if (router.quoteSell(address(token), amt) > 0) sell(w, amt);
            } else if (kind == 3 && bal > 0) {
                uint256 amt = bound(op >> 16, 1, bal);
                if (vault.quoteRedeem(amt) > 0) redeem(w, amt);
            } else if (kind == 4 && bal > 0) {
                vm.prank(w);
                token.transfer(DEAD, bound(op >> 16, 1, bal));
            }
            uint256 f = vault.floorPrice();
            assertGe(f, last, "floor dropped");
            last = f;
        }
    }
}
