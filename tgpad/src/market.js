// Every launch: USDC (6 decimals) is currency0, the token (18 decimals) is
// currency1, fixed 1B supply.
export const TOTAL_SUPPLY = 1_000_000_000;

export function usdPerToken(sqrtPriceX96) {
  const s = Number(BigInt(sqrtPriceX96)) / 2 ** 96;
  const tokensPerUsdcRaw = s * s;
  return tokensPerUsdcRaw > 0 ? 1e12 / tokensPerUsdcRaw : 0;
}

export const hourKey = (ms) => Math.floor(ms / 3_600_000);

export function volume24h(launch, now) {
  const from = hourKey(now) - 23;
  let sum = 0n;
  for (const [h, v] of Object.entries(launch.stats?.hourly ?? {})) if (Number(h) >= from) sum += BigInt(v);
  return sum;
}

export function recordSwap(launch, { usdc6, isBuy, sqrtPriceX96, at }) {
  const stats = (launch.stats ??= { buys: 0, sells: 0, volume6: '0', hourly: {} });
  const h = hourKey(at);
  stats.hourly[h] = (BigInt(stats.hourly[h] ?? 0) + usdc6).toString();
  for (const k of Object.keys(stats.hourly)) if (Number(k) < h - 47) delete stats.hourly[k];
  stats.volume6 = (BigInt(stats.volume6) + usdc6).toString();
  if (isBuy) stats.buys += 1;
  else stats.sells += 1;
  stats.lastSqrtPriceX96 = sqrtPriceX96.toString();
  stats.lastSwapAt = at;
}

// Redeeming `amount` tokens pays amount * backing / circulating (MemeVault).
export function redeemValue6(amount, { usdc6, owed6, circulating }) {
  return circulating > 0n ? (amount * (usdc6 + owed6)) / circulating : 0n;
}
