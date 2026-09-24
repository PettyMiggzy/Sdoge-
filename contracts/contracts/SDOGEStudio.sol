// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SDOGEStudioCollection} from "./SDOGEStudioCollection.sol";

interface IStudioRewardsPool {
    function contributeUSDC() external payable;
}

/// @title SDOGEStudio
/// @notice Mint-your-own NFTs on Arc. People buy mint credits in packages (for example 1 mint
///         for 5 USDC, or 1,000 for 100 USDC), paying native USDC or burning $SDOGE. Each credit
///         mints one NFT:
///         - in the shared SDOGE Community Art collection (mintCommunity), a 1-of-1 of your own art;
///         - in your own collection (createCollection): a project's own ERC-721 contract with its
///           own name and symbol, batch mints, airdrops and public drops.
///
/// Minting is fully open by design: no review, no filter, no takedown. Nothing here or in any
/// collection lets anyone change or move someone else's token.
///
/// Money: USDC from credit sales stays here until anyone calls withdraw(). That sends
/// `poolShareBps` of it to the staking reward pool (contributeUSDC) and the rest to the
/// treasury. $SDOGE payments are burned (sent to 0x...dEaD) on the spot. Credits can't be
/// transferred or refunded; they only mint.
contract SDOGEStudio is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Package {
        uint64 mints;
        bool active;
        uint128 priceWei; // native USDC, 18 decimals; 0 = not sold for USDC
        uint128 priceSdoge; // $SDOGE burned, 18 decimals; 0 = not sold for $SDOGE
    }

    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MAX_PACKAGES = 20;
    uint256 public constant MAX_PACKAGE_MINTS = 100_000;
    uint256 public constant MIN_PRICE = 0.01 ether; // 0.01 USDC
    uint256 public constant MAX_PRICE = 1_000_000 ether; // 1,000,000 USDC
    uint256 public constant PRICE_UNIT = 1e12; // USDC prices are whole micro-USDC
    uint256 public constant MIN_SDOGE_PRICE = 1 ether; // 1 SDOGE
    uint256 public constant MAX_SDOGE_PRICE = 1_000_000_000 ether; // SDOGE's whole supply

    IERC20 public immutable sdoge;
    address public immutable collectionImplementation;
    address public immutable communityCollection;

    Package[] private _packages;
    mapping(address => uint256) public credits;

    mapping(address => bool) public isCollection;
    mapping(address => bool) public verified;
    mapping(address => address[]) private _collectionsOf;
    address[] private _collections;

    address public treasury;
    address public rewardsPool; // SDOGEStaking (contributeUSDC); address(0) = everything to the treasury
    uint256 public poolShareBps; // share of USDC revenue for the pool

    event PackageAdded(uint256 indexed packageId, uint256 mints, uint256 priceWei, uint256 priceSdoge);
    event PackageUpdated(uint256 indexed packageId, uint256 mints, uint256 priceWei, uint256 priceSdoge);
    event PackageActiveSet(uint256 indexed packageId, bool active);
    event CreditsBought(
        address indexed buyer,
        address indexed to,
        uint256 indexed packageId,
        uint256 mints,
        uint256 paidUsdc,
        uint256 burnedSdoge
    );
    event CreditsGranted(address indexed to, uint256 amount);
    event CreditsSpent(address indexed account, address indexed collection, uint256 amount);
    event CollectionCreated(
        address indexed collection,
        address indexed creator,
        string name,
        string symbol,
        bool community
    );
    event VerifiedSet(address indexed collection, bool verified);
    event TreasuryUpdated(address indexed treasury);
    event RewardsPoolUpdated(address indexed pool, uint256 shareBps);
    event Withdrawn(uint256 toPool, uint256 toTreasury);

    constructor(
        address owner_,
        address sdogeToken,
        address treasury_,
        Package[] memory initialPackages,
        string memory communityContractURI
    ) Ownable(owner_) {
        require(sdogeToken.code.length > 0, "token has no code");
        require(IERC20Metadata(sdogeToken).decimals() == 18, "token must have 18 decimals");
        require(treasury_ != address(0), "treasury is zero address");
        sdoge = IERC20(sdogeToken);
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);

        for (uint256 i = 0; i < initialPackages.length; i++) {
            Package memory p = initialPackages[i];
            _addPackage(p.mints, p.priceWei, p.priceSdoge);
        }

        address implementation = address(new SDOGEStudioCollection());
        collectionImplementation = implementation;
        address community = _deploy(
            implementation, address(this), "SDOGE Community Art", "SDOGEART", 0, address(0), 0, communityContractURI, true
        );
        communityCollection = community;
        verified[community] = true;
        emit VerifiedSet(community, true);
    }

    // ---------- Credits ----------

    /// @notice Buys package `packageId` with native USDC, crediting `to`. `expectedMints` must
    ///         match the package, so a change landing first can't give you fewer mints.
    function buyCredits(uint256 packageId, uint256 expectedMints, address to) external payable nonReentrant {
        Package memory p = _activePackage(packageId);
        require(p.priceWei > 0, "not sold for USDC");
        require(p.mints == expectedMints, "package changed");
        require(msg.value == p.priceWei, "incorrect payment");
        require(to != address(0), "bad recipient");
        credits[to] += p.mints;
        emit CreditsBought(msg.sender, to, packageId, p.mints, msg.value, 0);
    }

    /// @notice Buys package `packageId` by burning its $SDOGE price (approve this contract
    ///         first). Reverts if the price is above `maxSdoge`.
    function buyCreditsWithSdoge(uint256 packageId, uint256 expectedMints, uint256 maxSdoge, address to)
        external
        nonReentrant
    {
        Package memory p = _activePackage(packageId);
        require(p.priceSdoge > 0, "not sold for SDOGE");
        require(p.mints == expectedMints, "package changed");
        require(p.priceSdoge <= maxSdoge, "price is above your limit");
        require(to != address(0), "bad recipient");
        credits[to] += p.mints;
        sdoge.safeTransferFrom(msg.sender, BURN_ADDRESS, p.priceSdoge);
        emit CreditsBought(msg.sender, to, packageId, p.mints, 0, p.priceSdoge);
    }

    /// @notice Free credits from the team (giveaways, partner projects). They only mint.
    function grantCredits(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "bad recipient");
        require(amount > 0 && amount <= MAX_PACKAGE_MINTS, "amount out of range");
        credits[to] += amount;
        emit CreditsGranted(to, amount);
    }

    /// @notice Called by a Studio collection for each token it mints: charges `account` (the
    ///         collection's owner) one credit per token.
    function spendCredits(address account, uint256 amount) external {
        require(isCollection[msg.sender], "collections only");
        _spend(account, amount, msg.sender);
    }

    // ---------- Minting ----------

    /// @notice Mints a 1-of-1 of your own art into SDOGE Community Art, for one credit. You host
    ///         whatever `uri` points at (e.g. your own IPFS pin); it can never be changed.
    function mintCommunity(string calldata uri) external nonReentrant returns (uint256 tokenId) {
        _spend(msg.sender, 1, communityCollection);
        tokenId = SDOGEStudioCollection(communityCollection).mintCommunity(msg.sender, uri);
    }

    /// @notice Deploys your own collection, owned by you. Minting into it uses your credits.
    ///         `maxSupply` 0 means no cap for now (you can set one later, then only lower it).
    ///         Royalty is at most 10%; a zero receiver means you.
    function createCollection(
        string calldata name_,
        string calldata symbol_,
        uint256 maxSupply_,
        address royaltyReceiver,
        uint96 royaltyBps,
        string calldata contractURI_
    ) external nonReentrant returns (address collection) {
        collection = _deploy(
            collectionImplementation,
            msg.sender,
            name_,
            symbol_,
            maxSupply_,
            royaltyReceiver,
            royaltyBps,
            contractURI_,
            false
        );
        _collectionsOf[msg.sender].push(collection);
    }

    // ---------- Revenue ----------

    /// @notice Sends USDC revenue out: `poolShareBps` to the staking reward pool, the rest to
    ///         the treasury. Anyone can call it.
    function withdraw() external nonReentrant {
        uint256 amount = address(this).balance;
        require(amount > 0, "nothing to withdraw");
        address pool = rewardsPool;
        uint256 toPool = pool == address(0) ? 0 : (amount * poolShareBps) / 10_000;
        uint256 toTreasury = amount - toPool;
        if (toPool > 0) IStudioRewardsPool(pool).contributeUSDC{value: toPool}();
        if (toTreasury > 0) {
            (bool sent,) = treasury.call{value: toTreasury}("");
            require(sent, "treasury transfer failed");
        }
        emit Withdrawn(toPool, toTreasury);
    }

    // ---------- Admin ----------

    function addPackage(uint256 mints, uint256 priceWei, uint256 priceSdoge) external onlyOwner returns (uint256) {
        return _addPackage(mints, priceWei, priceSdoge);
    }

    /// @notice Changes a package. Buyers are protected: they pass the mints they expect and pay
    ///         an exact USDC price or at most their $SDOGE limit.
    function updatePackage(uint256 packageId, uint256 mints, uint256 priceWei, uint256 priceSdoge)
        external
        onlyOwner
    {
        require(packageId < _packages.length, "no such package");
        _checkPackage(mints, priceWei, priceSdoge);
        Package storage p = _packages[packageId];
        p.mints = uint64(mints);
        p.priceWei = uint128(priceWei);
        p.priceSdoge = uint128(priceSdoge);
        emit PackageUpdated(packageId, mints, priceWei, priceSdoge);
    }

    function setPackageActive(uint256 packageId, bool active) external onlyOwner {
        require(packageId < _packages.length, "no such package");
        _packages[packageId].active = active;
        emit PackageActiveSet(packageId, active);
    }

    /// @notice The Verified badge the site shows for real projects. Anything else is shown as an
    ///         unverified creator collection.
    function setVerified(address collection, bool isVerified) external onlyOwner {
        require(isCollection[collection], "not a Studio collection");
        verified[collection] = isVerified;
        emit VerifiedSet(collection, isVerified);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "treasury is zero address");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    /// @notice Points `shareBps` of USDC revenue at SDOGEStaking (anything with
    ///         contributeUSDC()). Must be a contract; address(0) with share 0 turns it off.
    function setRewardsPool(address pool, uint256 shareBps) external onlyOwner {
        require(shareBps <= 10_000, "share above 100%");
        if (pool == address(0)) require(shareBps == 0, "no pool to share with");
        else require(pool.code.length > 0, "pool must be a contract");
        rewardsPool = pool;
        poolShareBps = shareBps;
        emit RewardsPoolUpdated(pool, shareBps);
    }

    function renounceOwnership() public view override onlyOwner {
        revert("renounce disabled");
    }

    // ---------- Views ----------

    function packageCount() external view returns (uint256) {
        return _packages.length;
    }

    function getPackage(uint256 packageId) external view returns (Package memory) {
        require(packageId < _packages.length, "no such package");
        return _packages[packageId];
    }

    function getPackages() external view returns (Package[] memory) {
        return _packages;
    }

    function collectionsOf(address creator) external view returns (address[] memory) {
        return _collectionsOf[creator];
    }

    function collectionCount() external view returns (uint256) {
        return _collections.length;
    }

    /// @notice Up to `limit` collections starting at `offset`, oldest first.
    function getCollections(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 n = _collections.length;
        if (offset >= n) return new address[](0);
        uint256 end = limit > n - offset ? n : offset + limit;
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = _collections[i];
        }
    }

    // ---------- Internals ----------

    function _spend(address account, uint256 amount, address collection) private {
        uint256 balance = credits[account];
        require(balance >= amount, "not enough mint credits");
        credits[account] = balance - amount;
        emit CreditsSpent(account, collection, amount);
    }

    function _activePackage(uint256 packageId) private view returns (Package memory p) {
        require(packageId < _packages.length, "no such package");
        p = _packages[packageId];
        require(p.active, "package not for sale");
    }

    function _addPackage(uint256 mints, uint256 priceWei, uint256 priceSdoge) private returns (uint256 packageId) {
        require(_packages.length < MAX_PACKAGES, "too many packages");
        _checkPackage(mints, priceWei, priceSdoge);
        packageId = _packages.length;
        _packages.push(
            Package({mints: uint64(mints), active: true, priceWei: uint128(priceWei), priceSdoge: uint128(priceSdoge)})
        );
        emit PackageAdded(packageId, mints, priceWei, priceSdoge);
    }

    function _checkPackage(uint256 mints, uint256 priceWei, uint256 priceSdoge) private pure {
        require(mints > 0 && mints <= MAX_PACKAGE_MINTS, "mints out of range");
        require(priceWei > 0 || priceSdoge > 0, "a package needs a price");
        require(
            priceWei == 0 || (priceWei >= MIN_PRICE && priceWei <= MAX_PRICE && priceWei % PRICE_UNIT == 0),
            "USDC price must be 0.01-1,000,000 in whole micro-USDC (18 decimals)"
        );
        require(
            priceSdoge == 0 || (priceSdoge >= MIN_SDOGE_PRICE && priceSdoge <= MAX_SDOGE_PRICE),
            "SDOGE price must be 1-1,000,000,000 SDOGE (18 decimals)"
        );
    }

    function _deploy(
        address implementation,
        address owner_,
        string memory name_,
        string memory symbol_,
        uint256 maxSupply_,
        address royaltyReceiver,
        uint96 royaltyBps,
        string memory contractURI_,
        bool community
    ) private returns (address collection) {
        collection = Clones.clone(implementation);
        SDOGEStudioCollection(collection).initialize(
            owner_, name_, symbol_, maxSupply_, royaltyReceiver, royaltyBps, contractURI_, community
        );
        isCollection[collection] = true;
        _collections.push(collection);
        emit CollectionCreated(collection, owner_, name_, symbol_, community);
    }
}
