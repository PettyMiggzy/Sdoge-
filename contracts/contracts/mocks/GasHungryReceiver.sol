// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test-only payee (think of a royalty splitter) whose receive() needs more gas than the
///         marketplace's 50k push stipend, but takes USDC fine with enough gas.
contract GasHungryReceiver {
    uint256[4] public received;

    receive() external payable {
        for (uint256 i = 0; i < 4; i++) {
            received[i] += msg.value; // four storage writes: well over 50k gas the first time
        }
    }
}
