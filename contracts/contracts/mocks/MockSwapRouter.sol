// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMockPermit2 {
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

/// @notice Test-only stand-in for Uniswap's Universal Router on Arc, for the site's swap box
///         (assets/js/swap.js). It takes exactly the input Arc's router (v2.1.1) takes for one
///         V4_SWAP of SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL (six-field swap params), prices
///         it at a fixed rate, pulls the input through Permit2 and pays the output. A quote
///         (SWAP_EXACT_IN_SINGLE, TAKE_ALL with an impossible minimum) reverts with
///         V4TooLittleReceived(min, out), like the real one.
contract MockSwapRouter {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36;
        bytes hookData;
    }

    error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived);
    error DeadlinePassed(uint256 deadline);

    IMockPermit2 public immutable permit2;
    bytes32 public immutable poolId;
    uint256[2][2] internal rates; // [zeroForOne ? 0 : 1] = [numerator, denominator]
    uint256 public executeHaircutBps; // pays this much less on execute than a quote says
    uint256 public swaps;
    uint256 public lastMinOut;
    uint256 public lastDeadline;

    constructor(address permit2_, bytes32 poolId_) {
        permit2 = IMockPermit2(permit2_);
        poolId = poolId_;
    }

    function setRates(uint256 zeroForOneNum, uint256 zeroForOneDen, uint256 oneForZeroNum, uint256 oneForZeroDen) external {
        rates[0] = [zeroForOneNum, zeroForOneDen];
        rates[1] = [oneForZeroNum, oneForZeroDen];
    }

    function setExecuteHaircutBps(uint256 bps) external {
        executeHaircutBps = bps;
    }

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable {
        if (block.timestamp > deadline) revert DeadlinePassed(deadline);
        require(commands.length == 1 && uint8(commands[0]) == 0x10 && inputs.length == 1, "one V4_SWAP");
        (bytes memory actions, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        ExactInputSingleParams memory p = abi.decode(params[0], (ExactInputSingleParams));
        require(keccak256(abi.encode(p.poolKey)) == poolId, "wrong pool");
        require(p.minHopPriceX36 == 0 && p.hookData.length == 0, "unexpected swap options");
        uint256[2] memory r = rates[p.zeroForOne ? 0 : 1];
        uint256 out = (uint256(p.amountIn) * r[0]) / r[1];
        (address currencyIn, address currencyOut) =
            p.zeroForOne ? (p.poolKey.currency0, p.poolKey.currency1) : (p.poolKey.currency1, p.poolKey.currency0);

        if (actions.length == 2) {
            require(uint8(actions[0]) == 0x06 && uint8(actions[1]) == 0x0f, "quote actions");
            (address takeCurrency, uint256 minTake) = abi.decode(params[1], (address, uint256));
            require(takeCurrency == currencyOut, "take currency");
            if (out < minTake) revert V4TooLittleReceived(minTake, out);
            revert("a quote must ask for an impossible minimum");
        }

        require(
            actions.length == 3 && uint8(actions[0]) == 0x06 && uint8(actions[1]) == 0x0c && uint8(actions[2]) == 0x0f,
            "swap actions"
        );
        (address settleCurrency, uint256 maxIn) = abi.decode(params[1], (address, uint256));
        (address takeCurrencyOut, uint256 minOut) = abi.decode(params[2], (address, uint256));
        require(settleCurrency == currencyIn && maxIn == p.amountIn && takeCurrencyOut == currencyOut, "settle/take");
        out -= (out * executeHaircutBps) / 10_000;
        if (out < p.amountOutMinimum || out < minOut) revert V4TooLittleReceived(minOut, out);
        permit2.transferFrom(msg.sender, address(this), uint160(p.amountIn), currencyIn);
        require(IERC20(currencyOut).transfer(msg.sender, out), "payout failed");
        swaps += 1;
        lastMinOut = minOut;
        lastDeadline = deadline;
    }
}
