// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LaunchpadFactory} from "../../src/LaunchpadFactory.sol";
import {LaunchpadHook} from "../../src/LaunchpadHook.sol";
import {LaunchpadRouter} from "../../src/LaunchpadRouter.sol";
import {MemeVault} from "../../src/MemeVault.sol";
import {LaunchToken} from "../../src/LaunchToken.sol";
import {ArcUsdcMock} from "./ArcUsdcMock.sol";

/// A real v4 PoolManager, Arc-style native-backed USDC at 0x3600...0000, the factory (which
/// deploys the hook at a mined address), the router, and one launched token ready to trade.
abstract contract LaunchpadBase is Test {
    using StateLibrary for IPoolManager;

    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_DONATE_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    IERC20 internal usdc = IERC20(USDC);
    IPoolManager internal pm;
    LaunchpadFactory internal factory;
    LaunchpadHook internal hook;
    LaunchpadRouter internal router;
    PoolSwapTest internal swapper;

    address internal owner = makeAddr("owner");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    LaunchToken internal token;
    MemeVault internal vault;
    PoolKey internal key;
    PoolId internal id;

    function setUp() public virtual {
        vm.etch(USDC, address(new ArcUsdcMock()).code);
        pm = IPoolManager(deployCode("out/PoolManager.sol/PoolManager.json", abi.encode(address(this))));

        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        factory = new LaunchpadFactory(pm, owner, feeRecipient, mineHookSalt(predicted, address(pm)));
        assertEq(address(factory), predicted, "factory address");
        hook = factory.hook();
        router = new LaunchpadRouter(pm, factory);
        swapper = new PoolSwapTest(pm);

        (token, vault, id) = launchAs(creator, "Cap Doge", "CAPD");
        key = factory.poolKeyOf(address(token));
        approveSwapper(alice);
        approveSwapper(bob);
        approveSwapper(carol);
    }

    // ------------------------------------------------------------------ helpers

    function mineHookSalt(address deployer, address poolManager) internal view returns (bytes32) {
        bytes32 initHash = keccak256(abi.encodePacked(type(LaunchpadHook).creationCode, abi.encode(poolManager)));
        for (uint256 s; s < 1_000_000; ++s) {
            address a = vm.computeCreate2Address(bytes32(s), initHash, deployer);
            if (uint160(a) & Hooks.ALL_HOOK_MASK == FLAGS && a.code.length == 0) return bytes32(s);
        }
        revert("no hook salt");
    }

    function launchAs(address who, string memory name, string memory symbol)
        internal
        returns (LaunchToken t, MemeVault v, PoolId pid)
    {
        uint256 fee = factory.launchFee();
        vm.deal(who, who.balance + fee);
        vm.prank(who);
        (address ta, address va, PoolId p) = factory.launch{value: fee}(name, symbol, "ipfs://cap");
        return (LaunchToken(ta), MemeVault(va), p);
    }

    /// Gives `who` `amount` USDC (6 decimals), as native balance like on Arc.
    function fund(address who, uint256 amount) internal {
        vm.deal(who, who.balance + amount * 1e12);
    }

    function buy(address who, uint256 usdcIn) internal returns (uint256 out) {
        fund(who, usdcIn);
        vm.startPrank(who);
        usdc.approve(address(router), usdcIn);
        out = router.buy(address(token), usdcIn, 1, who, block.timestamp);
        vm.stopPrank();
    }

    function sell(address who, uint256 tokensIn) internal returns (uint256 out) {
        vm.startPrank(who);
        token.approve(address(router), tokensIn);
        out = router.sell(address(token), tokensIn, 1, who, block.timestamp);
        vm.stopPrank();
    }

    function redeem(address who, uint256 amount) internal returns (uint256 pay) {
        vm.startPrank(who);
        token.approve(address(vault), amount);
        pay = vault.redeem(amount, 0, who);
        vm.stopPrank();
    }

    /// Any swap shape through v4-core's PoolSwapTest; `who` pays and receives. Approvals happen
    /// first (approveSwapper), so a vm.expectRevert placed before rawSwap sees the swap itself.
    function approveSwapper(address who) internal {
        vm.startPrank(who);
        usdc.approve(address(swapper), type(uint256).max);
        token.approve(address(swapper), type(uint256).max);
        vm.stopPrank();
    }

    function rawSwap(address who, bool zeroForOne, int256 amountSpecified, uint160 limit)
        internal
        returns (BalanceDelta d)
    {
        vm.prank(who);
        d = swapper.swap(
            key,
            SwapParams(zeroForOne, amountSpecified, limit),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function maxLimit(bool zeroForOne) internal pure returns (uint160) {
        return zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
    }

    function vaultClaims() internal view returns (uint256) {
        return pm.balanceOf(address(vault), uint256(uint160(USDC)));
    }

    function sqrtPrice() internal view returns (uint160 p) {
        (p,,,) = pm.getSlot0(id);
    }
}
