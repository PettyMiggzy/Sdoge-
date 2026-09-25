// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IUsdcRewardsPool {
    function contributeUSDC() external payable;
}

interface IStudioRegistry {
    function isCollection(address collection) external view returns (bool);
}

/// @title SDOGENFTMarketplace
/// @notice Fixed-price resale for $SDOGE NFTs, and only those:
///         - SDOGECollectibles (ERC-1155 copies of the named designs), fixed at deployment;
///         - any ERC-721 collection made by SDOGE Studio (the shared Community Art collection and
///           every creator's own collection), checked against the Studio's registry. Those are
///           all clones of one audited contract, so a listed NFT always really transfers.
///
/// Escrow: listing moves the NFT (or the listed copies) into this contract, cancelling moves
/// them back, and buying moves them to the buyer. A listing can therefore never go stale, come
/// back to life later, be duplicated, or promise copies the seller no longer has.
///
/// Money: prices are native USDC with 18 decimals (1e18 = 1 USDC), at least 0.01 USDC and a
/// whole number of micro-USDC. From each sale:
/// - the fee (2% by default) goes to the staking reward pool; if the pool can't take it right
///   now it waits in `pendingFees` for flushFees();
/// - the creator's ERC-2981 royalty (Studio collections, at most 10%) goes to its receiver;
/// - the rest goes to the seller.
/// Neither the fee nor the royalty can ever be more than the rate in force when the item was
/// listed (or last repriced), and a seller can cap both when listing or repricing. Seller and
/// royalty payments that fail (a contract that can't receive, a blocklisted address) wait in
/// `proceeds` for withdrawal, and the sale still goes through.
///
/// Reads: every active listing can be paged in full, per seller and per collection, so no
/// listing can be pushed out of view by others.
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
        uint16 royaltyBps; // creator royalty rate when listed; a buy never pays more than this
        uint256 tokenId;
        uint256 amount; // copies still in escrow for this listing (always 1 for ERC-721)
        uint256 pricePerUnit; // native USDC, 18 decimals, per copy
    }

    uint256 public constant MIN_PRICE = 0.01 ether; // 0.01 USDC
    uint256 public constant PRICE_UNIT = 1e12; // prices must be whole micro-USDC
    uint256 public constant MAX_FEE_BPS = 1000; // 10% cap
    uint256 public constant SELLER_PUSH_GAS = 50_000;
    uint256 public constant FEE_PUSH_GAS = 100_000;
    uint256 public constant MAX_ROYALTY_BPS = 1000; // 10% cap, whatever a collection reports
    uint256 public constant ROYALTY_QUERY_GAS = 30_000;

    IStudioRegistry public immutable studio;
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
    mapping(address => mapping(uint256 => bool)) private _escrowed721;
    mapping(uint256 => uint256) private _escrowed1155;

    // Active listings, for paginated reads: all of them, per seller and per collection.
    uint256[] private _active;
    mapping(uint256 => uint256) private _activePos; // listingId => index + 1
    mapping(address => uint256[]) private _activeBySeller;
    mapping(uint256 => uint256) private _sellerPos; // listingId => index + 1
    mapping(address => uint256[]) private _activeByCollection;
    mapping(uint256 => uint256) private _collectionPos; // listingId => index + 1

    address private _receivingFrom; // set only while a list function pulls an NFT in

    event Listed(
        uint256 indexed listingId,
        address indexed seller,
        address indexed nftContract,
        Standard standard,
        uint256 tokenId,
        uint256 amount,
        uint256 pricePerUnit,
        uint256 feeBps,
        uint256 royaltyBps
    );
    event PriceUpdated(uint256 indexed listingId, uint256 newPricePerUnit, uint256 feeBps, uint256 royaltyBps);
    event Cancelled(uint256 indexed listingId, uint256 returnedAmount);
    event Sold(
        uint256 indexed listingId,
        address indexed buyer,
        uint256 amount,
        uint256 totalPaid,
        uint256 fee,
        uint256 royalty
    );
    event RoyaltyPaid(uint256 indexed listingId, address indexed receiver, uint256 amount);
    event ProceedsCredited(address indexed account, uint256 amount);
    event ProceedsWithdrawn(address indexed seller, address indexed to, uint256 amount);
    event FeeForwarded(address indexed to, uint256 amount);
    event FeeDeferred(uint256 amount);
    event FeeBpsUpdated(uint256 newFeeBps);
    event RewardsPoolUpdated(address indexed newRewardsPool);
    event FeeRecipientUpdated(address indexed newFeeRecipient);
    event StrayNftRescued(address indexed nftContract, uint256 indexed tokenId, uint256 amount, address to);
    event SurplusSwept(address indexed to, uint256 amount);

    constructor(address owner_, address studio_, address collectibles_, address feeRecipient_) Ownable(owner_) {
        require(studio_.code.length > 0 && collectibles_.code.length > 0, "collection registry or collectibles has no code");
        require(feeRecipient_ != address(0), "fee recipient is zero address");
        studio = IStudioRegistry(studio_);
        collectibles = IERC1155(collectibles_);
        feeRecipient = feeRecipient_;
    }

    // ---------- Listing ----------

    /// @notice Lists a token from a SDOGE Studio collection. Approve this contract for it first;
    ///         it moves into escrow until it sells or you cancel. Reverts if the marketplace fee
    ///         or the collection's royalty is above your limits (basis points, 100 = 1%).
    function listERC721(
        address nftContract,
        uint256 tokenId,
        uint256 pricePerUnit,
        uint256 maxFeeBps,
        uint256 maxRoyaltyBps
    ) external whenNotPaused nonReentrant returns (uint256 listingId) {
        require(studio.isCollection(nftContract), "only SDOGE Studio collections");
        _checkPrice(pricePerUnit);
        uint256 royaltyBps = _royaltyBpsOf(nftContract, tokenId);
        _checkLimits(royaltyBps, maxFeeBps, maxRoyaltyBps);

        _receivingFrom = nftContract;
        IERC721(nftContract).safeTransferFrom(msg.sender, address(this), tokenId);
        _receivingFrom = address(0);
        _escrowed721[nftContract][tokenId] = true;

        listingId = _create(nftContract, Standard.ERC721, tokenId, 1, pricePerUnit, royaltyBps);
    }

    /// @notice Lists `amount` copies of a SDOGECollectibles design. Call setApprovalForAll for this
    ///         contract first; the copies move into escrow until they sell or you cancel. Reverts
    ///         if the marketplace fee is above `maxFeeBps`. Collectibles pay no royalty.
    function listERC1155(address nftContract, uint256 tokenId, uint256 amount, uint256 pricePerUnit, uint256 maxFeeBps)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 listingId)
    {
        require(nftContract == address(collectibles), "only SDOGE Collectibles");
        require(amount > 0, "amount must be > 0");
        _checkPrice(pricePerUnit);
        _checkLimits(0, maxFeeBps, 0);

        _receivingFrom = nftContract;
        collectibles.safeTransferFrom(msg.sender, address(this), tokenId, amount, "");
        _receivingFrom = address(0);
        _escrowed1155[tokenId] += amount;

        listingId = _create(nftContract, Standard.ERC1155, tokenId, amount, pricePerUnit, 0);
    }

    /// @notice Changes the price. Like a fresh listing, the listing takes the fee and royalty
    ///         rates in force now, and reverts if either is above your limits.
    function updatePrice(uint256 listingId, uint256 newPricePerUnit, uint256 maxFeeBps, uint256 maxRoyaltyBps)
        external
        nonReentrant
    {
        Listing storage l = listings[listingId];
        require(l.active, "not active");
        require(l.seller == msg.sender, "not your listing");
        _checkPrice(newPricePerUnit);
        uint256 royaltyBps = l.standard == Standard.ERC721 ? _royaltyBpsOf(l.nftContract, l.tokenId) : 0;
        _checkLimits(royaltyBps, maxFeeBps, maxRoyaltyBps);
        uint256 fee = feeBps;
        l.pricePerUnit = newPricePerUnit;
        l.feeBps = uint16(fee);
        l.royaltyBps = uint16(royaltyBps);
        emit PriceUpdated(listingId, newPricePerUnit, fee, royaltyBps);
    }

    /// @notice Ends the listing and returns whatever hasn't sold to you. Always available, even
    ///         while the marketplace is paused. An ERC-721 comes back with a plain transfer, so a
    ///         seller contract without the receiver hook still gets it back.
    function cancelListing(uint256 listingId) external nonReentrant {
        _cancel(listingId, msg.sender);
    }

    /// @notice Like cancelListing, but returns what hasn't sold to `to` (with the receiver check).
    function cancelListingTo(uint256 listingId, address to) external nonReentrant {
        require(to != address(0), "bad recipient");
        _cancel(listingId, to);
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
        (address royaltyTo, uint256 royalty) = _royaltyFor(l, totalPrice);

        l.amount -= amount;
        if (l.amount == 0) _deactivate(listingId);

        _release(l, msg.sender, amount, true);
        _pay(seller, totalPrice - fee - royalty);
        if (royalty > 0 && _pay(royaltyTo, royalty)) emit RoyaltyPaid(listingId, royaltyTo, royalty);
        _forwardFee(fee);

        emit Sold(listingId, msg.sender, amount, totalPrice, fee, royalty);
    }

    /// @notice Sends your waiting proceeds (sale or royalty payments that couldn't be pushed) to `to`.
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

    /// @notice Sends `account`'s waiting proceeds to `account` itself, with all the gas it needs.
    ///         Anyone can call it: for receivers (e.g. a royalty splitter) that can take USDC but
    ///         can't call withdrawProceeds.
    function withdrawProceedsFor(address account) external nonReentrant returns (uint256 amount) {
        amount = proceeds[account];
        require(amount > 0, "nothing to withdraw");
        proceeds[account] = 0;
        totalProceeds -= amount;
        (bool sent,) = account.call{value: amount}("");
        require(sent, "transfer failed");
        emit ProceedsWithdrawn(account, account, amount);
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

    function activeListingCountBySeller(address seller) external view returns (uint256) {
        return _activeBySeller[seller].length;
    }

    function activeListingCountByCollection(address nftContract) external view returns (uint256) {
        return _activeByCollection[nftContract].length;
    }

    /// @notice Up to `limit` active listings starting at position `offset` (order changes as
    ///         listings end: the last one moves into the freed position).
    function getActiveListings(uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, Listing[] memory items)
    {
        return _page(_active, offset, limit);
    }

    /// @notice The same, for one seller's active listings.
    function getActiveListingsBySeller(address seller, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, Listing[] memory items)
    {
        return _page(_activeBySeller[seller], offset, limit);
    }

    /// @notice The same, for one collection's active listings.
    function getActiveListingsByCollection(address nftContract, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, Listing[] memory items)
    {
        return _page(_activeByCollection[nftContract], offset, limit);
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
            require(!_escrowed721[nftContract][tokenId], "not stray");
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
        require(_receivingFrom != address(0) && msg.sender == _receivingFrom, "list it instead");
        return IERC721Receiver.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external view returns (bytes4) {
        require(_receivingFrom == address(collectibles) && msg.sender == address(collectibles), "list it instead");
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

    function _checkLimits(uint256 royaltyBps, uint256 maxFeeBps, uint256 maxRoyaltyBps) private view {
        require(feeBps <= maxFeeBps, "fee is above your limit");
        require(royaltyBps <= maxRoyaltyBps, "royalty is above your limit");
    }

    function _create(
        address nftContract,
        Standard standard,
        uint256 tokenId,
        uint256 amount,
        uint256 price,
        uint256 royaltyBps
    ) private returns (uint256 listingId) {
        listingId = nextListingId++;
        listings[listingId] = Listing({
            seller: msg.sender,
            nftContract: nftContract,
            standard: standard,
            feeBps: uint16(feeBps),
            active: true,
            royaltyBps: uint16(royaltyBps),
            tokenId: tokenId,
            amount: amount,
            pricePerUnit: price
        });
        _push(_active, _activePos, listingId);
        _push(_activeBySeller[msg.sender], _sellerPos, listingId);
        _push(_activeByCollection[nftContract], _collectionPos, listingId);
        emit Listed(listingId, msg.sender, nftContract, standard, tokenId, amount, price, feeBps, royaltyBps);
    }

    /// The collection's royalty rate right now (ERC-2981 on a 10,000 price), capped at 10%.
    function _royaltyBpsOf(address nftContract, uint256 tokenId) private view returns (uint256) {
        try IERC2981(nftContract).royaltyInfo{gas: ROYALTY_QUERY_GAS}(tokenId, 10_000) returns (
            address receiver, uint256 amount
        ) {
            if (receiver == address(0)) return 0;
            return amount > MAX_ROYALTY_BPS ? MAX_ROYALTY_BPS : amount;
        } catch {
            return 0;
        }
    }

    /// The royalty owed on a sale: what the collection asks now, but never more than the rate
    /// recorded when the item was listed.
    function _royaltyFor(Listing storage l, uint256 price) private view returns (address receiver, uint256 amount) {
        uint256 capBps = l.royaltyBps;
        if (capBps == 0) return (address(0), 0);
        try IERC2981(l.nftContract).royaltyInfo{gas: ROYALTY_QUERY_GAS}(l.tokenId, price) returns (
            address r, uint256 a
        ) {
            if (r == address(0) || r == address(this)) return (address(0), 0); // it could never collect
            uint256 cap = (price * capBps) / 10_000;
            return (r, a < cap ? a : cap);
        } catch {
            return (address(0), 0);
        }
    }

    function _cancel(uint256 listingId, address to) private {
        Listing storage l = listings[listingId];
        require(l.active, "not active");
        require(l.seller == msg.sender, "not your listing");
        uint256 amount = l.amount;
        l.amount = 0;
        _deactivate(listingId);
        _release(l, to, amount, to != msg.sender);
        emit Cancelled(listingId, amount);
    }

    function _deactivate(uint256 listingId) private {
        Listing storage l = listings[listingId];
        l.active = false;
        _remove(_active, _activePos, listingId);
        _remove(_activeBySeller[l.seller], _sellerPos, listingId);
        _remove(_activeByCollection[l.nftContract], _collectionPos, listingId);
    }

    function _push(uint256[] storage list, mapping(uint256 => uint256) storage pos, uint256 id) private {
        list.push(id);
        pos[id] = list.length;
    }

    /// Swap-and-pop: the last id moves into the freed position.
    function _remove(uint256[] storage list, mapping(uint256 => uint256) storage pos, uint256 id) private {
        uint256 p = pos[id];
        uint256 last = list[list.length - 1];
        list[p - 1] = last;
        pos[last] = p;
        list.pop();
        delete pos[id];
    }

    function _page(uint256[] storage list, uint256 offset, uint256 limit)
        private
        view
        returns (uint256[] memory ids, Listing[] memory items)
    {
        uint256 n = list.length;
        if (offset >= n) return (new uint256[](0), new Listing[](0));
        uint256 end = limit > n - offset ? n : offset + limit;
        ids = new uint256[](end - offset);
        items = new Listing[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            ids[i - offset] = list[i];
            items[i - offset] = listings[list[i]];
        }
    }

    /// Moves escrowed NFTs out. `safe` runs the receiver check (buyers, and cancels to another
    /// address); a cancel back to the seller uses a plain ERC-721 transfer. ERC-1155 always checks.
    function _release(Listing storage l, address to, uint256 amount, bool safe) private {
        if (amount == 0) return;
        if (l.standard == Standard.ERC721) {
            _escrowed721[l.nftContract][l.tokenId] = false;
            if (safe) IERC721(l.nftContract).safeTransferFrom(address(this), to, l.tokenId);
            else IERC721(l.nftContract).transferFrom(address(this), to, l.tokenId);
        } else {
            _escrowed1155[l.tokenId] -= amount;
            collectibles.safeTransferFrom(address(this), to, l.tokenId, amount, "");
        }
    }

    /// Pushes a seller or royalty payment, or keeps it in `proceeds` if the push fails. Returns
    /// whether it was pushed.
    function _pay(address to, uint256 amount) private returns (bool sent) {
        if (amount == 0) return true;
        (sent,) = to.call{value: amount, gas: SELLER_PUSH_GAS}("");
        if (!sent) {
            proceeds[to] += amount;
            totalProceeds += amount;
            emit ProceedsCredited(to, amount);
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
