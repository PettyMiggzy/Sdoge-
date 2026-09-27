// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Test-only stand-in for Permit2's allowance transfers (approve, allowance, transferFrom),
///         for the site's swap box (assets/js/swap.js).
contract MockPermit2 {
    struct Allowed {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    mapping(address => mapping(address => mapping(address => Allowed))) internal allowed; // user => token => spender

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        Allowed storage a = allowed[msg.sender][token][spender];
        a.amount = amount;
        a.expiration = expiration;
    }

    function allowance(address user, address token, address spender) external view returns (uint160, uint48, uint48) {
        Allowed memory a = allowed[user][token][spender];
        return (a.amount, a.expiration, a.nonce);
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        Allowed storage a = allowed[from][token][msg.sender];
        require(block.timestamp <= a.expiration, "AllowanceExpired");
        require(a.amount >= amount, "InsufficientAllowance");
        a.amount -= amount;
        require(IERC20(token).transferFrom(from, to, amount), "transfer failed");
    }
}
