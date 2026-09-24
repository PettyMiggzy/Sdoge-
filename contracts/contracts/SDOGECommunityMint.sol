// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SDOGECommunityMint
/// @notice Permissionless companion to SDOGECollectibles: instead of an
///         owner-curated design roster paid for in USDC, anyone can mint
///         their own 1-of-1 NFT from art they host themselves, paid for by
///         burning `burnAmount` (default 1,000,000) $SDOGE. Each mint is a
///         unique token - hence ERC-721, not ERC-1155 - since there's no
///         shared "design" to mint copies of.
///
/// Deliberate product decision, not an oversight: the `tokenURI` a minter
/// supplies is never checked on-chain. There is no admin review queue and
/// no automated content filter. A smart contract cannot meaningfully
/// inspect what an arbitrary URI points to anyway, and moderation was
/// explicitly decided against in favor of a fully open, instant mint. If
/// that changes later, add the check in whatever mints tokenURI-bearing
/// content upstream of this contract (or replace `mint` with an
/// owner-gated variant) - nothing here assumes it stays this way forever.
///
/// $SDOGE's deployed token (verified on-chain, not assumed) exposes only
/// standard ERC-20 functions - no `burn`/`burnFrom`/`redeem` of any kind.
/// So "burned" here means transferred to the standard dead address
/// (0x000...dEaD), the universal pattern for permanently removing tokens
/// from circulation on a token that has no native burn function, rather
/// than guessing at some other privileged call.
contract SDOGECommunityMint is ERC721URIStorage, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable sdoge;
    uint256 public burnAmount = 1_000_000 ether;
    uint256 public nextTokenId = 1;

    event Minted(uint256 indexed tokenId, address indexed minter, string tokenURI, uint256 burned);
    event BurnAmountUpdated(uint256 oldAmount, uint256 newAmount);

    constructor(
        address sdogeToken,
        address owner_
    ) ERC721("SDOGE Community Art", "SDOGEART") Ownable(owner_) {
        require(sdogeToken != address(0), "bad token address");
        sdoge = IERC20(sdogeToken);
    }

    /// @notice Mint a new 1-of-1 NFT pointing at `uri`, paid for by burning
    ///         `burnAmount` $SDOGE from the caller. Requires the caller to
    ///         have approved this contract for at least `burnAmount` first.
    ///         Caller is responsible for hosting whatever `uri` resolves to
    ///         (e.g. their own IPFS pin) - this contract never touches it
    ///         beyond storing the string.
    function mint(string calldata uri) external nonReentrant returns (uint256 tokenId) {
        require(bytes(uri).length > 0, "empty uri");

        uint256 amount = burnAmount;
        sdoge.safeTransferFrom(msg.sender, BURN_ADDRESS, amount);

        tokenId = nextTokenId++;
        _safeMint(msg.sender, tokenId);
        _setTokenURI(tokenId, uri);

        emit Minted(tokenId, msg.sender, uri, amount);
    }

    /// @notice Owner-tunable in case $SDOGE's price moves enough that the
    ///         fixed 1,000,000 figure stops making sense - never affects
    ///         NFTs already minted, only future ones.
    function setBurnAmount(uint256 newAmount) external onlyOwner {
        require(newAmount > 0, "burn amount must be > 0");
        emit BurnAmountUpdated(burnAmount, newAmount);
        burnAmount = newAmount;
    }
}
