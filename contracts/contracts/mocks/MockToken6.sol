// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only 6-decimal token (like the USDC ERC-20 view), for decimals checks.
contract MockToken6 is ERC20 {
    constructor() ERC20("Six", "SIX") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
