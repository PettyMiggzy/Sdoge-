// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title SDOGECollectibles
/// @notice The $SDOGE NFT collection: a small roster of named/themed Doge
///         designs (SWAT Doge, Space Doge, etc.), not a huge generative
///         trait-combination set - hence ERC-1155, not ERC-721. Each
///         design is one token ID with its own mintable supply cap, price,
///         and metadata URI, rather than every mint being a unique 1-of-1.
///
/// Minted with native USDC (Arc's native currency, like ETH on mainnet -
/// see contracts/README.md's staking writeup for the same point), paid
/// directly to this contract and withdrawable by the owner.
///
/// Designs are owner-created, not permissionless - unlike SDOGEStaking's
/// contributeUSDC()/contributeTokens(), there's no legitimate "anyone
/// should be able to add a design" use case here.
contract SDOGECollectibles is ERC1155, Ownable {
    using Strings for uint256;

    struct Design {
        string name;
        uint256 maxSupply;
        uint256 minted;
        uint256 priceWei; // native USDC price per unit, 0 = owner-mint only
        bool exists;
    }

    mapping(uint256 => Design) public designs;
    uint256 public nextDesignId = 1;

    event DesignCreated(uint256 indexed designId, string name, uint256 maxSupply, uint256 priceWei);
    event DesignSupplyIncreased(uint256 indexed designId, uint256 newMaxSupply);
    event DesignPriceUpdated(uint256 indexed designId, uint256 newPriceWei);
    event Minted(uint256 indexed designId, address indexed to, uint256 amount);

    constructor(address owner_, string memory baseURI_) ERC1155(baseURI_) Ownable(owner_) {}

    // ---------- Views ----------

    /// @notice Returns `<baseURI><id>.json` (e.g. ".../metadata/1.json") for
    ///         a small hand-curated collection like this one, rather than
    ///         relying on EIP-1155's client-side "{id}" hex-padding
    ///         substitution convention - simpler file naming for a set this
    ///         size, and works the same in any wallet/marketplace since
    ///         they just fetch whatever URL this returns.
    function uri(uint256 designId) public view override returns (string memory) {
        return string.concat(super.uri(designId), designId.toString(), ".json");
    }

    function remainingSupply(uint256 designId) external view returns (uint256) {
        Design storage d = designs[designId];
        require(d.exists, "no such design");
        return d.maxSupply - d.minted;
    }

    // ---------- Admin: designs ----------

    /// @notice Register a new design with a fixed max supply. Supply can
    ///         only be raised later (see increaseSupply), never lowered -
    ///         a cap that could shrink below what's already minted, or be
    ///         cut after the fact to manufacture scarcity, isn't a
    ///         trustworthy cap.
    function createDesign(
        string calldata name,
        uint256 maxSupply,
        uint256 priceWei
    ) external onlyOwner returns (uint256 designId) {
        require(maxSupply > 0, "max supply must be > 0");
        designId = nextDesignId++;
        designs[designId] = Design({name: name, maxSupply: maxSupply, minted: 0, priceWei: priceWei, exists: true});
        emit DesignCreated(designId, name, maxSupply, priceWei);
    }

    function increaseSupply(uint256 designId, uint256 newMaxSupply) external onlyOwner {
        Design storage d = designs[designId];
        require(d.exists, "no such design");
        require(newMaxSupply > d.maxSupply, "can only increase max supply");
        d.maxSupply = newMaxSupply;
        emit DesignSupplyIncreased(designId, newMaxSupply);
    }

    function setPrice(uint256 designId, uint256 newPriceWei) external onlyOwner {
        Design storage d = designs[designId];
        require(d.exists, "no such design");
        d.priceWei = newPriceWei;
        emit DesignPriceUpdated(designId, newPriceWei);
    }

    function setURI(string calldata newURI) external onlyOwner {
        _setURI(newURI);
    }

    // ---------- Minting ----------

    function mint(uint256 designId, uint256 amount) external payable {
        Design storage d = designs[designId];
        require(d.exists, "no such design");
        require(amount > 0, "cannot mint 0");
        require(d.minted + amount <= d.maxSupply, "exceeds max supply");
        require(msg.value == d.priceWei * amount, "incorrect payment");

        d.minted += amount;
        _mint(msg.sender, designId, amount, "");
        emit Minted(designId, msg.sender, amount);
    }

    /// @notice Owner mint with no payment required - team allocations,
    ///         giveaways, airdrops. Still bounded by maxSupply like any
    ///         other mint.
    function ownerMint(uint256 designId, address to, uint256 amount) external onlyOwner {
        Design storage d = designs[designId];
        require(d.exists, "no such design");
        require(amount > 0, "cannot mint 0");
        require(d.minted + amount <= d.maxSupply, "exceeds max supply");

        d.minted += amount;
        _mint(to, designId, amount, "");
        emit Minted(designId, to, amount);
    }

    function withdraw(address to) external onlyOwner {
        require(to != address(0), "cannot withdraw to zero address");
        (bool sent, ) = to.call{value: address(this).balance}("");
        require(sent, "withdraw failed");
    }
}
