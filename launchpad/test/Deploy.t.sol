// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {LaunchpadFactory} from "../src/LaunchpadFactory.sol";
import {LaunchpadRouter} from "../src/LaunchpadRouter.sol";
import {ArcUsdcMock} from "./utils/ArcUsdcMock.sol";
import {NoReceive, SafeLike} from "./utils/Actors.sol";

/// Runs the real deploy script against a PoolManager at Arc's address, with a Safe-like 2-of-3
/// owner and a fee recipient that is a contract without receive() (like the fee splitter).
contract DeployScriptTest is Test {
    Deploy script;

    function setUp() public {
        vm.chainId(5042);
        script = new Deploy();
        vm.etch(script.USDC(), address(new ArcUsdcMock()).code);
        deployCodeTo("out/PoolManager.sol/PoolManager.json", abi.encode(address(this)), script.POOL_MANAGER());
    }

    function safe(uint256 threshold, uint256 signers) internal returns (address) {
        address[] memory owners = new address[](signers);
        for (uint256 i = 0; i < signers; i++) {
            owners[i] = address(uint160(0x5000 + i));
        }
        return address(new SafeLike(threshold, owners));
    }

    function setAdmin(address owner, address recipient) internal {
        vm.setEnv("LAUNCHPAD_OWNER", vm.toString(owner));
        vm.setEnv("FEE_RECIPIENT", vm.toString(recipient));
    }

    function test_deployScript_endToEnd() public {
        address multisig = safe(2, 3);
        address splitter = address(new NoReceive());
        vm.setEnv("LAUNCHPAD_OWNER", vm.toString(multisig));
        vm.setEnv("FEE_RECIPIENT", vm.toString(splitter));

        (LaunchpadFactory factory, LaunchpadRouter router) = script.run();

        assertEq(factory.owner(), multisig, "owned by the multisig from the start");
        assertEq(factory.feeRecipient(), splitter);
        assertEq(factory.hook().factory(), address(factory));
        assertEq(uint160(address(factory.hook())) & Hooks.ALL_HOOK_MASK, script.HOOK_FLAGS());
        assertEq(address(router.factory()), address(factory));

        // and it works: launch, buy, collect fees
        address user = makeAddr("user");
        vm.deal(user, 102e18);
        vm.startPrank(user);
        (address token,,) = factory.launch{value: 2e18}("Deploy Doge", "DDOGE", "");
        uint256 out = router.buyWithNative{value: 100e18}(token, 1, user, block.timestamp);
        vm.stopPrank();
        assertGt(out, 0);
        vm.startPrank(multisig);
        factory.withdrawLaunchFees();
        factory.hook().claimPlatform();
        vm.stopPrank();
        assertEq(IERC20(script.USDC()).balanceOf(splitter), 2e6 + 1e6, "launch fee + 1% platform share of the buy");
    }

    function test_deployScript_requiresBothAddresses() public {
        setAdmin(address(0), makeAddr("r"));
        vm.expectRevert("set LAUNCHPAD_OWNER and FEE_RECIPIENT");
        script.run();
    }

    function test_deployScript_onlyOnArc() public {
        vm.chainId(1);
        setAdmin(safe(2, 3), makeAddr("r"));
        vm.expectRevert("not Arc mainnet (chain 5042)");
        script.run();
    }

    function test_deployScript_ownerMustBeARealSafe() public {
        address r = makeAddr("r");
        setAdmin(makeAddr("eoa"), r);
        vm.expectRevert("LAUNCHPAD_OWNER has no code here: deploy the Safe on this chain first");
        script.run();

        address delegated = makeAddr("delegated");
        vm.etch(delegated, abi.encodePacked(hex"ef0100", address(new NoReceive())));
        setAdmin(delegated, r);
        vm.expectRevert("LAUNCHPAD_OWNER is an EIP-7702-delegated EOA, not a Safe");
        script.run();

        setAdmin(address(new NoReceive()), r);
        vm.expectRevert("LAUNCHPAD_OWNER isn't a Safe (no getThreshold)");
        script.run();

        setAdmin(safe(1, 3), r);
        vm.expectRevert("LAUNCHPAD_OWNER must be a Safe with threshold 2 or more");
        script.run();

        setAdmin(safe(2, 1), r);
        vm.expectRevert("LAUNCHPAD_OWNER must be a Safe with threshold 2 or more");
        script.run();
    }

    function test_deployScript_ownerIsNotTheBroadcaster() public {
        // the default broadcaster, given code so only the "is the broadcaster" check can trip
        address broadcaster = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;
        vm.etch(broadcaster, address(new NoReceive()).code);
        setAdmin(broadcaster, makeAddr("r"));
        vm.expectRevert("LAUNCHPAD_OWNER is the broadcaster: use the Safe");
        script.run();
    }

    function test_deployScript_feeRecipientMustKeepTheFees() public {
        address multisig = safe(2, 3);
        string memory lost = "FEE_RECIPIENT would lose the fees (dead, USDC, the PoolManager or a system address)";
        address[4] memory bad =
            [address(0xdEaD), script.USDC(), script.POOL_MANAGER(), address(0x0000000000000000000000000000000000000004)];
        for (uint256 i = 0; i < bad.length; i++) {
            setAdmin(multisig, bad[i]);
            vm.expectRevert(bytes(lost));
            script.run();
        }
    }
}
