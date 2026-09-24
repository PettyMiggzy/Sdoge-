// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ICommunityMintForAttack {
    function mint(string calldata uri, uint256 maxBurnAmount) external returns (uint256);
}

interface IERC721ApproveForAttack {
    function approve(address to, uint256 tokenId) external;
}

interface IMarketplaceForAttack {
    function listERC721(address nftContract, uint256 tokenId, uint256 pricePerUnit) external returns (uint256);
    function buy(uint256 listingId, uint256 amount) external payable;
}

/// @notice Acts as a malicious SELLER on SDOGENFTMarketplace: mints its own
///         SDOGECommunityMint NFTs, lists them, and when paid during a buy()
///         tries to re-enter buy() (on a second listing) from its receive()
///         hook. The marketplace must neither let that through nor let it
///         block the outer sale.
contract ReentrantSeller is IERC721Receiver {
    ICommunityMintForAttack public communityMint;
    IMarketplaceForAttack public marketplace;

    uint256 public reentryListingId;
    uint256 public reentryValue;
    bool public reentrantCallAttempted;
    bool public reentrantCallReverted;

    function setTargets(address _communityMint, address _marketplace) external {
        communityMint = ICommunityMintForAttack(_communityMint);
        marketplace = IMarketplaceForAttack(_marketplace);
    }

    function approveToken(address token, address spender) external {
        IERC20(token).approve(spender, type(uint256).max);
    }

    function mintAndList(
        string calldata uri,
        address nftContract,
        uint256 pricePerUnit
    ) external returns (uint256 tokenId, uint256 listingId) {
        tokenId = communityMint.mint(uri, type(uint256).max);
        IERC721ApproveForAttack(nftContract).approve(address(marketplace), tokenId);
        listingId = marketplace.listERC721(nftContract, tokenId, pricePerUnit);
    }

    function armReentry(uint256 listingId, uint256 value) external {
        reentryListingId = listingId;
        reentryValue = value;
    }

    receive() external payable {
        if (reentryValue > 0) {
            reentrantCallAttempted = true;
            uint256 v = reentryValue;
            reentryValue = 0;
            try marketplace.buy{value: v}(reentryListingId, 1) {
                reentrantCallReverted = false;
            } catch {
                reentrantCallReverted = true;
            }
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
