// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ICommunityMintForReader {
    function mint(string calldata uri, uint256 maxBurnAmount) external returns (uint256);
    function tokenURI(uint256 tokenId) external view returns (string memory);
}

/// @notice Test-only minter that reads tokenURI from inside its ERC-721 receive hook, the moment
///         the token arrives, and records what it saw.
contract UriReadingReceiver {
    string public seenUri;

    function mintVia(address nft, address token, string calldata uri) external {
        IERC20(token).approve(nft, type(uint256).max);
        ICommunityMintForReader(nft).mint(uri, type(uint256).max);
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        seenUri = ICommunityMintForReader(msg.sender).tokenURI(tokenId);
        return this.onERC721Received.selector;
    }
}
