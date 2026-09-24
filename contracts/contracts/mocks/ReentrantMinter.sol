// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface IStudioForMinter {
    function mintCommunity(string calldata uri) external returns (uint256);
}

interface ICollectionForMinter {
    function publicMint(uint256 quantity) external payable returns (uint256);
}

/// @notice Test-only: re-enters a mint from its ERC-721 receive hook, to prove the guards hold.
///         Mode 1 re-enters SDOGEStudio.mintCommunity; mode 2 re-enters a collection's
///         publicMint. It is the minter itself, so it spends its own credits.
contract ReentrantMinter is IERC721Receiver {
    address public target;
    uint8 public mode;
    bool public attacking;

    function setTarget(address target_, uint8 mode_) external {
        target = target_;
        mode = mode_;
    }

    function attackCommunity(string calldata uri) external {
        attacking = true;
        IStudioForMinter(target).mintCommunity(uri);
    }

    function attackDrop(uint256 quantity) external payable {
        attacking = true;
        ICollectionForMinter(target).publicMint{value: msg.value}(quantity);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (attacking) {
            attacking = false;
            if (mode == 1) IStudioForMinter(target).mintCommunity("ipfs://reentrant-attempt");
            else ICollectionForMinter(target).publicMint(1);
        }
        return this.onERC721Received.selector;
    }
}
