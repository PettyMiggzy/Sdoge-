// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface IStudioForSeller {
    function mintCommunity(string calldata uri) external returns (uint256);
    function communityCollection() external view returns (address);
}

interface IERC721ApproveForAttack {
    function approve(address to, uint256 tokenId) external;
}

interface IMarketplaceForAttack {
    function listERC721(address nftContract, uint256 tokenId, uint256 pricePerUnit) external returns (uint256);
    function buy(uint256 listingId, uint256 amount) external payable;
}

/// @notice Acts as a malicious SELLER on SDOGENFTMarketplace: mints its own Community Art NFTs
///         (with credits granted to it), lists them, and when paid during a buy() tries to
///         re-enter buy() (on a second listing) from its receive() hook. The marketplace must
///         neither let that through nor let it block the outer sale.
contract ReentrantSeller is IERC721Receiver {
    IStudioForSeller public studio;
    IMarketplaceForAttack public marketplace;

    uint256 public reentryListingId;
    uint256 public reentryValue;
    bool public reentrantCallAttempted;
    bool public reentrantCallReverted;

    function setTargets(address studio_, address marketplace_) external {
        studio = IStudioForSeller(studio_);
        marketplace = IMarketplaceForAttack(marketplace_);
    }

    function mintAndList(string calldata uri, uint256 pricePerUnit) external returns (uint256 tokenId, uint256 listingId) {
        tokenId = studio.mintCommunity(uri);
        address nft = studio.communityCollection();
        IERC721ApproveForAttack(nft).approve(address(marketplace), tokenId);
        listingId = marketplace.listERC721(nft, tokenId, pricePerUnit);
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
