// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {LaunchpadHook} from "./LaunchpadHook.sol";
import {MemeVault} from "./MemeVault.sol";

/// One tx: token -> pool -> full supply as ONE single-sided position from MIN_TICK up to the start price.
/// No curve contract, no graduation. The position is owned by this factory and there is no withdraw
/// function, so LP is locked by construction. Constant L over an unbounded range == constant product
/// with VIRTUAL_USDC on the money side, which is exactly the pump.fun curve without the migration.
contract LaunchpadFactory is IUnlockCallback {
    using PoolIdLibrary for PoolKey;

    address public constant USDC = 0x3600000000000000000000000000000000000000;

    IPoolManager public immutable pm;
    LaunchpadHook public immutable hook;
    address public platform;

    uint256 public constant SUPPLY = 1_000_000_000e18;
    // USDC on Arc's shared PoolManager is accounted in 6 decimals (the ERC-20
    // view at 0x3600...) - confirmed against this repo's own live SDOGE/USDC
    // pool, not assumed. $5k implied starting mcap.
    uint256 public constant VIRTUAL_USDC = 5_000e6;
    int24 public constant TICK_SPACING = 60;
    // Native value (tx.value) is the cheapest way to collect this: Arc's gas
    // token IS USDC (an 18-decimal native representation sharing the same
    // underlying balance as the 0x3600... ERC-20 view), so this needs no
    // approve() step even though the pool itself accounts in the 6-decimal view.
    uint256 public launchFee = 2e18; // 2 USDC anti-spam, goes to platform

    struct Launch { address token; address vault; address creator; PoolKey key; }
    Launch[] public launches;

    event Launched(uint256 indexed index, PoolId indexed poolId, address token, address vault, address creator, string name, string symbol, string uri);

    error NotPM();
    error FeeTooLow();
    error NotPlatform();
    error UsdcOwed();

    constructor(IPoolManager _pm, LaunchpadHook _hook, address _platform) {
        pm = _pm;
        hook = _hook;
        platform = _platform;
    }

    function setLaunchFee(uint256 f) external { if (msg.sender != platform) revert NotPlatform(); launchFee = f; }
    function setPlatform(address p) external { if (msg.sender != platform) revert NotPlatform(); platform = p; }
    function count() external view returns (uint256) { return launches.length; }

    function launch(string calldata name, string calldata symbol, string calldata uri) external payable returns (address tokenAddr, address vaultAddr, PoolId id) {
        if (msg.value < launchFee) revert FeeTooLow();

        LaunchToken token = _deployTokenAboveUsdc(name, symbol);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(USDC),
            currency1: Currency.wrap(address(token)),
            fee: 0,                                          // the hook IS the fee
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        id = key.toId();

        // sqrtPriceX96 = sqrt(token1 / token0) * 2^96 = sqrt(SUPPLY / VIRTUAL_USDC) * 2^96
        uint160 sqrtP = uint160(Math.sqrt((SUPPLY << 96) / VIRTUAL_USDC) << 48);
        int24 startTick = _floorToSpacing(TickMath.getTickAtSqrtPrice(sqrtP));
        sqrtP = TickMath.getSqrtPriceAtTick(startTick);      // sit exactly on the position's upper bound -> all token1
        int24 lower = _ceilToSpacing(TickMath.MIN_TICK);

        MemeVault vault = new MemeVault(hook, id, token);
        hook.register(key, msg.sender, address(vault));
        pm.initialize(key, sqrtP);

        uint128 liq = LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(lower), sqrtP, SUPPLY);
        pm.unlock(abi.encode(key, lower, startTick, liq));

        uint256 dust = token.balanceOf(address(this));     // rounding remainder from liquidity math
        if (dust > 0) token.burn(dust);

        (bool ok,) = platform.call{value: msg.value}(""); require(ok, "fee send failed");

        launches.push(Launch(address(token), address(vault), msg.sender, key));
        emit Launched(launches.length - 1, id, address(token), address(vault), msg.sender, name, symbol, uri);
        return (address(token), address(vault), id);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(pm)) revert NotPM();
        (PoolKey memory key, int24 lower, int24 upper, uint128 liq) = abi.decode(data, (PoolKey, int24, int24, uint128));
        (BalanceDelta d,) = pm.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, int256(uint256(liq)), bytes32(0)), "");
        if (d.amount0() < 0) revert UsdcOwed();             // price sits on the upper bound, so this must be 0
        if (d.amount1() < 0) {
            pm.sync(key.currency1);
            LaunchToken(Currency.unwrap(key.currency1)).transfer(address(pm), uint128(-d.amount1()));
            pm.settle();
        }
        return "";
    }

    // v4 sorts currencies by address; a plain `new LaunchToken(...)` lands at a
    // pseudo-random address, and ~1 in 5 launches would fall below USDC and
    // flip the token into currency0, breaking the hook's direction logic.
    // Mine a CREATE2 salt so the token address is always > USDC. ~1.3
    // iterations on average - negligible gas.
    function _deployTokenAboveUsdc(string calldata name, string calldata symbol) internal returns (LaunchToken token) {
        bytes32 salt = keccak256(abi.encodePacked(msg.sender, launches.length));
        bytes memory creationCode = abi.encodePacked(type(LaunchToken).creationCode, abi.encode(name, symbol, SUPPLY));
        for (;;) {
            address predicted = Create2.computeAddress(salt, keccak256(creationCode));
            if (predicted > USDC) break;
            salt = keccak256(abi.encodePacked(salt));
        }
        token = new LaunchToken{salt: salt}(name, symbol, SUPPLY);
    }

    function _floorToSpacing(int24 t) internal pure returns (int24) { int24 c = t / TICK_SPACING; if (t < 0 && c * TICK_SPACING != t) c--; return c * TICK_SPACING; }
    function _ceilToSpacing(int24 t) internal pure returns (int24) { int24 c = t / TICK_SPACING; if (t > 0 && c * TICK_SPACING != t) c++; return c * TICK_SPACING; }
}
