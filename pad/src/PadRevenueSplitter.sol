// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISdogePadSplitter} from "./interfaces/ISdogePadSplitter.sol";

interface IPadOwnerSource {
    function padOwner() external view returns (address);
}

/// @notice Revenue splitter for a token launched on a white-label pad
/// (PadPortal). Same pull-based design as SdogePadRevenueSplitter, split three
/// ways instead of two:
/// - Platform: a fixed 15% (PLATFORM_SHARE_BPS);
/// - the pad owner: `padOwnerShareBps`, anywhere from 0 to 85%, whatever
///   the pad charged when this token launched;
/// - the token creator: the rest.
/// The pad owner's share is written in at construction and never changes,
/// so a pad owner changing their cut later only affects future launches.
/// Nothing is ever pushed out on deposit, so a blocklisted recipient can
/// only block its own claim, never the hook's flush or the other parties.
contract PadRevenueSplitter is ISdogePadSplitter {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant PLATFORM_SHARE_BPS = 1_500; // the platform's fixed 15% on every white-label pad
    uint256 public constant MAX_PAD_OWNER_SHARE_BPS = BPS_DENOMINATOR - PLATFORM_SHARE_BPS; // 85%
    // Read by the web app to label the split; white-label splits are never main-pad rated.
    bool public constant isMainPad = false;

    address public creator;
    address public pendingCreator;
    address public immutable treasury; // SdogePadTreasury: where the platform share is claimed to
    address public immutable portal; // the PadPortal that launched this token; source of the pad owner's address
    uint16 public immutable padOwnerShareBps; // of every deposit, locked at launch

    mapping(address => bool) public isAuthorizedSource;
    bool public sourcesLocked;

    mapping(address => uint256) public creditedToCreator; // per quote asset
    mapping(address => uint256) public creditedToPadOwner; // per quote asset
    mapping(address => uint256) public creditedToPlatform; // per quote asset

    error NotAuthorized();
    error NothingToClaim();
    error SourcesLocked();
    error ZeroAddress();
    error InvalidRecipient();
    error ShareTooHigh();

    event RevenueReceived(
        address indexed quoteAsset, uint256 total, uint256 platformCut, uint256 padOwnerCut, uint256 creatorCut
    );
    event CreatorClaimed(address indexed to, address indexed quoteAsset, uint256 amount);
    event PadOwnerClaimed(address indexed to, address indexed quoteAsset, uint256 amount);
    event PlatformClaimed(address indexed quoteAsset, uint256 amount, address indexed caller);
    event SourceAuthorized(address indexed source);
    event SourcesLockedEvent();
    event CreatorTransferStarted(address indexed from, address indexed to);
    event CreatorTransferred(address indexed from, address indexed to);

    constructor(address creator_, address treasury_, address portal_, uint16 padOwnerShareBps_) {
        if (creator_ == address(0) || treasury_ == address(0) || portal_ == address(0)) revert ZeroAddress();
        if (padOwnerShareBps_ > MAX_PAD_OWNER_SHARE_BPS) revert ShareTooHigh();
        creator = creator_;
        treasury = treasury_;
        portal = portal_;
        padOwnerShareBps = padOwnerShareBps_;
    }

    function authorizeSource(address source) external {
        if (msg.sender != portal) revert NotAuthorized();
        if (sourcesLocked) revert SourcesLocked();
        isAuthorizedSource[source] = true;
        emit SourceAuthorized(source);
    }

    function lockSources() external {
        if (msg.sender != portal) revert NotAuthorized();
        sourcesLocked = true;
        emit SourcesLockedEvent();
    }

    /// @notice Credits `amount` of `quoteAsset`, already transferred in by an
    /// authorized source (the hook's flush or the locker's fee harvest).
    function depositRevenue(address quoteAsset, uint256 amount) external override {
        if (!isAuthorizedSource[msg.sender]) revert NotAuthorized();
        if (amount == 0) return;
        _credit(quoteAsset, amount);
    }

    /// @notice Credits any balance above what is already owed, e.g. USDC sent
    /// here directly by mistake. Anyone may call; it only ever splits the
    /// surplus by the normal ratio.
    function sweepSurplus(address asset) external {
        uint256 owed = creditedToCreator[asset] + creditedToPadOwner[asset] + creditedToPlatform[asset];
        uint256 bal = IERC20(asset).balanceOf(address(this));
        if (bal <= owed) revert NothingToClaim();
        _credit(asset, bal - owed);
    }

    function _credit(address quoteAsset, uint256 amount) internal {
        uint256 platformCut = (amount * PLATFORM_SHARE_BPS) / BPS_DENOMINATOR;
        uint256 padOwnerCut = (amount * padOwnerShareBps) / BPS_DENOMINATOR;
        uint256 creatorCut = amount - platformCut - padOwnerCut; // rounding dust goes to the creator

        creditedToPlatform[quoteAsset] += platformCut;
        creditedToPadOwner[quoteAsset] += padOwnerCut;
        creditedToCreator[quoteAsset] += creatorCut;

        emit RevenueReceived(quoteAsset, amount, platformCut, padOwnerCut, creatorCut);
    }

    /// @notice Pays the creator's accrued `quoteAsset` to `to`. Creator only.
    function claim(address to, address quoteAsset) external override {
        if (msg.sender != creator) revert NotAuthorized();
        if (to == address(this) || to == address(0)) revert InvalidRecipient(); // paying itself would zero the credit and strand the funds
        uint256 amount = creditedToCreator[quoteAsset];
        if (amount == 0) revert NothingToClaim();
        creditedToCreator[quoteAsset] = 0;
        IERC20(quoteAsset).safeTransfer(to, amount);
        emit CreatorClaimed(to, quoteAsset, amount);
    }

    /// @notice Pays the pad owner's accrued `quoteAsset` to the pad's CURRENT
    /// owner (read from the portal, so it follows a pad ownership transfer).
    /// Anyone may call, since the money can only go to that one address.
    /// Returns 0 instead of reverting when nothing is owed, so the portal
    /// can sweep every launch on the pad in one transaction.
    function claimPadOwner(address quoteAsset) external returns (uint256 amount) {
        amount = creditedToPadOwner[quoteAsset];
        if (amount == 0) return 0;
        address to = IPadOwnerSource(portal).padOwner();
        creditedToPadOwner[quoteAsset] = 0;
        IERC20(quoteAsset).safeTransfer(to, amount);
        emit PadOwnerClaimed(to, quoteAsset, amount);
    }

    /// @notice Pays the platform's accrued `quoteAsset` to the treasury.
    /// Anyone may call.
    function claimPlatform(address quoteAsset) external override {
        uint256 amount = creditedToPlatform[quoteAsset];
        if (amount == 0) revert NothingToClaim();
        creditedToPlatform[quoteAsset] = 0;
        IERC20(quoteAsset).safeTransfer(treasury, amount);
        emit PlatformClaimed(quoteAsset, amount, msg.sender);
    }

    /// @notice Step 1 of 2: offer the creator role (and future claims) to `newCreator`.
    function transferCreator(address newCreator) external {
        if (msg.sender != creator) revert NotAuthorized();
        pendingCreator = newCreator;
        emit CreatorTransferStarted(creator, newCreator);
    }

    /// @notice Step 2 of 2: the offered address accepts.
    function acceptCreator() external {
        if (msg.sender != pendingCreator || msg.sender == address(0)) revert NotAuthorized();
        emit CreatorTransferred(creator, msg.sender);
        creator = msg.sender;
        pendingCreator = address(0);
    }
}
