// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The owner() view of ERC-173 / OpenZeppelin Ownable.
interface IERC173Owner {
    function owner() external view returns (address);
}
