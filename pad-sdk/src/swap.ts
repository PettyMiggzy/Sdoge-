import {
  decodeErrorResult, encodeAbiParameters, encodeFunctionData, encodePacked, maxUint256, parseAbi,
  type Address, type Hex, type PublicClient,
} from 'viem';
import { universalRouterAbi } from './abis.js';
import type { PoolKey } from './pool.js';

// Universal Router command and v4 action ids (Uniswap v4-periphery Actions.sol).
const CMD_V4_SWAP = 0x10;
const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
const ACT_SETTLE_ALL = 0x0c;
const ACT_TAKE_ALL = 0x0f;

const POOL_KEY_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
  ],
} as const;

const routerErrorsAbi = parseAbi(['error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)']);
const NO_LIQUIDITY_SELECTOR = '43d335e6'; // SdogePadHook.NoLiquidityToFill()
const WRAPPED_ERROR_SELECTOR = '0x90bfb865'; // PoolManager.WrappedError(address,bytes4,bytes,bytes)

export type SwapLeg = { key: PoolKey; zeroForOne: boolean; amountIn: bigint; currencyIn: Address; currencyOut: Address };

function encodeSwapParams(p: SwapLeg, amountOutMin: bigint): Hex {
  return encodeAbiParameters(
    [{
      type: 'tuple',
      components: [
        { name: 'poolKey', ...POOL_KEY_TUPLE }, { name: 'zeroForOne', type: 'bool' },
        { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' },
        // Arc's Universal Router (v2.1.1) takes six fields here. The fifth is a
        // per-hop minimum price scaled by 1e36 (0 = off), not a sqrt price
        // limit. Leaving it out makes every swap revert with empty data.
        { name: 'minHopPriceX36', type: 'uint256' },
        { name: 'hookData', type: 'bytes' },
      ],
    }],
    [{ poolKey: p.key, zeroForOne: p.zeroForOne, amountIn: p.amountIn, amountOutMinimum: amountOutMin, minHopPriceX36: 0n, hookData: '0x' }],
  );
}

const pair = (currency: Address, amount: bigint) => encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currency, amount]);
const deadlineIn = (sec: number) => BigInt(Math.floor(Date.now() / 1000) + sec);

/** Arguments for `UniversalRouter.execute` doing one exact-input swap on one pool. */
export function buildExactInSwap(p: SwapLeg & { amountOutMin: bigint; deadlineSec?: number }) {
  if (p.amountOutMin <= 0n) throw new Error('Refusing to build a swap without a minimum output');
  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL]);
  const v4Input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [
    actions,
    [encodeSwapParams(p, p.amountOutMin), pair(p.currencyIn, p.amountIn), pair(p.currencyOut, p.amountOutMin)],
  ]);
  return { args: [encodePacked(['uint8'], [CMD_V4_SWAP]), [v4Input], deadlineIn(p.deadlineSec ?? 600)] as const };
}

/**
 * Exact output of a swap from the live pool, with the hook's tax, the LP fee
 * and price impact all included. It eth_calls the router with a take of
 * "at least max uint", which reverts with the real amount before anything
 * settles, so it needs no balance or approval and never moves funds.
 * Returns 0n when the pool has nothing to fill against (a sell before
 * anyone has bought).
 */
export async function quoteExactIn(client: PublicClient, router: Address, p: SwapLeg): Promise<bigint> {
  const actions = encodePacked(['uint8', 'uint8'], [ACT_SWAP_EXACT_IN_SINGLE, ACT_TAKE_ALL]);
  const v4Input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [encodeSwapParams(p, 0n), pair(p.currencyOut, maxUint256)]]);
  const data = encodeFunctionData({ abi: universalRouterAbi, functionName: 'execute', args: [encodePacked(['uint8'], [CMD_V4_SWAP]), [v4Input], deadlineIn(600)] });
  try {
    await client.call({ to: router, data });
  } catch (e) {
    let err: unknown = e;
    for (let i = 0; i < 8 && err; i++) {
      const raw = (err as { data?: unknown }).data;
      const hex = typeof raw === 'string' ? raw : (raw as { data?: unknown } | undefined)?.data;
      if (typeof hex === 'string' && hex.startsWith('0x')) {
        try {
          return decodeErrorResult({ abi: routerErrorsAbi, data: hex as Hex }).args[1];
        } catch { /* a different revert */ }
        // A swap that would fill nothing reverts in the hook (NoLiquidityToFill).
        if (hex.startsWith(WRAPPED_ERROR_SELECTOR) && hex.includes(NO_LIQUIDITY_SELECTOR)) return 0n;
      }
      err = (err as { cause?: unknown }).cause;
    }
    throw e;
  }
  throw new Error('Quote call unexpectedly succeeded');
}

/** `amountOut` less `slippageBps` (100 = 1%), never below 1 unit. */
export function withSlippage(amountOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) throw new Error('slippageBps must be an integer from 0 to 9999');
  const min = (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  return min > 0n ? min : 1n;
}
