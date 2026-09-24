// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {LaunchToken} from "./LaunchToken.sol";

/// The meme vault: a pot of real USDC behind one launched token, redeemable by any holder.
///
/// Funding: the hook mints 0.5% of every buy (a quarter of its 2% buy fee) to this vault as a
/// PoolManager claim on USDC (ERC-6909). USDC sent here directly counts too.
///
/// The backing is shared by EVERY token equally, including the tokens still sitting in the pool:
///   floor           = backing() / effectiveSupply()
///   effectiveSupply = totalSupply - tokens at 0x...dEaD - tokens held by this vault
/// Nobody can push that denominator down without destroying tokens for good, so flash loans,
/// flash swaps and pool manipulation can't inflate a redemption. (The first design divided by the
/// tokens outside the pool, which any swap moves, and one flash transaction could drain the vault.)
///
/// redeem() burns tokens and pays exactly their share, rounded down in the vault's favour. So the
/// floor never drops: buys add USDC, sells and transfers change nothing here, and redemptions and
/// burns only raise it. While the market price is below the floor, buying and redeeming is free
/// money, and that arbitrage is what pulls the price back up to the floor.
contract MemeVault is IUnlockCallback, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using TransientStateLibrary for IPoolManager;

    address public constant USDC = 0x3600000000000000000000000000000000000000;
    uint256 internal constant USDC_ID = uint256(uint160(USDC)); // USDC's ERC-6909 id in the PoolManager
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IPoolManager public immutable poolManager;
    LaunchToken public immutable token;

    event Redeemed(address indexed holder, address indexed to, uint256 tokens, uint256 usdc);

    error PoolManagerUnlocked();
    error NotPoolManager();
    error ZeroAddress();
    error NothingToPay();
    error InsufficientOutput(uint256 pay, uint256 minOut);

    constructor(IPoolManager poolManager_, LaunchToken token_) {
        poolManager = poolManager_;
        token = token_;
    }

    /// USDC (6 decimals) behind the token: held here, plus claims held in the PoolManager.
    function backing() public view returns (uint256) {
        return IERC20(USDC).balanceOf(address(this)) + poolManager.balanceOf(address(this), USDC_ID);
    }

    /// Every token that still has a claim on the backing (see the contract comment).
    function effectiveSupply() public view returns (uint256) {
        return token.totalSupply() - token.balanceOf(DEAD) - token.balanceOf(address(this));
    }

    /// USDC (6 decimals) that redeeming `amount` token-wei would pay right now.
    function quoteRedeem(uint256 amount) external view returns (uint256) {
        uint256 supply = effectiveSupply();
        return supply == 0 ? 0 : Math.mulDiv(amount, backing(), supply);
    }

    /// The floor: USDC per whole token, as an 18-decimal number (1e18 = $1).
    function floorPrice() external view returns (uint256) {
        uint256 supply = effectiveSupply();
        return supply == 0 ? 0 : Math.mulDiv(backing(), 1e30, supply);
    }

    /// Burns `amount` of the caller's tokens (approve this vault for them first) and sends `to`
    /// their share of the backing. Reverts instead of burning for nothing, and when the payout
    /// would be below `minUsdcOut`. Can't be called from inside a PoolManager unlock.
    function redeem(uint256 amount, uint256 minUsdcOut, address to) external nonReentrant returns (uint256 pay) {
        if (poolManager.isUnlocked()) revert PoolManagerUnlocked();
        if (to == address(0)) revert ZeroAddress();

        uint256 cash = IERC20(USDC).balanceOf(address(this));
        uint256 claims = poolManager.balanceOf(address(this), USDC_ID);
        pay = Math.mulDiv(amount, cash + claims, effectiveSupply());
        if (pay == 0) revert NothingToPay();
        if (pay < minUsdcOut) revert InsufficientOutput(pay, minUsdcOut);

        token.burnFrom(msg.sender, amount);
        if (pay <= cash) {
            IERC20(USDC).safeTransfer(to, pay);
        } else {
            if (cash > 0) IERC20(USDC).safeTransfer(to, cash);
            poolManager.unlock(abi.encode(to, pay - cash));
        }
        emit Redeemed(msg.sender, to, amount, pay);
    }

    /// Only reachable through this vault's own poolManager.unlock() in redeem(): turns claims into USDC.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (address to, uint256 amount) = abi.decode(data, (address, uint256));
        poolManager.burn(address(this), USDC_ID, amount);
        poolManager.take(Currency.wrap(USDC), to, amount);
        return "";
    }
}
