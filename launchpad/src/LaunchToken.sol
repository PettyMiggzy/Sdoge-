// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// Plain and ownerless: fixed supply, no mint after construction, no transfer fee, no pause, no
/// blacklist. The whole supply is minted to the factory, which puts all of it into the token's
/// pool in the same transaction (see LaunchpadFactory). Burnable so MemeVault can burn what it
/// redeems.
contract LaunchToken is ERC20, ERC20Burnable {
    constructor(string memory name_, string memory symbol_, uint256 supply) ERC20(name_, symbol_) {
        _mint(msg.sender, supply);
    }
}
