// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// One hook for every launchpad pool. currency0 is ALWAYS the ERC-20 view of
/// USDC on Arc (0x3600...0000, 6 decimals) - confirmed against this repo's
/// own live SDOGE/USDC pool (bot/config.json's USDC_POOL_DECIMALS=6,
/// verified against a real Swap event's decoded amount0 - see bot/README.md),
/// not the native address(0)/18-decimal representation. Every pool on Arc's
/// shared PoolManager uses this same convention, so every fee here is in USDC:
///   buy  (0->1): 2% of USDC in.  25% vault / 50% platform / 25% creator
///   sell (1->0): 2% of USDC out. 100% platform
/// Fees accrue as ERC-20 balances and are pulled with claim(); nobody ever
/// holds native value from a swap.
contract LaunchpadHook is BaseHook {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    address public constant USDC = 0x3600000000000000000000000000000000000000;

    uint256 public constant FEE_BPS = 200;          // 2%
    uint256 public constant BUY_VAULT_BPS = 2500;   // of the fee
    uint256 public constant BUY_CREATOR_BPS = 2500; // of the fee; remainder (50%) -> platform

    address public platform;
    address public factory;

    struct PoolInfo { address creator; address vault; uint256 circulating; }
    mapping(PoolId => PoolInfo) public pools;
    mapping(address => uint256) public owed;

    error NotFactory();
    error NotPlatform();
    error UnknownPool();
    error UsdcMustBeCurrency0();
    error ExactOutputSellUnsupported();
    error FactorySet();

    event FeeTaken(PoolId indexed id, bool buy, uint256 fee);
    event Claimed(address indexed to, uint256 amount);

    constructor(IPoolManager pm, address _platform) BaseHook(pm) { platform = _platform; }

    function setFactory(address f) external {
        if (msg.sender != platform) revert NotPlatform();
        if (factory != address(0)) revert FactorySet();
        factory = f;
    }

    /// Point at an SDOGE buyback splitter later, or any other treasury.
    function setPlatform(address p) external {
        if (msg.sender != platform) revert NotPlatform();
        platform = p;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true, afterInitialize: false,
            beforeAddLiquidity: true, afterAddLiquidity: false,
            beforeRemoveLiquidity: false, afterRemoveLiquidity: false,
            beforeSwap: true, afterSwap: true,
            beforeDonate: false, afterDonate: false,
            beforeSwapReturnDelta: true, afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false, afterRemoveLiquidityReturnDelta: false
        });
    }

    function register(PoolKey calldata key, address creator, address vault) external {
        if (msg.sender != factory) revert NotFactory();
        pools[key.toId()] = PoolInfo(creator, vault, 0);
    }

    function _beforeInitialize(address sender, PoolKey calldata key, uint160) internal view override returns (bytes4) {
        if (sender != factory) revert NotFactory();
        if (Currency.unwrap(key.currency0) != USDC) revert UsdcMustBeCurrency0();
        return this.beforeInitialize.selector;
    }

    // Only the factory may add liquidity -> `circulating` below is exact, and nobody can inject a second LP.
    function _beforeAddLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata) internal view override returns (bytes4) {
        if (sender != factory) revert NotFactory();
        return this.beforeAddLiquidity.selector;
    }

    // Exact-input BUY: USDC is the *specified* leg, so the fee has to come off here, before the pool sees it.
    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata p, bytes calldata) internal override returns (bytes4, BeforeSwapDelta, uint24) {
        PoolId id = key.toId();
        if (pools[id].creator == address(0)) revert UnknownPool();
        if (p.zeroForOne && p.amountSpecified < 0) {
            uint256 fee = uint256(-p.amountSpecified) * FEE_BPS / 10_000;
            poolManager.take(key.currency0, address(this), fee);
            _split(id, fee, true);
            return (this.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
        }
        if (!p.zeroForOne && p.amountSpecified > 0) revert ExactOutputSellUnsupported(); // fee would land in the token; routers default to exact-in anyway
        return (this.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);
    }

    // Exact-output BUY and exact-input SELL: USDC is the *unspecified* leg, fee comes off the settled delta.
    function _afterSwap(address, PoolKey calldata key, SwapParams calldata p, BalanceDelta d, bytes calldata) internal override returns (bytes4, int128) {
        PoolId id = key.toId();
        PoolInfo storage info = pools[id];

        // Token that left / re-entered the pool. Feeds the vault floor denominator.
        int128 t = d.amount1();
        if (t > 0) {
            info.circulating += uint128(t);
        } else {
            uint256 back = uint128(-t);
            info.circulating = back >= info.circulating ? 0 : info.circulating - back;
        }

        if (p.zeroForOne && p.amountSpecified < 0) return (this.afterSwap.selector, 0); // already charged in _beforeSwap

        uint256 usdc = p.zeroForOne ? uint256(uint128(-d.amount0())) : uint256(uint128(d.amount0()));
        uint256 fee = usdc * FEE_BPS / 10_000;
        poolManager.take(key.currency0, address(this), fee);
        _split(id, fee, p.zeroForOne);
        return (this.afterSwap.selector, int128(int256(fee)));
    }

    function _split(PoolId id, uint256 fee, bool buy) internal {
        PoolInfo storage info = pools[id];
        if (buy) {
            uint256 v = fee * BUY_VAULT_BPS / 10_000;
            uint256 c = fee * BUY_CREATOR_BPS / 10_000;
            owed[info.vault] += v;
            owed[info.creator] += c;
            owed[platform] += fee - v - c;
        } else {
            owed[platform] += fee;
        }
        emit FeeTaken(id, buy, fee);
    }

    /// Anyone can push anyone's balance. Pull pattern: a creator with a
    /// reverting/misbehaving wallet can't jam swaps.
    function claim(address to) external {
        uint256 a = owed[to];
        owed[to] = 0;
        IERC20(USDC).safeTransfer(to, a);
        emit Claimed(to, a);
    }
}
