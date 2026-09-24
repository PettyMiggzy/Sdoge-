// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// Plain, ownerless, fixed supply. Minted once to the factory, which puts
/// all of it into the pool as a single-sided position - see LaunchpadFactory.
contract LaunchToken is ERC20, ERC20Burnable {
    constructor(string memory n, string memory s, uint256 supply) ERC20(n, s) {
        _mint(msg.sender, supply);
    }
}
