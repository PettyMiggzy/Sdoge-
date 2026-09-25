// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {SafeCast} from "v4-core/src/libraries/SafeCast.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IFeeRecipientSource {
    function feeRecipient() external view returns (address);
    function owner() external view returns (address);
}

/// One hook for every launchpad pool. The factory deploys it (so `factory` is fixed at
/// construction and can never be wrong or re-pointed). The hook:
///   - lets only the factory create pools and add liquidity, and blocks donations, so every pool
///     is exactly one locked, factory-owned position;
///   - charges a flat 2% of the USDC side of every swap, whichever direction and mode:
///       buy  (USDC in):  0.5% to the token's MemeVault, 0.5% to its creator, 1% to the platform
///       sell (USDC out): 2% to the platform
///   - keeps the price at or below the launch price. There is no liquidity above it, so without
///     this check anyone could push the price to the maximum for free;
///   - makes exact-input buys and exact-output sells fill completely, so nobody pays a fee on USDC
///     that never traded.
///
/// USDC is ALWAYS currency0, and it is the ERC-20 view at 0x3600...0000 (6 decimals). That is the
/// convention of the live SDOGE/USDC pool on Arc's shared PoolManager.
///
/// Fees never move during a swap. They are minted as ERC-6909 USDC claims inside the PoolManager:
/// the vault's share goes straight to the vault; the rest goes to this hook, which books it per
/// creator and for the platform. claim() and claimPlatform() turn those claims into USDC later.
contract LaunchpadHook is BaseHook, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeCast for uint256;

    address public constant USDC = 0x3600000000000000000000000000000000000000;
    uint256 internal constant USDC_ID = uint256(uint160(USDC)); // USDC's ERC-6909 id in the PoolManager

    uint256 public constant BPS = 10_000;
    uint256 public constant FEE_BPS = 200;           // 2% of the USDC side of a swap
    uint256 public constant BUY_VAULT_BPS = 2_500;   // share of a buy's fee: 0.5% of the buy
    uint256 public constant BUY_CREATOR_BPS = 2_500; // share of a buy's fee: 0.5% of the buy; the other half (1%) is the platform's

    address public immutable factory;

    struct PoolInfo {
        address creator;
        address vault;
        uint160 startSqrtPriceX96; // the launch price, recorded when the pool is initialized
    }

    mapping(PoolId => PoolInfo) public pools;
    mapping(PoolId => address) public pendingCreator;
    mapping(address => uint256) public owed; // creators' unclaimed fees, USDC (6 decimals)
    uint256 public platformOwed;             // the platform's unclaimed fees, paid to the factory's feeRecipient

    event Registered(PoolId indexed id, address creator, address vault);
    event FeeTaken(PoolId indexed id, bool buy, uint256 fee);
    event Claimed(address indexed account, uint256 amount);
    event PlatformClaimed(address indexed to, uint256 amount);
    event CreatorTransferStarted(PoolId indexed id, address indexed from, address indexed to);
    event CreatorTransferred(PoolId indexed id, address indexed from, address indexed to);

    error NotFactory();
    error NotOwner();
    error UnknownPool();
    error AlreadyRegistered();
    error ZeroAddress();
    error UsdcMustBeCurrency0();
    error PartialFill();
    error PriceAboveStart();
    error DonationsDisabled();
    error NotCreator();
    error NotPendingCreator();

    constructor(IPoolManager poolManager_) BaseHook(poolManager_) {
        factory = msg.sender;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: true,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ------------------------------------------------------------------ factory

    function register(PoolKey calldata key, address creator, address vault) external {
        if (msg.sender != factory) revert NotFactory();
        if (creator == address(0) || vault == address(0)) revert ZeroAddress();
        PoolId id = key.toId();
        if (pools[id].vault != address(0)) revert AlreadyRegistered();
        pools[id] = PoolInfo(creator, vault, 0);
        emit Registered(id, creator, vault);
    }

    // ------------------------------------------------------------------ pool guards

    function _beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        internal
        override
        returns (bytes4)
    {
        if (sender != factory) revert NotFactory();
        if (Currency.unwrap(key.currency0) != USDC) revert UsdcMustBeCurrency0();
        PoolInfo storage info = pools[key.toId()];
        if (info.vault == address(0)) revert UnknownPool();
        info.startSqrtPriceX96 = sqrtPriceX96;
        return this.beforeInitialize.selector;
    }

    function _beforeAddLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        internal
        view
        override
        returns (bytes4)
    {
        if (sender != factory) revert NotFactory();
        return this.beforeAddLiquidity.selector;
    }

    // A donation would land in the factory's position, which nothing can ever withdraw.
    function _beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        revert DonationsDisabled();
    }

    // ------------------------------------------------------------------ fees

    // USDC is the specified currency (exact-input buy or exact-output sell): the fee has to come
    // off here, on the specified amount, before the pool trades.
    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata p, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        PoolInfo storage info = pools[id];
        if (info.vault == address(0)) revert UnknownPool();
        if (!_usdcSpecified(p)) return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        uint256 fee = _specifiedFee(p);
        if (fee > 0) _collect(id, info, fee, p.zeroForOne);
        // Exact-in buy: the pool trades amount - fee. Exact-out sell: the pool pays out amount + fee
        // and the seller receives amount.
        return (this.beforeSwap.selector, toBeforeSwapDelta(fee.toInt128(), 0), 0);
    }

    function _afterSwap(address, PoolKey calldata key, SwapParams calldata p, BalanceDelta d, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        PoolId id = key.toId();
        PoolInfo storage info = pools[id];
        // USDC the pool itself took in (buy) or paid out (sell) in this swap.
        uint256 poolUsdc = p.zeroForOne ? uint256(uint128(-d.amount0())) : uint256(uint128(d.amount0()));

        int128 feeDelta;
        if (_usdcSpecified(p)) {
            // The fee was charged on the requested amount, so the pool must have traded all of it.
            uint256 fee = _specifiedFee(p);
            uint256 requested = _abs(p.amountSpecified);
            if (poolUsdc != (p.zeroForOne ? requested - fee : requested + fee)) revert PartialFill();
        } else {
            // Exact-out buy: the buyer pays poolUsdc + fee, and the fee is 2% of that total.
            // Exact-in sell: the pool pays out poolUsdc, the fee is 2% of it, and the seller gets the rest.
            uint256 fee = p.zeroForOne
                ? Math.mulDiv(poolUsdc, FEE_BPS, BPS - FEE_BPS, Math.Rounding.Ceil)
                : poolUsdc * FEE_BPS / BPS;
            if (fee > 0) _collect(id, info, fee, p.zeroForOne);
            feeDelta = fee.toInt128();
        }

        if (!p.zeroForOne) {
            (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(id);
            if (sqrtPriceX96 > info.startSqrtPriceX96) revert PriceAboveStart();
        }
        return (this.afterSwap.selector, feeDelta);
    }

    function _usdcSpecified(SwapParams calldata p) private pure returns (bool) {
        return p.zeroForOne == (p.amountSpecified < 0);
    }

    // Exact-in buy: 2% of the USDC paid in.
    // Exact-out sell: the pool pays out amount + fee and the seller keeps amount, so the fee is 2% of
    // that gross: amount * 200 / 9800, rounded up.
    function _specifiedFee(SwapParams calldata p) private pure returns (uint256) {
        uint256 amount = _abs(p.amountSpecified);
        return p.zeroForOne ? amount * FEE_BPS / BPS : Math.mulDiv(amount, FEE_BPS, BPS - FEE_BPS, Math.Rounding.Ceil);
    }

    function _abs(int256 x) private pure returns (uint256) {
        // Both branches are non-negative; -type(int256).min would revert (checked arithmetic).
        // forge-lint: disable-next-line(unsafe-typecast)
        return x < 0 ? uint256(-x) : uint256(x);
    }

    // Mints the fee as USDC claims (moves no tokens), then books who it belongs to.
    function _collect(PoolId id, PoolInfo storage info, uint256 fee, bool buy) private {
        if (buy) {
            uint256 toVault = fee * BUY_VAULT_BPS / BPS;
            uint256 toCreator = fee * BUY_CREATOR_BPS / BPS;
            uint256 rest = fee - toVault; // creator + platform, held by this hook
            if (toVault > 0) poolManager.mint(info.vault, USDC_ID, toVault);
            if (rest > 0) poolManager.mint(address(this), USDC_ID, rest);
            if (toCreator > 0) owed[info.creator] += toCreator;
            platformOwed += rest - toCreator;
        } else {
            poolManager.mint(address(this), USDC_ID, fee);
            platformOwed += fee;
        }
        emit FeeTaken(id, buy, fee);
    }

    // ------------------------------------------------------------------ payouts

    /// Pays `account` its accrued creator fees. Anyone may trigger it; the USDC only ever goes to
    /// `account`. Not callable from inside a PoolManager unlock.
    function claim(address account) external returns (uint256 amount) {
        amount = owed[account];
        if (amount == 0) return 0;
        owed[account] = 0;
        poolManager.unlock(abi.encode(account, amount));
        emit Claimed(account, amount);
    }

    /// Pays the platform's accrued fees to the factory's current feeRecipient. Only the factory's
    /// owner may trigger it, so a recipient being rotated out (say, a leaked key) can't be raced.
    function claimPlatform() external returns (uint256 amount) {
        if (msg.sender != IFeeRecipientSource(factory).owner()) revert NotOwner();
        amount = platformOwed;
        if (amount == 0) return 0;
        platformOwed = 0;
        address to = IFeeRecipientSource(factory).feeRecipient();
        poolManager.unlock(abi.encode(to, amount));
        emit PlatformClaimed(to, amount);
    }

    /// Only reachable through this hook's own poolManager.unlock() above: turns claims into USDC.
    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (address to, uint256 amount) = abi.decode(data, (address, uint256));
        poolManager.burn(address(this), USDC_ID, amount);
        poolManager.take(Currency.wrap(USDC), to, amount);
        return "";
    }

    // ------------------------------------------------------------------ creator handover

    /// Starts moving a token's creator fees to `newCreator`, who must call acceptCreator().
    /// Fees already owed stay claimable by the current creator. Pass address(0) to cancel.
    function transferCreator(PoolId id, address newCreator) external {
        if (msg.sender != pools[id].creator) revert NotCreator();
        pendingCreator[id] = newCreator;
        emit CreatorTransferStarted(id, msg.sender, newCreator);
    }

    function acceptCreator(PoolId id) external {
        if (msg.sender != pendingCreator[id]) revert NotPendingCreator();
        address previous = pools[id].creator;
        pools[id].creator = msg.sender;
        delete pendingCreator[id];
        emit CreatorTransferred(id, previous, msg.sender);
    }
}
