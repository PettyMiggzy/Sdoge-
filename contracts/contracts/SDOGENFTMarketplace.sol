// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IUsdcRewardsPool {
    function contributeUSDC() external payable;
}

/// @title SDOGENFTMarketplace
/// @notice Peer-to-peer resale for both $SDOGE NFT contracts: the ERC-721
///         SDOGECommunityMint (one-of-a-kind user uploads) and the ERC-1155
///         SDOGECollectibles (a quantity of copies per named design) - "list
///         NFTs or supply for sale" covers both: a unique community mint is
///         always exactly 1 unit, a collectibles design can be listed and
///         bought in any quantity the seller actually holds.
///
/// Non-escrow, same trust model as any ERC-721/1155 marketplace: a listing
/// is just recorded intent. The seller keeps custody and only approves this
/// contract; buy() pulls the token via safeTransferFrom at that moment. If
/// the seller has since sold, transferred, or de-approved elsewhere, the
/// listing is stale and buy() reverts - the buyer loses nothing, since the
/// payment is part of the same reverted transaction. The marketplace itself
/// is never the recipient of a transfer in this flow (seller -> buyer
/// directly), so it never needs onERC721Received/onERC1155Received.
///
/// Fixed-price only - no auctions, no offers.
///
/// A feeBps cut of every sale (default 200 = 2%, the same rate as the
/// launchpad hook) routes to `rewardsPool` via its permissionless
/// contributeUSDC() - meant to be SDOGEStaking's address once deployed, so
/// marketplace resale volume feeds directly into stakers' USDC rewards (the
/// "NFT profits fund the USDC side of staking" connection sketched in
/// nft/README.md's "How it'd connect to staking", now with an actual
/// funding path). Falls back to paying the owner directly if rewardsPool
/// isn't set yet, so this works standalone before SDOGEStaking is live too.
contract SDOGENFTMarketplace is Ownable, ReentrancyGuard {
    enum Standard {
        ERC721,
        ERC1155
    }

    struct Listing {
        address seller;
        address nftContract;
        Standard standard;
        uint256 tokenId;
        uint256 amount; // always 1 for ERC-721; remaining quantity for ERC-1155
        uint256 pricePerUnit; // native USDC, per single unit
        bool active;
    }

    uint256 public nextListingId = 1;
    mapping(uint256 => Listing) public listings;

    uint256 public feeBps = 200; // 2%, matches the launchpad's rate
    uint256 public constant MAX_FEE_BPS = 1000; // 10% cap, owner can never set it higher
    address public rewardsPool; // SDOGEStaking's address, once wired up

    event Listed(
        uint256 indexed listingId,
        address indexed seller,
        address indexed nftContract,
        Standard standard,
        uint256 tokenId,
        uint256 amount,
        uint256 pricePerUnit
    );
    event PriceUpdated(uint256 indexed listingId, uint256 newPricePerUnit);
    event Cancelled(uint256 indexed listingId);
    event Sold(uint256 indexed listingId, address indexed buyer, uint256 amount, uint256 totalPaid, uint256 fee);
    event FeeBpsUpdated(uint256 newFeeBps);
    event RewardsPoolUpdated(address indexed newRewardsPool);

    constructor(address owner_) Ownable(owner_) {}

    // ---------- Listing ----------

    /// @notice List a single SDOGECommunityMint-style ERC-721 token. Caller
    ///         must currently own it and must have approved this contract
    ///         (approve(tokenId) or setApprovalForAll) beforehand.
    function listERC721(address nftContract, uint256 tokenId, uint256 pricePerUnit) external returns (uint256 listingId) {
        require(pricePerUnit > 0, "price must be > 0");
        IERC721 nft = IERC721(nftContract);
        require(nft.ownerOf(tokenId) == msg.sender, "not the owner");
        require(
            nft.getApproved(tokenId) == address(this) || nft.isApprovedForAll(msg.sender, address(this)),
            "marketplace not approved"
        );

        listingId = nextListingId++;
        listings[listingId] = Listing(msg.sender, nftContract, Standard.ERC721, tokenId, 1, pricePerUnit, true);
        emit Listed(listingId, msg.sender, nftContract, Standard.ERC721, tokenId, 1, pricePerUnit);
    }

    /// @notice List `amount` copies of an SDOGECollectibles-style ERC-1155
    ///         design. Caller must currently hold at least `amount` and must
    ///         have called setApprovalForAll(marketplace, true) beforehand -
    ///         ERC-1155 has no per-token approve(), only the all-or-nothing
    ///         operator approval.
    function listERC1155(
        address nftContract,
        uint256 tokenId,
        uint256 amount,
        uint256 pricePerUnit
    ) external returns (uint256 listingId) {
        require(amount > 0, "amount must be > 0");
        require(pricePerUnit > 0, "price must be > 0");
        IERC1155 nft = IERC1155(nftContract);
        require(nft.balanceOf(msg.sender, tokenId) >= amount, "insufficient balance");
        require(nft.isApprovedForAll(msg.sender, address(this)), "marketplace not approved");

        listingId = nextListingId++;
        listings[listingId] = Listing(msg.sender, nftContract, Standard.ERC1155, tokenId, amount, pricePerUnit, true);
        emit Listed(listingId, msg.sender, nftContract, Standard.ERC1155, tokenId, amount, pricePerUnit);
    }

    function updatePrice(uint256 listingId, uint256 newPricePerUnit) external {
        Listing storage l = listings[listingId];
        require(l.active, "not active");
        require(l.seller == msg.sender, "not your listing");
        require(newPricePerUnit > 0, "price must be > 0");
        l.pricePerUnit = newPricePerUnit;
        emit PriceUpdated(listingId, newPricePerUnit);
    }

    function cancelListing(uint256 listingId) external {
        Listing storage l = listings[listingId];
        require(l.active, "not active");
        require(l.seller == msg.sender, "not your listing");
        l.active = false;
        emit Cancelled(listingId);
    }

    // ---------- Buying ----------

    /// @notice Buy `amount` units of `listingId` (must be exactly 1 for an
    ///         ERC-721 listing; up to whatever remains for ERC-1155 - a
    ///         partial buy just shrinks the listing rather than closing it).
    ///         Send exactly `amount * pricePerUnit` native USDC.
    function buy(uint256 listingId, uint256 amount) external payable nonReentrant {
        Listing storage l = listings[listingId];
        require(l.active, "not active");
        require(amount > 0 && amount <= l.amount, "invalid amount");

        uint256 totalPrice = l.pricePerUnit * amount;
        require(msg.value == totalPrice, "incorrect payment");

        address seller = l.seller;
        address nftContract = l.nftContract;
        uint256 tokenId = l.tokenId;
        Standard standard = l.standard;

        l.amount -= amount;
        if (l.amount == 0) {
            l.active = false;
        }

        if (standard == Standard.ERC721) {
            require(amount == 1, "ERC721 listing is exactly 1");
            IERC721(nftContract).safeTransferFrom(seller, msg.sender, tokenId);
        } else {
            IERC1155(nftContract).safeTransferFrom(seller, msg.sender, tokenId, amount, "");
        }

        uint256 fee = (totalPrice * feeBps) / 10_000;
        uint256 sellerProceeds = totalPrice - fee;

        (bool paidSeller, ) = seller.call{value: sellerProceeds}("");
        require(paidSeller, "seller payment failed");

        _routeFee(fee);

        emit Sold(listingId, msg.sender, amount, totalPrice, fee);
    }

    function _routeFee(uint256 fee) internal {
        if (fee == 0) return;
        if (rewardsPool != address(0)) {
            IUsdcRewardsPool(rewardsPool).contributeUSDC{value: fee}();
        } else {
            (bool sent, ) = owner().call{value: fee}("");
            require(sent, "fee transfer failed");
        }
    }

    // ---------- Views ----------

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return listings[listingId];
    }

    // ---------- Admin ----------

    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= MAX_FEE_BPS, "fee too high");
        feeBps = newFeeBps;
        emit FeeBpsUpdated(newFeeBps);
    }

    /// @notice Point resale fees at SDOGEStaking (or any other
    ///         contributeUSDC()-shaped pool). address(0) (the default) means
    ///         fees go straight to the owner instead.
    function setRewardsPool(address newRewardsPool) external onlyOwner {
        rewardsPool = newRewardsPool;
        emit RewardsPoolUpdated(newRewardsPool);
    }
}
