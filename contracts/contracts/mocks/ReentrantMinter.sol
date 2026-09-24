// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ISDOGECommunityMint {
    function mint(string calldata uri) external returns (uint256);
}

/// @notice Attempts to re-enter mint() from the ERC-721 receive hook, to
///         confirm SDOGECommunityMint's nonReentrant guard actually blocks
///         it rather than trusting the modifier untested. Holds and
///         approves its own SDOGE balance so it - not a test EOA - is the
///         msg.sender the mint contract sees.
contract ReentrantMinter is IERC721Receiver {
    ISDOGECommunityMint public target;
    bool public attacking;

    function setTarget(address _target) external {
        target = ISDOGECommunityMint(_target);
    }

    function approveToken(address token, address spender) external {
        IERC20(token).approve(spender, type(uint256).max);
    }

    function attackMint(string calldata uri) external {
        attacking = true;
        target.mint(uri);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (attacking) {
            attacking = false;
            target.mint("reentrant-attempt");
        }
        return this.onERC721Received.selector;
    }
}
