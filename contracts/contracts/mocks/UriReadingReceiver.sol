// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IStudioForReader {
    function mintCommunity(string calldata uri) external returns (uint256);
}

interface ICollectionForReader {
    function tokenURI(uint256 tokenId) external view returns (string memory);
}

/// @notice Test-only minter that reads tokenURI from inside its ERC-721 receive hook, the moment
///         the token arrives, and records what it saw.
contract UriReadingReceiver {
    string public seenUri;

    function mintVia(address studio, string calldata uri) external {
        IStudioForReader(studio).mintCommunity(uri);
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        seenUri = ICollectionForReader(msg.sender).tokenURI(tokenId);
        return this.onERC721Received.selector;
    }
}
