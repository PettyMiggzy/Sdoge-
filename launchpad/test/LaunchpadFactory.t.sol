// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {LaunchpadFactory} from "../src/LaunchpadFactory.sol";
import {LaunchpadHook} from "../src/LaunchpadHook.sol";
import {MemeVault} from "../src/MemeVault.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {LaunchpadBase} from "./utils/LaunchpadBase.sol";
import {NoReceive} from "./utils/Actors.sol";

contract LaunchpadFactoryTest is LaunchpadBase {
    using StateLibrary for IPoolManager;

    function test_launch_putsWholeSupplyInOnePoolAtTheStartPrice() public view {
        assertGt(uint160(address(token)), uint160(USDC), "token must sort above USDC");
        assertEq(factory.startTick(), 398_400, "nearest usable tick to the $5k price");
        assertEq(sqrtPrice(), factory.startSqrtPriceX96());
        assertEq(sqrtPrice(), TickMath.getSqrtPriceAtTick(398_400));

        // Everything that exists is in the PoolManager; the rounding dust was burned.
        uint256 supply = token.totalSupply();
        assertEq(token.balanceOf(address(pm)), supply);
        assertEq(token.balanceOf(address(factory)), 0);
        assertLe(factory.SUPPLY() - supply, 1e12, "only dust burned (< 0.000001 token)");
        assertEq(pm.getLiquidity(id), 0, "the price sits on the position's upper bound");

        (address c, address v, uint160 start) = hook.pools(id);
        assertEq(c, creator);
        assertEq(v, address(vault));
        assertEq(start, factory.startSqrtPriceX96());
        assertEq(vault.backing(), 0);
        assertEq(address(vault.token()), address(token));

        LaunchpadFactory.Launch memory l = factory.launchOf(address(token));
        assertEq(l.token, address(token));
        assertEq(l.vault, address(vault));
        assertEq(l.creator, creator);
        assertEq(PoolId.unwrap(l.poolId), PoolId.unwrap(id));
        assertEq(factory.launchCount(), 1);
    }

    function test_startValuation_isAbout5k() public view {
        // virtual USDC = SUPPLY / price, price = (sqrtP / 2^96)^2 token-wei per USDC unit
        uint256 p = uint256(factory.startSqrtPriceX96());
        uint256 virtualUsdc = (factory.SUPPLY() << 96) / p * (1 << 96) / p;
        assertApproxEqRel(virtualUsdc, 4_995.40e6, 0.0001e18);
    }

    function test_launch_emitsEventTheBotIndexes() public {
        vm.deal(alice, 2e18);
        vm.recordLogs();
        vm.prank(alice);
        (address t, address v, PoolId pid) = factory.launch{value: 2e18}("Moon Doge", "MOON", "");
        bytes32 sig = keccak256("Launched(uint256,bytes32,address,address,address,string,string,string)");
        bool found;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(factory) && logs[i].topics[0] == sig) {
                found = true;
                assertEq(uint256(logs[i].topics[1]), 1);
                assertEq(logs[i].topics[2], PoolId.unwrap(pid));
                (address et, address ev, address ec, string memory n, string memory s,) =
                    abi.decode(logs[i].data, (address, address, address, string, string, string));
                assertEq(et, t);
                assertEq(ev, v);
                assertEq(ec, alice);
                assertEq(n, "Moon Doge");
                assertEq(s, "MOON");
            }
        }
        assertTrue(found);
    }

    function test_launch_requiresTheExactFee() public {
        vm.deal(alice, 10e18);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(LaunchpadFactory.WrongLaunchFee.selector, 1e18, 2e18));
        factory.launch{value: 1e18}("A", "A", "");
        vm.expectRevert(abi.encodeWithSelector(LaunchpadFactory.WrongLaunchFee.selector, 3e18, 2e18));
        factory.launch{value: 3e18}("A", "A", "");
        vm.stopPrank();
    }

    function test_launch_validatesMetadata() public {
        vm.deal(alice, 100e18);
        vm.startPrank(alice);
        vm.expectRevert(LaunchpadFactory.BadName.selector);
        factory.launch{value: 2e18}("", "A", "");
        vm.expectRevert(LaunchpadFactory.BadName.selector);
        factory.launch{value: 2e18}("123456789012345678901234567890123", "A", ""); // 33 bytes
        vm.expectRevert(LaunchpadFactory.BadName.selector);
        factory.launch{value: 2e18}(unicode"Dogé", "A", "");
        vm.expectRevert(LaunchpadFactory.BadName.selector);
        factory.launch{value: 2e18}("Doge\x00", "A", "");
        vm.expectRevert(LaunchpadFactory.BadName.selector);
        factory.launch{value: 2e18}(string(hex"446f6765e280ae"), "A", ""); // "Doge" + U+202E right-to-left override
        vm.expectRevert(LaunchpadFactory.BadSymbol.selector);
        factory.launch{value: 2e18}("Doge", "", "");
        vm.expectRevert(LaunchpadFactory.BadSymbol.selector);
        factory.launch{value: 2e18}("Doge", "DOGE COIN", "");
        vm.expectRevert(LaunchpadFactory.BadSymbol.selector);
        factory.launch{value: 2e18}("Doge", "$DOGE", "");
        vm.expectRevert(LaunchpadFactory.BadSymbol.selector);
        factory.launch{value: 2e18}("Doge", "ABCDEFGHIJK", ""); // 11 bytes
        vm.expectRevert(LaunchpadFactory.BadUri.selector);
        factory.launch{value: 2e18}("Doge", "DOGE", "ipfs://has space");
        vm.expectRevert(LaunchpadFactory.BadUri.selector);
        factory.launch{value: 2e18}("Doge", "DOGE", string(new bytes(257)));
        // the widest valid inputs
        factory.launch{value: 2e18}("12345678901234567890123456789012", "ABCDEFGHIJ", "ipfs://bafy");
        vm.stopPrank();
    }

    function test_launchFees_accrueThenGoToFeeRecipient_evenAContractWithoutReceive() public {
        NoReceive splitter = new NoReceive();
        vm.prank(owner);
        factory.setFeeRecipient(address(splitter));

        launchAs(alice, "B", "B");
        launchAs(bob, "C", "C");
        assertEq(address(factory).balance, 6e18, "three launch fees held");
        assertEq(usdc.balanceOf(address(factory)), 6e6);

        vm.prank(carol); // only the owner pays them out, so a recipient being rotated out can't race it
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, carol));
        factory.withdrawLaunchFees();
        vm.startPrank(owner);
        assertEq(factory.withdrawLaunchFees(), 6e6);
        assertEq(usdc.balanceOf(address(splitter)), 6e6);
        assertEq(usdc.balanceOf(address(factory)), 0);
        assertEq(factory.withdrawLaunchFees(), 0);
        vm.stopPrank();
    }

    function test_setLaunchFee_boundsCatchTheSixDecimalMistake() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(LaunchpadFactory.LaunchFeeOutOfRange.selector, 2e6));
        factory.setLaunchFee(2e6);
        vm.expectRevert(abi.encodeWithSelector(LaunchpadFactory.LaunchFeeOutOfRange.selector, 101e18));
        factory.setLaunchFee(101e18);
        factory.setLaunchFee(0);
        assertEq(factory.launchFee(), 0);
        factory.setLaunchFee(0.01e18);
        factory.setLaunchFee(100e18);
        vm.stopPrank();

        vm.deal(alice, 100e18);
        vm.prank(alice);
        factory.launch{value: 100e18}("D", "D", "");
    }

    function test_freeLaunchWhenFeeIsZero() public {
        vm.prank(owner);
        factory.setLaunchFee(0);
        vm.prank(alice);
        factory.launch("Free", "FREE", "");
        assertEq(factory.launchCount(), 2);
    }

    function test_admin_onlyOwner_twoStep_noRenounce_noZeroRecipient() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        factory.setLaunchFee(1e18);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        factory.setFeeRecipient(alice);

        vm.startPrank(owner);
        vm.expectRevert(LaunchpadFactory.ZeroAddress.selector);
        factory.setFeeRecipient(address(0));
        vm.expectRevert(LaunchpadFactory.RenounceDisabled.selector);
        factory.renounceOwnership();
        factory.transferOwnership(alice);
        vm.stopPrank();
        assertEq(factory.owner(), owner, "two-step: nothing changes until accepted");
        vm.prank(alice);
        factory.acceptOwnership();
        assertEq(factory.owner(), alice);
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new LaunchpadFactory(pm, address(0), feeRecipient, bytes32(0));
        vm.expectRevert(LaunchpadFactory.ZeroAddress.selector);
        new LaunchpadFactory(pm, owner, address(0), bytes32(0));
    }

    function test_constructor_rejectsAHookSaltWithTheWrongFlags() public {
        // salt 0 is (overwhelmingly likely) not a valid hook address; BaseHook refuses to deploy there
        vm.expectRevert();
        new LaunchpadFactory(pm, owner, feeRecipient, bytes32(uint256(1)));
    }

    function test_views_unknownTokenReverts() public {
        vm.expectRevert(LaunchpadFactory.UnknownToken.selector);
        factory.poolKeyOf(alice);
        vm.expectRevert(LaunchpadFactory.UnknownToken.selector);
        factory.launchOf(alice);
    }

    function test_unlockCallback_onlyPoolManager() public {
        vm.expectRevert(LaunchpadFactory.NotPoolManager.selector);
        factory.unlockCallback(abi.encode(key));
    }

    function test_manyLaunches_allSortAboveUsdc() public {
        for (uint256 i; i < 25; ++i) {
            (LaunchToken t,,) = launchAs(address(uint160(0x1000 + i)), "X", "X");
            assertGt(uint160(address(t)), uint160(USDC));
        }
    }
}
