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
import {NoReceive} from "./utils/Actors.sol";

/// Runs the real deploy script against a PoolManager at Arc's address, with a multisig-style
/// owner and a fee recipient that is a contract without receive() (like the fee splitter).
contract DeployScriptTest is Test {
    function test_deployScript_endToEnd() public {
        Deploy script = new Deploy();
        vm.etch(script.USDC(), address(new ArcUsdcMock()).code);
        deployCodeTo("out/PoolManager.sol/PoolManager.json", abi.encode(address(this)), script.POOL_MANAGER());

        address multisig = makeAddr("multisig");
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
        factory.withdrawLaunchFees();
        factory.hook().claimPlatform();
        assertEq(IERC20(script.USDC()).balanceOf(splitter), 2e6 + 1e6, "launch fee + 1% platform share of the buy");
    }

    function test_deployScript_requiresBothAddresses() public {
        Deploy script = new Deploy();
        vm.setEnv("LAUNCHPAD_OWNER", vm.toString(address(0)));
        vm.setEnv("FEE_RECIPIENT", vm.toString(makeAddr("r")));
        vm.expectRevert("set LAUNCHPAD_OWNER and FEE_RECIPIENT");
        script.run();
    }
}
