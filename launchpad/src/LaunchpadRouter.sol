// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {LaunchpadFactory} from "./LaunchpadFactory.sol";

/// Buys and sells launchpad tokens with a minimum output and a deadline, and quotes both
/// directions exactly (the hook's 2% included) by running the swap and reverting it.
///
/// Every trade is exact-input and fills completely or reverts. The router keeps nothing between
/// transactions: it only ever moves the exact amount the caller is trading.
contract LaunchpadRouter is IUnlockCallback, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    address public constant USDC = 0x3600000000000000000000000000000000000000;
    // Arc's native USDC has 18 decimals; the ERC-20 view the pools use has 6 and shares the balance.
    uint256 public constant NATIVE_PER_USDC_UNIT = 1e12;
    uint256 private constant MAX_AMOUNT = uint256(uint128(type(int128).max));

    IPoolManager public immutable poolManager;
    LaunchpadFactory public immutable factory;

    enum Kind {
        Buy,
        Sell,
        QuoteBuy,
        QuoteSell
    }

    struct SwapCall {
        Kind kind;
        address token;
        uint256 amountIn;
        address payer; // this router for buyWithNative
        address to;
    }

    event Bought(address indexed token, address indexed payer, address indexed to, uint256 usdcIn, uint256 tokensOut);
    event Sold(address indexed token, address indexed payer, address indexed to, uint256 tokensIn, uint256 usdcOut);

    error Expired();
    error BadAmount();
    error BadNativeAmount();
    error ZeroAddress();
    error ZeroOutput();
    error InsufficientOutput(uint256 out, uint256 minOut);
    error NotPoolManager();
    error UnexpectedDelta();
    error QuoteResult(uint256 out);

    constructor(IPoolManager poolManager_, LaunchpadFactory factory_) {
        if (address(poolManager_) == address(0) || address(factory_) == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
        factory = factory_;
    }

    /// Spends exactly `usdcIn` (6 decimals) of the caller's USDC (approve this router first).
    function buy(address token, uint256 usdcIn, uint256 minTokensOut, address to, uint256 deadline)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        _checkTrade(usdcIn, to, deadline);
        tokensOut = _run(SwapCall(Kind.Buy, token, usdcIn, msg.sender, to));
        if (tokensOut < minTokensOut) revert InsufficientOutput(tokensOut, minTokensOut);
        emit Bought(token, msg.sender, to, usdcIn, tokensOut);
    }

    /// The same, paid with native USDC (msg.value, 18 decimals): one transaction, no approval.
    /// msg.value must be a whole number of 6-decimal units (a multiple of 1e12).
    function buyWithNative(address token, uint256 minTokensOut, address to, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (msg.value % NATIVE_PER_USDC_UNIT != 0) revert BadNativeAmount();
        uint256 usdcIn = msg.value / NATIVE_PER_USDC_UNIT;
        _checkTrade(usdcIn, to, deadline);
        tokensOut = _run(SwapCall(Kind.Buy, token, usdcIn, address(this), to));
        if (tokensOut < minTokensOut) revert InsufficientOutput(tokensOut, minTokensOut);
        emit Bought(token, msg.sender, to, usdcIn, tokensOut);
    }

    /// Sells exactly `tokensIn` of the caller's tokens (approve this router first); `to` gets the USDC.
    function sell(address token, uint256 tokensIn, uint256 minUsdcOut, address to, uint256 deadline)
        external
        nonReentrant
        returns (uint256 usdcOut)
    {
        _checkTrade(tokensIn, to, deadline);
        usdcOut = _run(SwapCall(Kind.Sell, token, tokensIn, msg.sender, to));
        if (usdcOut < minUsdcOut) revert InsufficientOutput(usdcOut, minUsdcOut);
        emit Sold(token, msg.sender, to, tokensIn, usdcOut);
    }

    /// Tokens a buy of `usdcIn` would get right now. Not a view: call it with eth_call / staticCall.
    function quoteBuy(address token, uint256 usdcIn) external returns (uint256) {
        return _quote(SwapCall(Kind.QuoteBuy, token, usdcIn, address(0), address(0)));
    }

    /// USDC (after the fee) a sell of `tokensIn` would get right now. Not a view: use eth_call.
    function quoteSell(address token, uint256 tokensIn) external returns (uint256) {
        return _quote(SwapCall(Kind.QuoteSell, token, tokensIn, address(0), address(0)));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        SwapCall memory c = abi.decode(data, (SwapCall));
        PoolKey memory key = factory.poolKeyOf(c.token); // reverts for anything the factory didn't launch
        bool isBuy = c.kind == Kind.Buy || c.kind == Kind.QuoteBuy;

        BalanceDelta d = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: isBuy,
                amountSpecified: -int256(c.amountIn),
                sqrtPriceLimitX96: isBuy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (int128 paid, int128 got) = isBuy ? (d.amount0(), d.amount1()) : (d.amount1(), d.amount0());
        // The hook makes exact-in buys fill completely and caps sells at the launch price, so the
        // whole input is always spent; anything else is a bug and must not leave funds behind.
        if (int256(paid) != -int256(c.amountIn) || got < 0) revert UnexpectedDelta();
        // forge-lint: disable-next-line(unsafe-typecast) - got >= 0 was just checked
        uint256 out = uint256(uint128(got));
        if (c.kind == Kind.QuoteBuy || c.kind == Kind.QuoteSell) revert QuoteResult(out);
        if (out == 0) revert ZeroOutput();

        Currency input = isBuy ? key.currency0 : key.currency1;
        poolManager.sync(input);
        if (c.payer == address(this)) {
            IERC20(Currency.unwrap(input)).safeTransfer(address(poolManager), c.amountIn);
        } else {
            IERC20(Currency.unwrap(input)).safeTransferFrom(c.payer, address(poolManager), c.amountIn);
        }
        poolManager.settle();
        poolManager.take(isBuy ? key.currency1 : key.currency0, c.to, out);
        return abi.encode(out);
    }

    function _checkTrade(uint256 amount, address to, uint256 deadline) private view {
        if (block.timestamp > deadline) revert Expired();
        if (amount == 0 || amount > MAX_AMOUNT) revert BadAmount();
        if (to == address(0)) revert ZeroAddress();
    }

    function _run(SwapCall memory c) private returns (uint256) {
        return abi.decode(poolManager.unlock(abi.encode(c)), (uint256));
    }

    function _quote(SwapCall memory c) private returns (uint256 out) {
        if (c.amountIn == 0 || c.amountIn > MAX_AMOUNT) revert BadAmount();
        try poolManager.unlock(abi.encode(c)) {
            revert UnexpectedDelta(); // unreachable: a quote always reverts with its result
        } catch (bytes memory reason) {
            // forge-lint: disable-next-line(unsafe-typecast) - truncating to the selector is the point
            if (reason.length == 36 && bytes4(reason) == QuoteResult.selector) {
                assembly ("memory-safe") {
                    out := mload(add(reason, 36))
                }
            } else {
                assembly ("memory-safe") {
                    revert(add(reason, 32), mload(reason))
                }
            }
        }
    }
}
