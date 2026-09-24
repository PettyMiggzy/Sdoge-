// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test-only: rejects any native USDC sent to it (like a Circle-blocklisted address or
///         a contract wallet without receive()), and has no ERC-721 receiver hook.
contract RevertingReceiver {
    receive() external payable {
        revert("no thanks");
    }
}
