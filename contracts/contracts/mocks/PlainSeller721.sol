// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IApprove721 {
    function approve(address to, uint256 tokenId) external;
}

interface IMarketForPlainSeller {
    function listERC721(address nftContract, uint256 tokenId, uint256 pricePerUnit, uint256 maxFeeBps, uint256 maxRoyaltyBps)
        external
        returns (uint256);
    function cancelListing(uint256 listingId) external;
    function cancelListingTo(uint256 listingId, address to) external;
}

/// @notice Test-only seller contract with NO onERC721Received (it got its NFT from an owner
///         airdrop, which skips the hook). It must still be able to cancel and get its NFT back.
contract PlainSeller721 {
    function list(address market, address nft, uint256 tokenId, uint256 price) external returns (uint256) {
        IApprove721(nft).approve(market, tokenId);
        return IMarketForPlainSeller(market).listERC721(nft, tokenId, price, 1000, 1000);
    }

    function cancel(address market, uint256 listingId) external {
        IMarketForPlainSeller(market).cancelListing(listingId);
    }

    function cancelTo(address market, uint256 listingId, address to) external {
        IMarketForPlainSeller(market).cancelListingTo(listingId, to);
    }
}
