// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {SDOGEStudioCollection} from "../SDOGEStudioCollection.sol";

/// @notice Test-only: clones the Studio's collection implementation outside the Studio and tries
///         to set the clone up, to prove only the Studio can.
contract RogueCloner {
    function cloneAndInit(address implementation, address owner_) external returns (address c) {
        c = Clones.clone(implementation);
        SDOGEStudioCollection(c).initialize(owner_, "Fake Club", "FAKE", 0, address(0), 0, "", true);
    }
}
