// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {SdogePadPortal} from "../src/SdogePadPortal.sol";
import {SdogePadHook} from "../src/SdogePadHook.sol";
import {SdogePadRevenueSplitter} from "../src/SdogePadRevenueSplitter.sol";
import {SdogePadLocker} from "../src/SdogePadLocker.sol";
import {SdogePadFactory} from "../src/SdogePadFactory.sol";
import {SdogePadTreasury} from "../src/SdogePadTreasury.sol";

/// @notice The whole stack against Arc's REAL PoolManager and USDC, on a
/// fork. Skipped unless ARC_FORK_URL is set, e.g.
///   ARC_FORK_URL=https://arc-mainnet.g.alchemy.com/v2/<key> forge test --match-contract ForkArcTest -vv
/// Arc USDC is special: native gas and ERC-20 at 0x3600…, one balance
/// (18 decimals native, 6 via ERC-20), so vm.deal funds a trader.
contract ForkArcTest is Test {
    using PoolIdLibrary for PoolKey;

    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant USDC = 0x3600000000000000000000000000000000000000;
    uint160 constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    function test_FullLaunchLifecycleOnRealArcState() public {
        string memory url = vm.envOr("ARC_FORK_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
        // Foundry's EVM doesn't implement Arc's native-USDC precompiles, so
        // stand in for the two the USDC contract calls. Behavior copied from
        // a real mainnet trace: isBlocklisted(address) -> false;
        // transfer(from, to, amount) moves `amount` of the native balance
        // (18 decimals) and returns true.
        vm.etch(address(0x1800000000000000000000000000000000000001), type(ArcBlocklistStub).runtimeCode);
        vm.etch(address(0x1800000000000000000000000000000000000000), type(ArcNativeTransferStub).runtimeCode);
        vm.allowCheatcodes(address(0x1800000000000000000000000000000000000000)); // the stub moves balances with vm.deal

        address creator = makeAddr("forkCreator");
        address trader = makeAddr("forkTrader");

        bytes memory args = abi.encode(POOL_MANAGER, address(this));
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(SdogePadHook).creationCode, args);
        SdogePadHook hook = new SdogePadHook{salt: salt}(POOL_MANAGER, address(this));
        SdogePadTreasury treasury = new SdogePadTreasury(address(this));
        SdogePadPortal portal = new SdogePadPortal(POOL_MANAGER, address(hook), address(treasury), USDC, true);
        hook.bootstrapMainPortal(address(portal));
        hook.bootstrapFactory(
            address(new SdogePadFactory(POOL_MANAGER, address(hook), address(treasury), USDC, 100e6, address(this)))
        );

        vm.prank(creator);
        (address token, address locker) = portal.createLaunch(
            SdogePadPortal.CreateLaunchParams({
                name: "Fork Doge", symbol: "FORK", startingMarketCapQuote: 1_000e6, buyTaxBps: 300, sellTaxBps: 300
            })
        );
        bool tokenIsToken0 = token < USDC;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(tokenIsToken0 ? token : USDC),
            currency1: Currency.wrap(tokenIsToken0 ? USDC : token),
            fee: portal.POOL_FEE(),
            tickSpacing: portal.TICK_SPACING(),
            hooks: IHooks(address(hook))
        });

        PoolSwapTest router = new PoolSwapTest(IPoolManager(POOL_MANAGER));
        vm.deal(trader, 1_000 ether); // 1,000 native USDC = 1,000e6 via the ERC-20
        assertEq(IERC20(USDC).balanceOf(trader), 1_000e6, "Arc USDC mirrors the native balance");

        vm.startPrank(trader);
        IERC20(USDC).approve(address(router), type(uint256).max);
        IERC20(token).approve(address(router), type(uint256).max);
        // Buy $100 in the launch block.
        router.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: !tokenIsToken0,
                amountSpecified: -100e6,
                sqrtPriceLimitX96: !tokenIsToken0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        uint256 bought = IERC20(token).balanceOf(trader);
        assertGt(bought, 0, "buy delivered tokens");
        bytes32 id = PoolId.unwrap(key.toId());
        assertEq(hook.pendingTax(id), 3e6, "buy tax is exactly 3% of $100, in USDC");
        // Sell it all straight back.
        router.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: tokenIsToken0,
                amountSpecified: -int256(bought),
                sqrtPriceLimitX96: tokenIsToken0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        assertEq(IERC20(token).balanceOf(trader), 0, "sold everything");

        // Tax reaches the splitter in real USDC; the creator can claim it.
        uint256 pending = hook.pendingTax(id);
        assertGt(pending, 3e6, "the sell added its own tax");
        hook.flush(key);
        address splitter = SdogePadLocker(locker).splitter();
        uint256 creatorCut = SdogePadRevenueSplitter(splitter).creditedToCreator(USDC);
        assertEq(creatorCut, pending - (pending * 1_000) / 10_000, "90% to the creator");
        vm.prank(creator);
        SdogePadRevenueSplitter(splitter).claim(creator, USDC);
        assertEq(IERC20(USDC).balanceOf(creator), creatorCut, "creator received real USDC");

        // Third parties still can't add liquidity on the real PoolManager.
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(IPoolManager(POOL_MANAGER));
        vm.expectRevert();
        lp.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({tickLower: -887200, tickUpper: 887200, liquidityDelta: 1e12, salt: 0}),
            ""
        );
    }
}

contract ArcBlocklistStub {
    function isBlocklisted(address) external pure returns (bool) {
        return false;
    }
}

contract ArcNativeTransferStub {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function transfer(address from, address to, uint256 amount) external returns (bool) {
        require(from.balance >= amount, "insufficient native balance");
        vm.deal(from, from.balance - amount);
        vm.deal(to, to.balance + amount);
        return true;
    }
}
