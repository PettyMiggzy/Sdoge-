// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Utils} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Utils.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface ISDOGEStudioCredits {
    function spendCredits(address account, uint256 amount) external;
}

/// @title SDOGEStudioCollection
/// @notice One ERC-721 collection made with SDOGE Studio. The Studio deploys each collection as a
///         minimal clone of this contract and initializes it in the same transaction.
///
/// Two kinds:
/// - A creator collection (a project's own): owned by its creator. Every token costs the owner
///   one Studio mint credit, whether the owner mints it (batch, with its own URI, or as an
///   airdrop) or a collector mints it in the public drop. In a drop the collector pays the drop
///   price, which goes to the creator's payout address; the credit comes from the owner.
/// - The Studio's shared Community collection (`isCommunity`): owned by the Studio contract,
///   which has no code that calls any owner function here. Anyone mints a 1-of-1 into it through
///   SDOGEStudio.mintCommunity for one credit.
///
/// What holders can rely on, in every collection:
/// - A token minted with its own URI keeps that URI forever; nobody can change or move it.
/// - The supply cap can be set once and after that only lowered.
/// - The shared base URI (used by drops and batch mints) can change only until the owner freezes it.
/// - Royalties are capped at 10%.
///
/// Owner mints skip the ERC-721 receiver check, so one recipient can't block an airdrop; only
/// send them to wallets that can hold NFTs. Public mints do run the check.
contract SDOGEStudioCollection is ERC721, ERC2981, Ownable2Step, Initializable, ReentrancyGuard {
    using Strings for uint256;

    uint256 public constant MAX_BATCH = 200; // tokens per owner mint or airdrop
    uint256 public constant MAX_URI_BATCH = 100; // tokens per mintWithURIs call
    uint256 public constant MAX_PUBLIC_MINT = 20; // tokens per public mint
    uint96 public constant MAX_ROYALTY_BPS = 1_000; // 10%
    uint256 public constant MIN_PRICE = 0.01 ether; // 0.01 USDC; native USDC has 18 decimals
    uint256 public constant MAX_PRICE = 1_000_000 ether;
    uint256 public constant PRICE_UNIT = 1e12; // prices are whole micro-USDC
    uint256 public constant MAX_URI_BYTES = 512;

    struct Drop {
        uint128 priceWei; // per token, native USDC; 0 = free to collectors (the owner still pays the credit)
        uint32 maxPerWallet; // 0 = no limit
        uint40 start; // unix time; 0 = as soon as it's open
        uint40 end; // unix time; 0 = no end
        bool open;
    }

    ISDOGEStudioCredits public studio;
    bool public isCommunity;
    string private _collectionName;
    string private _collectionSymbol;
    string public baseURI;
    string public uriSuffix;
    string public contractURI;
    bool public metadataFrozen;
    uint256 public maxSupply; // 0 = no cap set yet
    uint256 public totalMinted; // token ids run 1..totalMinted; nothing is ever burned
    address public payout;
    Drop public drop;
    mapping(address => uint256) public publicMinted;
    mapping(uint256 => string) private _tokenURIs;

    event PublicMint(address indexed minter, uint256 firstTokenId, uint256 quantity, uint256 paid);
    event DropUpdated(uint256 priceWei, uint256 maxPerWallet, uint256 start, uint256 end);
    event DropOpened(bool open);
    event PayoutUpdated(address indexed payout);
    event Withdrawn(address indexed to, uint256 amount);
    event MaxSupplySet(uint256 maxSupply);
    event RoyaltyUpdated(address indexed receiver, uint256 bps);
    event BaseURIUpdated(string baseURI, string suffix);
    event MetadataFrozen();
    /// ERC-7572: tells marketplaces to refresh the collection-level metadata.
    event ContractURIUpdated();
    /// ERC-4906: tells marketplaces to refresh token metadata.
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    /// @dev The implementation itself is never used directly: no owner, can't be initialized.
    constructor() ERC721("", "") Ownable(msg.sender) {
        _transferOwnership(address(0));
        _disableInitializers();
    }

    /// @notice Called once by the Studio, in the transaction that creates this clone. The caller
    ///         becomes this collection's credit ledger.
    function initialize(
        address owner_,
        string memory name_,
        string memory symbol_,
        uint256 maxSupply_,
        address royaltyReceiver,
        uint96 royaltyBps,
        string memory contractURI_,
        bool community
    ) external initializer {
        require(owner_ != address(0), "owner is zero address");
        require(_isText(bytes(name_), 64, true), "name must be 1-64 printable ASCII characters");
        require(_isText(bytes(symbol_), 16, false), "symbol must be 1-16 printable ASCII characters, no spaces");
        if (bytes(contractURI_).length > 0) _checkUri(bytes(contractURI_));
        studio = ISDOGEStudioCredits(msg.sender);
        isCommunity = community;
        _collectionName = name_;
        _collectionSymbol = symbol_;
        contractURI = contractURI_;
        maxSupply = maxSupply_;
        payout = owner_;
        if (royaltyBps > 0) _setRoyalty(royaltyReceiver == address(0) ? owner_ : royaltyReceiver, royaltyBps);
        _transferOwnership(owner_);
    }

    // ---------- Views ----------

    function name() public view override returns (string memory) {
        return _collectionName;
    }

    function symbol() public view override returns (string memory) {
        return _collectionSymbol;
    }

    function totalSupply() external view returns (uint256) {
        return totalMinted;
    }

    /// @notice The token's own URI if it was minted with one, otherwise baseURI + id + suffix
    ///         (empty until a base URI is set).
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        string memory own = _tokenURIs[tokenId];
        if (bytes(own).length > 0) return own;
        if (bytes(baseURI).length == 0) return "";
        return string.concat(baseURI, tokenId.toString(), uriSuffix);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981) returns (bool) {
        return interfaceId == bytes4(0x49064906) || super.supportsInterface(interfaceId); // ERC-4906
    }

    // ---------- Owner mints (one credit each) ----------

    /// @notice Mints `quantity` tokens to `to` that use the base URI.
    function mintBatch(address to, uint256 quantity) external onlyOwner nonReentrant returns (uint256 firstId) {
        require(quantity <= MAX_BATCH, "batch too large");
        studio.spendCredits(msg.sender, quantity);
        firstId = _reserve(quantity);
        for (uint256 i = 0; i < quantity; i++) {
            _mint(to, firstId + i);
        }
    }

    /// @notice Mints one token per URI to `to`. Each keeps its URI forever.
    function mintWithURIs(address to, string[] calldata uris) external onlyOwner nonReentrant returns (uint256 firstId) {
        uint256 n = uris.length;
        require(n <= MAX_URI_BATCH, "batch too large");
        studio.spendCredits(msg.sender, n);
        firstId = _reserve(n);
        for (uint256 i = 0; i < n; i++) {
            _checkUri(bytes(uris[i]));
            _tokenURIs[firstId + i] = uris[i];
            _mint(to, firstId + i);
        }
    }

    /// @notice One base-URI token to each recipient.
    function airdrop(address[] calldata recipients) external onlyOwner nonReentrant returns (uint256 firstId) {
        uint256 n = recipients.length;
        require(n <= MAX_BATCH, "batch too large");
        studio.spendCredits(msg.sender, n);
        firstId = _reserve(n);
        for (uint256 i = 0; i < n; i++) {
            _mint(recipients[i], firstId + i);
        }
    }

    // ---------- Public drop ----------

    /// @notice Sets the drop's terms (it stays open or closed as it was). Collectors always pay
    ///         exactly the price in force when their mint lands.
    function setDrop(uint256 priceWei, uint256 maxPerWallet, uint256 start, uint256 end) external onlyOwner {
        require(
            priceWei == 0 || (priceWei >= MIN_PRICE && priceWei <= MAX_PRICE && priceWei % PRICE_UNIT == 0),
            "price must be 0 or 0.01-1,000,000 USDC in whole micro-USDC (18 decimals)"
        );
        require(maxPerWallet <= type(uint32).max, "wallet limit too large");
        require(start <= type(uint40).max && end <= type(uint40).max, "time out of range");
        require(end == 0 || end > start, "end must be after start");
        Drop storage d = drop;
        d.priceWei = uint128(priceWei);
        d.maxPerWallet = uint32(maxPerWallet);
        d.start = uint40(start);
        d.end = uint40(end);
        emit DropUpdated(priceWei, maxPerWallet, start, end);
    }

    function setDropOpen(bool open) external onlyOwner {
        if (open) require(bytes(baseURI).length > 0, "set a base URI first");
        drop.open = open;
        emit DropOpened(open);
    }

    /// @notice Mints `quantity` (1-20) drop tokens to the caller for exactly price x quantity.
    ///         Each also uses one of the collection owner's credits.
    function publicMint(uint256 quantity) external payable nonReentrant returns (uint256 firstId) {
        Drop memory d = drop;
        require(d.open, "drop is closed");
        require(block.timestamp >= d.start, "drop hasn't started");
        require(d.end == 0 || block.timestamp < d.end, "drop has ended");
        require(quantity > 0 && quantity <= MAX_PUBLIC_MINT, "mint 1-20 at a time");
        require(msg.value == uint256(d.priceWei) * quantity, "incorrect payment");
        if (d.maxPerWallet > 0) {
            require(publicMinted[msg.sender] + quantity <= d.maxPerWallet, "wallet limit reached");
        }
        publicMinted[msg.sender] += quantity;
        studio.spendCredits(owner(), quantity);
        firstId = _reserve(quantity);
        for (uint256 i = 0; i < quantity; i++) {
            _mint(msg.sender, firstId + i);
        }
        for (uint256 i = 0; i < quantity; i++) {
            ERC721Utils.checkOnERC721Received(msg.sender, address(0), msg.sender, firstId + i, "");
        }
        emit PublicMint(msg.sender, firstId, quantity, msg.value);
    }

    /// @notice Sends drop sales to the payout address. Anyone can call it.
    function withdraw() external nonReentrant {
        uint256 amount = address(this).balance;
        require(amount > 0, "nothing to withdraw");
        address to = payout;
        (bool sent,) = to.call{value: amount}("");
        require(sent, "payout failed");
        emit Withdrawn(to, amount);
    }

    // ---------- Community mints (Studio only) ----------

    /// @notice The Community collection's only way in: the Studio calls this after taking the
    ///         minter's credit.
    function mintCommunity(address to, string calldata uri) external nonReentrant returns (uint256 tokenId) {
        require(isCommunity && msg.sender == address(studio), "studio only");
        _checkUri(bytes(uri));
        tokenId = _reserve(1);
        _tokenURIs[tokenId] = uri; // set before the receiver hook runs
        _mint(to, tokenId);
        ERC721Utils.checkOnERC721Received(to, address(0), to, tokenId, "");
    }

    // ---------- Owner settings ----------

    function setPayout(address newPayout) external onlyOwner {
        require(newPayout != address(0), "payout is zero address");
        payout = newPayout;
        emit PayoutUpdated(newPayout);
    }

    /// @notice Sets the URI used by drop and batch tokens: baseURI + id + suffix (e.g. ".json").
    function setBaseURI(string calldata newBaseURI, string calldata newSuffix) external onlyOwner {
        require(!metadataFrozen, "metadata is frozen");
        _checkUri(bytes(newBaseURI));
        require(bytes(newSuffix).length == 0 || _isText(bytes(newSuffix), 16, false), "bad suffix");
        baseURI = newBaseURI;
        uriSuffix = newSuffix;
        emit BaseURIUpdated(newBaseURI, newSuffix);
        if (totalMinted > 0) emit BatchMetadataUpdate(1, totalMinted);
    }

    function setContractURI(string calldata newContractURI) external onlyOwner {
        require(!metadataFrozen, "metadata is frozen");
        _checkUri(bytes(newContractURI));
        contractURI = newContractURI;
        emit ContractURIUpdated();
    }

    /// @notice Makes the base URI and collection metadata permanent.
    function freezeMetadata() external onlyOwner {
        metadataFrozen = true;
        emit MetadataFrozen();
    }

    /// @notice Sets the supply cap if there is none, or lowers it. It can never go up.
    function setMaxSupply(uint256 newMaxSupply) external onlyOwner {
        require(newMaxSupply > 0 && newMaxSupply >= totalMinted, "cap below what's minted");
        require(maxSupply == 0 || newMaxSupply <= maxSupply, "the cap can only go down");
        maxSupply = newMaxSupply;
        emit MaxSupplySet(newMaxSupply);
    }

    /// @notice Royalty for marketplaces that honor ERC-2981; 0 removes it. At most 10%.
    function setRoyalty(address receiver, uint96 bps) external onlyOwner {
        if (bps == 0) _deleteDefaultRoyalty();
        else _setRoyalty(receiver, bps);
        emit RoyaltyUpdated(receiver, bps);
    }

    function renounceOwnership() public view override onlyOwner {
        revert("renounce disabled");
    }

    // ---------- Internals ----------

    function _reserve(uint256 quantity) private returns (uint256 firstId) {
        require(quantity > 0, "cannot mint 0");
        uint256 minted = totalMinted;
        uint256 cap = maxSupply;
        require(cap == 0 || minted + quantity <= cap, "exceeds max supply");
        totalMinted = minted + quantity;
        firstId = minted + 1;
    }

    function _setRoyalty(address receiver, uint96 bps) private {
        require(bps <= MAX_ROYALTY_BPS, "royalty above 10%");
        _setDefaultRoyalty(receiver, bps);
    }

    /// URIs: 1-512 bytes of printable ASCII without spaces, so every wallet and indexer can read them.
    function _checkUri(bytes memory s) private pure {
        require(_isText(s, MAX_URI_BYTES, false), "uri must be 1-512 printable ASCII characters, no spaces");
    }

    function _isText(bytes memory s, uint256 maxLen, bool allowSpaces) private pure returns (bool) {
        if (s.length == 0 || s.length > maxLen) return false;
        bytes1 lowest = allowSpaces ? bytes1(0x20) : bytes1(0x21);
        for (uint256 i = 0; i < s.length; i++) {
            if (s[i] < lowest || s[i] > 0x7e) return false;
        }
        return true;
    }
}
