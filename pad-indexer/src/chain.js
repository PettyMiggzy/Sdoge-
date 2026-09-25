import { createPublicClient, http, parseAbiItem, formatUnits } from 'viem';
import { CFG } from './config.js';

export const client = createPublicClient({
  transport: http(CFG.rpcUrl, { batch: { batchSize: 50 }, retryCount: 5, retryDelay: 800 }),
});

// Signatures match the audited contracts in pad/src exactly. A stale
// signature here doesn't error, it just makes getLogs match zero logs (the
// event topic hash changes), so double-check against pad/src/*.sol or
// pad-web/lib/abi.ts before editing.
export const EV = {
  launch: parseAbiItem(
    'event LaunchCreated(address indexed token, address indexed creator, address locker, address splitter, bytes32 poolId, address quoteAsset, bool tokenIsToken0, uint16 buyTaxBps, uint16 sellTaxBps, int24 tickLower, int24 tickUpper, uint160 initSqrtPriceX96, string name, string symbol)',
  ),
  swap: parseAbiItem(
    'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
  ),
  transfer: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
  tax: parseAbiItem('event TaxCollected(bytes32 indexed poolId, address indexed quoteAsset, bool isBuy, uint256 amount)'),
};

/**
 * Price of 1 launch token in quote units, from a post-swap sqrtPriceX96.
 * Same bit math as pad-web/lib/pool.ts's priceFromSqrt — verified
 * there against v4-core's actual Slot0 packing, not re-derived here.
 */
export function priceFromSqrt(sqrtPriceX96, tokenIsToken0) {
  const sp = Number(sqrtPriceX96) / 2 ** 96;
  const raw1per0 = sp * sp;
  const scale = 10 ** (CFG.tokenDecimals - CFG.quoteDecimals);
  return tokenIsToken0 ? raw1per0 * scale : (1 / raw1per0) * scale;
}

export const fmtToken = (x) => Number(formatUnits(x, CFG.tokenDecimals));
export const fmtQuote = (x) => Number(formatUnits(x, CFG.quoteDecimals));

const tsCache = new Map();
export async function blockTs(bn) {
  if (!tsCache.has(bn)) tsCache.set(bn, Number((await client.getBlock({ blockNumber: bn })).timestamp));
  return tsCache.get(bn);
}

/** tx.from for a set of hashes — Swap.sender is the router/PoolManager caller, not the EOA trader. */
export async function txSenders(hashes) {
  const out = new Map();
  await Promise.all(
    [...new Set(hashes)].map(async (h) => {
      const t = await client.getTransaction({ hash: h });
      out.set(h, t.from.toLowerCase());
    }),
  );
  return out;
}
