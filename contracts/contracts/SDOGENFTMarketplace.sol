// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IUsdcRewardsPool {
    function contributeUSDC() external payable;
}

/// @title SDOGENFTMarketplace
/// @notice Fixed-price resale for the two $SDOGE NFT collections, and only those two:
///         SDOGECommunityMint (ERC-721, one-of-a-kind uploads) and SDOGECollectibles (ERC-1155,
///         copies of named designs). Both addresses are fixed at deployment, so no other contract
///         can ever be listed here.
///
/// Escrow: listing moves the NFT (or the listed copies) into this contract, cancelling moves
/// them back, and buying moves them to the buyer. A listing can therefore never go stale, come
/// back to life later, be duplicated, or promise copies the seller no longer has.
///
/// Money: prices are native USDC with 18 decimals (1e18 = 1 USDC), at least 0.01 USDC and a
/// whole number of micro-USDC. The seller is paid straight away; if that payment fails (a
/// contract that can't receive, a blocklisted address) it waits in `proceeds` for the seller to
/// withdraw, and the sale still goes through. The fee (2% by default, and never more than the
/// rate in force when the item was listed) goes to the staking reward pool; if the pool can't
/// take it right now it waits in `pendingFees` for flushFees(). Nothing about fees can stop a sale.
contract SDOGENFTMarketplace is Ownable2Step, Pausable, ReentrancyGuard, IERC721Receiver, IERC1155Receiver {
    enum Standard {
        ERC721,
        ERC1155
    }

    struct Listing {
        address seller;
        address nftContract;
        Standard standard;
        uint16 feeBps; // fee rate when listed; a buy never charges more than this
        bool active;
        uint256 tokenId;
        uint256 amount; // copies still in escrow for this listing (always 1 for ERC-721)
        uint256 pricePerUnit; // native USDC, 18 decimals, per copy
    }

    uint256 public constant MIN_PRICE = 0.01 ether; // 0.01 USDC
    uint256 public constant PRICE_UNIT = 1e12; // prices must be whole micro-USDC
    uint256 public constant MAX_FEE_BPS = 1000; // 10% cap
    uint256 public constant SELLER_PUSH_GAS = 50_000;
    uint256 public constant FEE_PUSH_GAS = 100_000;

    IERC721 public immutable communityMint;
    IERC1155 public immutable collectibles;

    uint256 public feeBps = 200; // 2%
    address public rewardsPool; // SDOGEStaking (contributeUSDC); address(0) = send fees to feeRecipient
    address public feeRecipient; // where fees go when no pool is set (the Treasury)

    uint256 public nextListingId = 1;
    mapping(uint256 => Listing) public listings;

    mapping(address => uint256) public proceeds; // seller payments that couldn't be pushed
    uint256 public totalProceeds;
    uint256 public pendingFees; // fees that couldn't be forwarded yet

    // Escrow accounting, so NFTs sent here by mistake can be told apart from listed ones.
    mapping(uint256 => bool) private _escrowed721;
    mapping(uint256 => uint256) private _escrowed1155;

    // Active listings, for paginated reads.
    uint256[] private _active;
    mapping(uint256 => uint256) private _activePos; // listingId => index + 1

    bool private _receiving; // set only while a list function pulls an NFT in

    event Listed(
        uint256 indexed listingId,
        address indexed seller,
        address indexed nftContract,
        Standard standard,
        uint256 tokenId,
        uint256 amount,
        uint256 pricePerUnit,
        uint256 feeBps
    );
    event PriceUpdated(uint256 indexed listingId, uint256 newPricePerUnit);
    event Cancelled(uint256 indexed listingId, uint256 returnedAmount);
    event Sold(uint256 indexed listingId, address indexed buyer, uint256 amount, uint256 totalPaid, uint256 fee);
    event ProceedsCredited(address indexed seller, uint256 amount);
    event ProceedsWithdrawn(address indexed seller, address indexed to, uint256 amount);
    event FeeForwarded(address indexed to, uint256 amount);
    event FeeDeferred(uint256 amount);
    event FeeBpsUpdated(uint256 newFeeBps);
    event RewardsPoolUpdated(address indexed newRewardsPool);
    event FeeRecipientUpdated(address indexed newFeeRecipient);
    event StrayNftRescued(address indexed nftContract, uint256 indexed tokenId, uint256 amount, address to);
    event SurplusSwept(address indexed to, uint256 amount);

    constructor(address owner_, address communityMint_, address collectibles_, address feeRecipient_)
        Ownable(owner_)
    {
        require(communityMint_ != address(0) && collectibles_ != address(0), "collection is zero address");
        require(feeRecipient_ != address(0), "fee recipient is zero address");
        communityMint = IERC721(communityMint_);
        collectibles = IERC1155(collectibles_);
        feeRecipient = feeRecipient_;
    }

    // ---------- Listing ----------

    /// @notice Lists a SDOGECommunityMint token. Approve this contract for it first; it moves into
    ///         escrow until it sells or you cancel.
    function listERC721(address nftContract, uint256 tokenId, uint256 pricePerUnit)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 listingId)
    {
        require(nftContract == address(communityMint), "only SDOGE Community Art");
        _checkPrice(pricePerUnit);

        _receiving = true;
        communityMint.safeTransferFrom(msg.sender, address(this), tokenId);
        _receiving = false;
        _escrowed721[tokenId] = true;

        listingId = _create(nftContract, Standard.ERC721, tokenId, 1, pricePerUnit);
    }

    /// @notice Lists `amount` copies of a SDOGECollectibles design. Call setApprovalForAll for this
    ///         contract first; the copies move into escrow until they sell or you cancel.
    function listERC1155(address nftContract, uint256 tokenId, uint256 amount, uint256 pricePerUnit)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 listingId)
    {
        require(nftContract == address(collectibles), "only SDOGE Collectibles");
        require(amount > 0, "amount must be > 0");
        _checkPrice(pricePerUnit);

        _receiving = true;
        collectibles.safeTransferFrom(msg.sender, address(this), tokenId, amount, "");
        _receiving = false;
        _escrowed1155[tokenId] += amount;

        listingId = _create(nftContract, Standard.ERC1155, tokenId, amount, pricePerUnit);
    }

    function updatePrice(uint256 listingId, uint256 newPricePerUnit) external {
        Listing storage l = listings[listingId];
        require(l.active, "not active");
        require(l.seller == msg.sender, "not your listing");
        _checkPrice(newPricePerUnit);
        l.pricePerUnit = newPricePerUnit;
        emit PriceUpdated(listingId, newPricePerUnit);
    }

    /// @notice Ends the listing and returns whatever hasn't sold. Always available, even while
    ///         the marketplace is paused.
    function cancelListing(uint256 listingId) external nonReentrant {
        Listing storage l = listings[listingId];
        require(l.active, "not active");
        require(l.seller == msg.sender, "not your listing");
        uint256 amount = l.amount;
        l.amount = 0;
        _deactivate(listingId);
        _release(l.standard, l.tokenId, msg.sender, amount);
        emit Cancelled(listingId, amount);
    }

    // ---------- Buying ----------

    /// @notice Buys `amount` copies of `listingId` (exactly 1 for ERC-721) for exactly
    ///         amount x pricePerUnit native USDC.
    function buy(uint256 listingId, uint256 amount) external payable whenNotPaused nonReentrant {
        Listing storage l = listings[listingId];
        require(l.active, "not active");
        require(amount > 0 && amount <= l.amount, "invalid amount");
        uint256 totalPrice = l.pricePerUnit * amount;
        require(msg.value == totalPrice, "incorrect payment");

        address seller = l.seller;
        uint256 rate = l.feeBps < feeBps ? l.feeBps : feeBps;
        uint256 fee = (totalPrice * rate) / 10_000;

        l.amount -= amount;
        if (l.amount == 0) _deactivate(listingId);

        _release(l.standard, l.tokenId, msg.sender, amount);
        _paySeller(seller, totalPrice - fee);
        _forwardFee(fee);

        emit Sold(listingId, msg.sender, amount, totalPrice, fee);
    }

    /// @notice Sends your waiting proceeds (payments that couldn't be pushed) to `to`.
    function withdrawProceeds(address payable to) external nonReentrant returns (uint256 amount) {
        require(to != address(0), "bad recipient");
        amount = proceeds[msg.sender];
        require(amount > 0, "nothing to withdraw");
        proceeds[msg.sender] = 0;
        totalProceeds -= amount;
        (bool sent,) = to.call{value: amount}("");
        require(sent, "transfer failed");
        emit ProceedsWithdrawn(msg.sender, to, amount);
    }

    /// @notice Forwards fees that couldn't be forwarded during a sale. Anyone can call it.
    function flushFees() external nonReentrant {
        uint256 amount = pendingFees;
        require(amount > 0, "no pending fees");
        pendingFees = 0;
        (address to, bool sent) = _sendFee(amount, gasleft());
        require(sent, "fee recipient refused");
        emit FeeForwarded(to, amount);
    }

    // ---------- Views ----------

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return listings[listingId];
    }

    function activeListingCount() external view returns (uint256) {
        return _active.length;
    }

    /// @notice Up to `limit` active listings starting at position `offset` (order changes as
    ///         listings end).
    function getActiveListings(uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, Listing[] memory items)
    {
        uint256 n = _active.length;
        if (offset >= n) return (new uint256[](0), new Listing[](0));
        uint256 end = offset + limit > n ? n : offset + limit;
        ids = new uint256[](end - offset);
        items = new Listing[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            ids[i - offset] = _active[i];
            items[i - offset] = listings[_active[i]];
        }
    }

    // ---------- Admin ----------

    /// @notice New listings use the new rate. A cut applies to existing listings at once; a raise
    ///         never does (each listing keeps the rate it was listed at).
    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= MAX_FEE_BPS, "fee too high");
        feeBps = newFeeBps;
        emit FeeBpsUpdated(newFeeBps);
    }

    /// @notice Points fees at SDOGEStaking (anything with contributeUSDC()). Must be a contract;
    ///         address(0) sends fees to feeRecipient instead.
    function setRewardsPool(address newRewardsPool) external onlyOwner {
        require(newRewardsPool == address(0) || newRewardsPool.code.length > 0, "pool must be a contract");
        rewardsPool = newRewardsPool;
        emit RewardsPoolUpdated(newRewardsPool);
    }

    function setFeeRecipient(address newFeeRecipient) external onlyOwner {
        require(newFeeRecipient != address(0), "fee recipient is zero address");
        feeRecipient = newFeeRecipient;
        emit FeeRecipientUpdated(newFeeRecipient);
    }

    /// @notice Stops new listings and buys. Cancelling, withdrawing and fee flushing keep working.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Returns an NFT that was sent here directly instead of through a listing. Can never
    ///         touch anything in escrow.
    function rescueStrayNft(address nftContract, uint256 tokenId, uint256 amount, address to) external onlyOwner {
        require(to != address(0), "bad recipient");
        if (nftContract == address(collectibles)) {
            uint256 held = collectibles.balanceOf(address(this), tokenId);
            require(amount > 0 && held >= _escrowed1155[tokenId] + amount, "not stray");
            collectibles.safeTransferFrom(address(this), to, tokenId, amount, "");
        } else {
            require(nftContract != address(communityMint) || !_escrowed721[tokenId], "not stray");
            IERC721(nftContract).transferFrom(address(this), to, tokenId);
        }
        emit StrayNftRescued(nftContract, tokenId, amount, to);
    }

    /// @notice Sends native USDC that was forced in (e.g. through the 0x3600 ERC-20 view) to
    ///         feeRecipient. Never touches proceeds or pending fees.
    function sweepSurplus() external onlyOwner nonReentrant {
        uint256 owed = totalProceeds + pendingFees;
        require(address(this).balance > owed, "no surplus");
        uint256 amount = address(this).balance - owed;
        (bool sent,) = feeRecipient.call{value: amount}("");
        require(sent, "transfer failed");
        emit SurplusSwept(feeRecipient, amount);
    }

    function renounceOwnership() public view override onlyOwner {
        revert("renounce disabled");
    }

    // ---------- Receiver hooks: only accept NFTs this contract is pulling into escrow ----------

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        require(_receiving && msg.sender == address(communityMint), "list it instead");
        return IERC721Receiver.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external view returns (bytes4) {
        require(_receiving && msg.sender == address(collectibles), "list it instead");
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert("list it instead");
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IERC1155Receiver).interfaceId
            || interfaceId == type(IERC721Receiver).interfaceId;
    }

    // ---------- Internals ----------

    function _checkPrice(uint256 price) private pure {
        require(price >= MIN_PRICE, "price below 0.01 USDC (prices use 18 decimals)");
        require(price % PRICE_UNIT == 0, "price must be whole micro-USDC");
    }

    function _create(address nftContract, Standard standard, uint256 tokenId, uint256 amount, uint256 price)
        private
        returns (uint256 listingId)
    {
        listingId = nextListingId++;
        listings[listingId] = Listing({
            seller: msg.sender,
            nftContract: nftContract,
            standard: standard,
            feeBps: uint16(feeBps),
            active: true,
            tokenId: tokenId,
            amount: amount,
            pricePerUnit: price
        });
        _active.push(listingId);
        _activePos[listingId] = _active.length;
        emit Listed(listingId, msg.sender, nftContract, standard, tokenId, amount, price, feeBps);
    }

    function _deactivate(uint256 listingId) private {
        listings[listingId].active = false;
        uint256 pos = _activePos[listingId];
        uint256 last = _active[_active.length - 1];
        _active[pos - 1] = last;
        _activePos[last] = pos;
        _active.pop();
        delete _activePos[listingId];
    }

    function _release(Standard standard, uint256 tokenId, address to, uint256 amount) private {
        if (amount == 0) return;
        if (standard == Standard.ERC721) {
            _escrowed721[tokenId] = false;
            communityMint.safeTransferFrom(address(this), to, tokenId);
        } else {
            _escrowed1155[tokenId] -= amount;
            collectibles.safeTransferFrom(address(this), to, tokenId, amount, "");
        }
    }

    function _paySeller(address seller, uint256 amount) private {
        if (amount == 0) return;
        (bool sent,) = seller.call{value: amount, gas: SELLER_PUSH_GAS}("");
        if (!sent) {
            proceeds[seller] += amount;
            totalProceeds += amount;
            emit ProceedsCredited(seller, amount);
        }
    }

    function _forwardFee(uint256 fee) private {
        if (fee == 0) return;
        (address to, bool sent) = _sendFee(fee, FEE_PUSH_GAS);
        if (sent) {
            emit FeeForwarded(to, fee);
        } else {
            pendingFees += fee;
            emit FeeDeferred(fee);
        }
    }

    function _sendFee(uint256 amount, uint256 gasLimit) private returns (address to, bool sent) {
        if (rewardsPool != address(0)) {
            to = rewardsPool;
            (sent,) = to.call{value: amount, gas: gasLimit}(abi.encodeCall(IUsdcRewardsPool.contributeUSDC, ()));
        } else {
            to = feeRecipient;
            (sent,) = to.call{value: amount, gas: gasLimit}("");
        }
    }
}
