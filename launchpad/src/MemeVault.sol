// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolId} from "v4-core/src/types/PoolId.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LaunchpadHook} from "./LaunchpadHook.sol";
import {LaunchToken} from "./LaunchToken.sol";

/// USDC-only (the ERC-20 view at 0x3600..., 6 decimals - see LaunchpadHook).
/// Floor = vault balance / tokens in holders' hands. Redeeming burns and pays
/// pro-rata, so the floor never drops from a redemption and only rises from
/// buys. Below-floor price = free arb (buy from pool, redeem here), which is
/// what actually holds the line.
contract MemeVault {
    using SafeERC20 for IERC20;

    IERC20 public constant USDC = IERC20(0x3600000000000000000000000000000000000000);

    LaunchpadHook public immutable hook;
    PoolId public immutable poolId;
    LaunchToken public immutable token;
    uint256 public redeemed;

    event Redeemed(address indexed who, uint256 tokens, uint256 usdc);

    constructor(LaunchpadHook _hook, PoolId _id, LaunchToken _token) {
        hook = _hook;
        poolId = _id;
        token = _token;
    }

    function circulating() public view returns (uint256) {
        (,, uint256 c) = hook.pools(poolId);
        return c > redeemed ? c - redeemed : 0;
    }

    /// USDC (6-dec) per whole token, scaled 1e18. Divide by 1e6 for a dollar figure.
    function floor() external view returns (uint256) {
        uint256 c = circulating();
        return c == 0 ? 0 : USDC.balanceOf(address(this)) * 1e18 / c;
    }

    function redeem(uint256 amount) external {
        uint256 c = circulating();
        require(c > 0 && amount <= c, "bad amount");
        uint256 pay = amount * USDC.balanceOf(address(this)) / c;
        redeemed += amount;
        token.burnFrom(msg.sender, amount); // needs approve(vault, amount) first
        USDC.safeTransfer(msg.sender, pay);
        emit Redeemed(msg.sender, amount, pay);
    }
}
