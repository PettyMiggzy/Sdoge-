// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PadPortal} from "./PadPortal.sol";
import {SdogePadHook} from "./SdogePadHook.sol";

/// @notice "A pad that launches pads." Anyone pays the setup fee and gets
/// their own white-label launchpad (a PadPortal) in the same transaction,
/// wired into the SAME shared SdogePadHook as the main pad. The pad owner runs
/// it: they set their share of every launch's revenue (0–85%; the platform always
/// takes 15%), an optional launch fee of up to $100, the highest tax
/// creators may pick and a minimum starting market cap. See the
/// "White-label pads" section of pad/README.md.
///
/// The live hook accepts exactly one factory, ever (bootstrapFactory is
/// one-shot), so this contract is permanent once plugged in. The only
/// knob the factory owner keeps is the setup fee, capped at
/// MAX_SETUP_FEE; a buyer passes the most they'll pay, so a fee change
/// can't catch them mid-transaction. The factory owner has no power over
/// pads, launches, tokens or liquidity.
contract SdogePadFactory {
    using SafeERC20 for IERC20;

    address public immutable poolManager;
    address public immutable hook; // shared across every pad (and the main pad)
    address public immutable treasury; // SdogePadTreasury: receives setup fees and the platform's 15%
    address public immutable quoteAsset; // USDC: every pad's quote asset, and what fees are paid in

    /// @dev Sanity ceiling in quoteAsset raw units: $10,000 in 6-decimal
    /// USDC. Also catches a fee written in the wrong decimals (audit
    /// factory-trust-2).
    uint256 public constant MAX_SETUP_FEE = 10_000e6;

    uint256 public setupFee;
    address public owner;
    address public pendingOwner;

    address[] public allPads;
    mapping(address => bool) public isPad;

    error ZeroFee();
    error ZeroAddress();
    error HookMismatch();
    error FeeTooHigh();
    error FeeChanged();
    error NotOwner();

    event PadDeployed(address indexed portal, address indexed owner, string label, uint256 feePaid);
    event SetupFeeChanged(uint256 oldFee, uint256 newFee);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    constructor(
        address poolManager_,
        address hook_,
        address treasury_,
        address quoteAsset_,
        uint256 setupFee_,
        address owner_
    ) {
        if (
            poolManager_ == address(0) || hook_ == address(0) || treasury_ == address(0) || quoteAsset_ == address(0)
                || owner_ == address(0)
        ) revert ZeroAddress();
        // Everything above is immutable, so a factory wired to a different
        // PoolManager than its hook could never launch a working pad.
        if (SdogePadHook(hook_).poolManager() != poolManager_) revert HookMismatch();
        poolManager = poolManager_;
        hook = hook_;
        treasury = treasury_;
        quoteAsset = quoteAsset_;
        owner = owner_;
        _setSetupFee(setupFee_);
    }

    /// @notice Pay the setup fee and get your own launchpad. `label` is the
    /// pad's name, informational only (branding lives off-chain).
    /// `maxSetupFee` is the most you agree to pay, normally the fee the site
    /// showed you. You must have approved this factory for the setup fee in
    /// quoteAsset.
    function deployPad(string calldata label, PadPortal.PadSettings calldata settings, uint256 maxSetupFee)
        external
        returns (address portal)
    {
        uint256 fee = setupFee;
        if (fee > maxSetupFee) revert FeeChanged();
        IERC20(quoteAsset).safeTransferFrom(msg.sender, treasury, fee);

        portal = address(new PadPortal(poolManager, hook, treasury, quoteAsset, msg.sender, settings));
        SdogePadHook(hook).authorizePortal(portal);

        isPad[portal] = true;
        allPads.push(portal);
        emit PadDeployed(portal, msg.sender, label, fee);
    }

    function padCount() external view returns (uint256) {
        return allPads.length;
    }

    // ------------------------------------------------------------------ owner

    /// @notice Changes the price of new pads. Existing pads are unaffected.
    function setSetupFee(uint256 newFee) external {
        if (msg.sender != owner) revert NotOwner();
        _setSetupFee(newFee);
    }

    function _setSetupFee(uint256 newFee) internal {
        // A $0 fee would make this a free clone factory for spam pads.
        if (newFee == 0) revert ZeroFee();
        if (newFee > MAX_SETUP_FEE) revert FeeTooHigh();
        emit SetupFeeChanged(setupFee, newFee);
        setupFee = newFee;
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
