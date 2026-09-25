// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test-only ERC-1155 recipient whose receive hook burns `burn` gas before accepting
///         (type(uint256).max: burns whatever it's given).
contract GasBurner1155 {
    uint256 public burn;
    uint256 public spins;

    constructor(uint256 burn_) {
        burn = burn_;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
        uint256 start = gasleft();
        while (start - gasleft() < burn) {
            spins++;
        }
        return this.onERC1155Received.selector;
    }
}
