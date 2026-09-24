// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {ERC721Utils} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Utils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SDOGECommunityMint
/// @notice Anyone can mint their own 1-of-1 NFT from art they host themselves, paid for by
///         burning `burnAmount` (default 1,000,000) $SDOGE. Each mint is unique, hence ERC-721.
///
/// Deliberate product decision: minting is fully open. There is no review queue, no content
/// filter, no pause and no takedown: a minted token and its URI stay exactly as minted, and the
/// owner can't move or change anyone's token. The only thing checked on-chain is that the URI is
/// well-formed text (printable ASCII, no spaces, at most 512 bytes), so every wallet, explorer and
/// indexer can read it; that says nothing about what it points to. Adding moderation later
/// would take a new contract (a new collection), since anyone can always call mint() directly.
///
/// $SDOGE has no burn function, so "burned" means sent to 0x...dEaD: gone for good, but still
/// counted in totalSupply(). Anything that reports supply should subtract balanceOf(0x...dEaD).
contract SDOGECommunityMint is ERC721URIStorage, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MIN_BURN_AMOUNT = 1_000 ether;
    uint256 public constant MAX_BURN_AMOUNT = 100_000_000 ether; // 10% of SDOGE's supply
    uint256 public constant MAX_URI_BYTES = 512;

    IERC20 public immutable sdoge;
    uint256 public burnAmount = 1_000_000 ether;
    uint256 public nextTokenId = 1;

    event Minted(uint256 indexed tokenId, address indexed minter, string tokenURI, uint256 burned);
    event BurnAmountUpdated(uint256 oldAmount, uint256 newAmount);

    constructor(address sdogeToken, address owner_) ERC721("SDOGE Community Art", "SDOGEART") Ownable(owner_) {
        require(sdogeToken.code.length > 0, "token has no code");
        require(IERC20Metadata(sdogeToken).decimals() == 18, "token must have 18 decimals");
        sdoge = IERC20(sdogeToken);
    }

    /// @notice Mints a new 1-of-1 NFT pointing at `uri`, paid for by burning `burnAmount` $SDOGE
    ///         (approve this contract for it first). Reverts if the price has moved above
    ///         `maxBurnAmount`, so a price change landing first can never charge more than you
    ///         agreed to. You host whatever `uri` points at (e.g. your own IPFS pin).
    function mint(string calldata uri, uint256 maxBurnAmount) external nonReentrant returns (uint256 tokenId) {
        _checkUri(bytes(uri));
        uint256 amount = burnAmount;
        require(amount <= maxBurnAmount, "burn amount is above your limit");

        sdoge.safeTransferFrom(msg.sender, BURN_ADDRESS, amount);

        tokenId = nextTokenId++;
        _mint(msg.sender, tokenId);
        _setTokenURI(tokenId, uri); // set before the receiver hook runs, so the token is never seen without it
        ERC721Utils.checkOnERC721Received(msg.sender, address(0), msg.sender, tokenId, "");

        emit Minted(tokenId, msg.sender, uri, amount);
    }

    /// @notice For when $SDOGE's price moves enough that the burn needs retuning. Bounded between
    ///         1,000 and 100,000,000 SDOGE (18 decimals), which also catches a value entered
    ///         without its decimals. Never affects NFTs already minted.
    function setBurnAmount(uint256 newAmount) external onlyOwner {
        require(newAmount >= MIN_BURN_AMOUNT && newAmount <= MAX_BURN_AMOUNT, "burn amount out of range");
        emit BurnAmountUpdated(burnAmount, newAmount);
        burnAmount = newAmount;
    }

    function renounceOwnership() public view override onlyOwner {
        revert("renounce disabled");
    }

    function _checkUri(bytes calldata s) private pure {
        require(s.length > 0 && s.length <= MAX_URI_BYTES, "uri must be 1-512 bytes");
        for (uint256 i = 0; i < s.length; i++) {
            require(s[i] >= 0x21 && s[i] <= 0x7e, "uri must be printable ASCII without spaces");
        }
    }
}
