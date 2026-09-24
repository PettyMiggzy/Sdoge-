// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title SDOGECollectibles
/// @notice The $SDOGE NFT collection: a small roster of named Doge designs (SWAT Doge, Space
///         Doge...). ERC-1155: each design is one token ID with its own capped supply and price.
///
/// How a design's sale works:
/// - createDesign registers it closed. Nobody can mint it until the owner opens it with
///   setPublicMint, so there's time to check the name, cap and price first.
/// - Public mints pay exactly the design's price in native USDC (18 decimals, 1e18 = 1 USDC).
///   A design priced at 0 can never be minted publicly.
/// - A part of each design's cap can be reserved for team and giveaway mints (ownerMint). The
///   owner can only mint from that reserve, never beyond it. Unused reserve can be released to
///   the public sale, and the reserve can never grow.
/// - The cap can be raised until the owner locks it with lockSupply (one-way), and new designs
///   can be added until lockCollection (one-way).
/// - Mint revenue goes to `treasury`; anyone can trigger withdraw().
contract SDOGECollectibles is ERC1155, Ownable2Step, ReentrancyGuard {
    using Strings for uint256;

    uint256 public constant MIN_PRICE = 0.01 ether; // 0.01 USDC; rejects 6-decimal-unit mistakes
    uint256 public constant PRICE_UNIT = 1e12; // prices are whole micro-USDC

    struct Design {
        string name;
        uint256 maxSupply;
        uint256 minted; // public + owner mints
        uint256 priceWei; // native USDC per copy; 0 = no public sale
        uint256 reserved; // part of maxSupply only ownerMint can use
        uint256 ownerMinted;
        bool exists;
        bool publicMintOpen;
        bool supplyLocked;
    }

    mapping(uint256 => Design) public designs;
    uint256 public nextDesignId = 1;
    bool public collectionLocked;
    bool public metadataFrozen;
    address public treasury;

    event DesignCreated(uint256 indexed designId, string name, uint256 maxSupply, uint256 priceWei, uint256 reserved);
    event DesignSupplyIncreased(uint256 indexed designId, uint256 newMaxSupply);
    event DesignSupplyLocked(uint256 indexed designId);
    event DesignPriceUpdated(uint256 indexed designId, uint256 newPriceWei);
    event PublicMintSet(uint256 indexed designId, bool open);
    event ReserveReleased(uint256 indexed designId, uint256 amount);
    event CollectionLocked();
    event MetadataFrozen();
    event TreasuryUpdated(address indexed treasury);
    event Minted(uint256 indexed designId, address indexed to, uint256 amount);
    event AirdropSkipped(uint256 indexed designId, address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    /// ERC-4906: tells marketplaces to refresh metadata.
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    constructor(address owner_, string memory baseURI_, address treasury_) ERC1155(baseURI_) Ownable(owner_) {
        require(treasury_ != address(0), "treasury is zero address");
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    // ---------- Views ----------

    /// @notice `<baseURI><id>.json`, for designs that exist.
    function uri(uint256 designId) public view override returns (string memory) {
        require(designs[designId].exists, "no such design");
        return string.concat(super.uri(designId), designId.toString(), ".json");
    }

    /// @notice Copies still available to public mints.
    function publicSupplyLeft(uint256 designId) public view returns (uint256) {
        Design storage d = designs[designId];
        require(d.exists, "no such design");
        uint256 reserveLeft = d.reserved - d.ownerMinted;
        return d.maxSupply - d.minted - reserveLeft;
    }

    function remainingSupply(uint256 designId) external view returns (uint256) {
        Design storage d = designs[designId];
        require(d.exists, "no such design");
        return d.maxSupply - d.minted;
    }

    // ---------- Admin: designs ----------

    /// @notice Registers design `expectedId` (must be the next id, so a stray or repeated call
    ///         can't shift every later design). Starts closed to public minting.
    function createDesign(
        uint256 expectedId,
        string calldata name,
        uint256 maxSupply,
        uint256 priceWei,
        uint256 reserved
    ) external onlyOwner returns (uint256 designId) {
        require(!collectionLocked, "collection is locked");
        require(expectedId == nextDesignId, "unexpected design id");
        require(bytes(name).length > 0, "name required");
        require(maxSupply > 0, "max supply must be > 0");
        require(reserved <= maxSupply, "reserve exceeds max supply");
        _checkPrice(priceWei);
        designId = nextDesignId++;
        designs[designId] = Design({
            name: name,
            maxSupply: maxSupply,
            minted: 0,
            priceWei: priceWei,
            reserved: reserved,
            ownerMinted: 0,
            exists: true,
            publicMintOpen: false,
            supplyLocked: false
        });
        emit DesignCreated(designId, name, maxSupply, priceWei, reserved);
    }

    function setPublicMint(uint256 designId, bool open) external onlyOwner {
        Design storage d = _design(designId);
        if (open) require(d.priceWei > 0, "set a price first");
        d.publicMintOpen = open;
        emit PublicMintSet(designId, open);
    }

    function setPrice(uint256 designId, uint256 newPriceWei) external onlyOwner {
        Design storage d = _design(designId);
        _checkPrice(newPriceWei);
        if (newPriceWei == 0 && d.publicMintOpen) {
            d.publicMintOpen = false; // price 0 means no public sale
            emit PublicMintSet(designId, false);
        }
        d.priceWei = newPriceWei;
        emit DesignPriceUpdated(designId, newPriceWei);
    }

    /// @notice Raises the cap (public part). Not possible once the design's supply is locked.
    function increaseSupply(uint256 designId, uint256 newMaxSupply) external onlyOwner {
        Design storage d = _design(designId);
        require(!d.supplyLocked, "supply is locked");
        require(newMaxSupply > d.maxSupply, "can only increase max supply");
        d.maxSupply = newMaxSupply;
        emit DesignSupplyIncreased(designId, newMaxSupply);
    }

    /// @notice Freezes a design's cap forever.
    function lockSupply(uint256 designId) external onlyOwner {
        Design storage d = _design(designId);
        d.supplyLocked = true;
        emit DesignSupplyLocked(designId);
    }

    /// @notice Moves unused reserve to the public sale. The reserve can only shrink.
    function releaseReserve(uint256 designId, uint256 amount) external onlyOwner {
        Design storage d = _design(designId);
        require(amount > 0 && amount <= d.reserved - d.ownerMinted, "more than the unused reserve");
        d.reserved -= amount;
        emit ReserveReleased(designId, amount);
    }

    /// @notice Stops new designs from ever being added.
    function lockCollection() external onlyOwner {
        collectionLocked = true;
        emit CollectionLocked();
    }

    function setURI(string calldata newURI) external onlyOwner {
        require(!metadataFrozen, "metadata is frozen");
        _setURI(newURI);
        if (nextDesignId > 1) emit BatchMetadataUpdate(1, nextDesignId - 1);
    }

    /// @notice Makes the metadata URI permanent (point it at IPFS first).
    function freezeMetadata() external onlyOwner {
        metadataFrozen = true;
        emit MetadataFrozen();
    }

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "treasury is zero address");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    function renounceOwnership() public view override onlyOwner {
        revert("renounce disabled");
    }

    // ---------- Minting ----------

    function mint(uint256 designId, uint256 amount) external payable nonReentrant {
        Design storage d = _design(designId);
        require(d.publicMintOpen && d.priceWei > 0, "public mint closed");
        require(amount > 0, "cannot mint 0");
        require(amount <= publicSupplyLeft(designId), "exceeds max supply");
        require(msg.value == d.priceWei * amount, "incorrect payment");

        d.minted += amount;
        _mint(msg.sender, designId, amount, "");
        emit Minted(designId, msg.sender, amount);
    }

    /// @notice Team and giveaway mints, free, from the design's reserve only.
    function ownerMint(uint256 designId, address to, uint256 amount) external onlyOwner {
        _ownerMint(designId, to, amount);
    }

    /// @notice An airdrop that skips any recipient that can't take the NFT (e.g. a contract
    ///         without ERC-1155 receiver hooks) instead of failing the whole batch.
    function ownerMintBatch(uint256 designId, address[] calldata to, uint256[] calldata amounts)
        external
        onlyOwner
        returns (uint256 skipped)
    {
        require(to.length == amounts.length, "length mismatch");
        for (uint256 i = 0; i < to.length; i++) {
            try this.mintForBatch(designId, to[i], amounts[i]) {}
            catch {
                skipped++;
                emit AirdropSkipped(designId, to[i], amounts[i]);
            }
        }
    }

    /// @dev Only callable by this contract, from ownerMintBatch.
    function mintForBatch(uint256 designId, address to, uint256 amount) external {
        require(msg.sender == address(this), "internal");
        _ownerMint(designId, to, amount);
    }

    /// @notice Sends all mint revenue to the treasury. Anyone can call it.
    function withdraw() external nonReentrant {
        uint256 amount = address(this).balance;
        require(amount > 0, "nothing to withdraw");
        (bool sent,) = treasury.call{value: amount}("");
        require(sent, "withdraw failed");
        emit Withdrawn(treasury, amount);
    }

    // ---------- Internals ----------

    function _design(uint256 designId) private view returns (Design storage d) {
        d = designs[designId];
        require(d.exists, "no such design");
    }

    function _ownerMint(uint256 designId, address to, uint256 amount) private {
        Design storage d = _design(designId);
        require(amount > 0, "cannot mint 0");
        require(d.ownerMinted + amount <= d.reserved, "exceeds the reserve");
        d.ownerMinted += amount;
        d.minted += amount;
        _mint(to, designId, amount, "");
        emit Minted(designId, to, amount);
    }

    function _checkPrice(uint256 priceWei) private pure {
        require(priceWei == 0 || priceWei >= MIN_PRICE, "price below 0.01 USDC (prices use 18 decimals)");
        require(priceWei % PRICE_UNIT == 0, "price must be whole micro-USDC");
    }
}
