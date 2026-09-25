// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

interface IMarketForSeller {
    function listERC1155(address nftContract, uint256 tokenId, uint256 amount, uint256 pricePerUnit, uint256 maxFeeBps)
        external
        returns (uint256);
    function withdrawProceeds(address payable to) external returns (uint256);
}

/// @notice Test-only seller contract with NO receive(): native USDC sent to it reverts, like a
///         contract wallet without a payable receive or a Circle-blocklisted address on Arc.
contract MarketSeller {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function list(address market, address nft, uint256 id, uint256 amount, uint256 price) external returns (uint256) {
        IERC1155(nft).setApprovalForAll(market, true);
        return IMarketForSeller(market).listERC1155(nft, id, amount, price, 1000);
    }

    function withdraw(address market, address payable to) external {
        IMarketForSeller(market).withdrawProceeds(to);
    }
}
