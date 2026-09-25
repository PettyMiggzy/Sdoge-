import { createPublicClient, http, type Address } from 'viem';
import { arc } from './chain';
import { CONFIG } from './config';
import { poolManagerAbi, erc20Abi } from './abi';
import { poolKeyFor, poolId, slot0Slot, decodeSlot0, priceFromSqrt, priceFromTick } from './pool';

export const publicClient = createPublicClient({ chain: arc, transport: http(CONFIG.rpcUrl, { batch: true }) });

export type Launch = {
  token: Address; creator: Address; locker: Address; splitter: Address; poolId: `0x${string}`;
  name: string; symbol: string; blockNumber: bigint; txHash: `0x${string}`; createdAt: number;
  // From LaunchCreated; optional because pad-indexer's /launches payload doesn't carry them.
  tokenIsToken0?: boolean; buyTaxBps?: number; sellTaxBps?: number; tickLower?: number; tickUpper?: number;
};

const rangeOf = (l?: Launch | null) => (l && l.tickLower !== undefined && l.tickUpper !== undefined ? { tickLower: l.tickLower, tickUpper: l.tickUpper } : undefined);

// priceUsd/marketCapUsd are always real (read straight from pool state — see
// fetchSpot). The rest need trade history no cheap on-chain read can give
// us, so they're `undefined` — not a guess, not a fabricated placeholder —
// until NEXT_PUBLIC_INDEXER_URL points at a running pad-indexer. Every
// consumer already renders `undefined` as "—" (fmtUsd/fmtPct), so this is
// the honest value, not a display bug.
export type TokenStats = {
  priceUsd: number; marketCapUsd: number; volume24hUsd?: number; change24hPct?: number;
  holders?: number; txns24h?: number; liquidityUsd?: number;
};

export type Trade = { hash: `0x${string}`; ts: number; isBuy: boolean; usd: number; tokens: number; trader: Address };
export type Holder = { address: Address; balance: number; pct: number; tag?: string };
export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

// ---------------------------------------------------------------------------
// Optional real data source: pad-indexer's HTTP API. Every function below tries
// this first (when NEXT_PUBLIC_INDEXER_URL is set) and falls back to a
// real on-chain read where one exists cheaply (the /api/launches index,
// getHolders' locker balance) or an honest empty/unknown result where it
// doesn't — never to invented numbers — so the app keeps working, truthfully,
// with zero indexer configured.
// ---------------------------------------------------------------------------
async function indexerGet<T>(path: string): Promise<T | null> {
  if (!CONFIG.indexerUrl) return null;
  try {
    const res = await fetch(`${CONFIG.indexerUrl}${path}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Launches come from this deployment's own /api/launches index (a server-side
// incremental scan of LaunchCreated logs, cached in Postgres — see
// lib/launches.ts), so browsers never scan chain history themselves.
// ---------------------------------------------------------------------------
type LaunchJson = Omit<Launch, 'blockNumber'> & { blockNumber: string | number };
const fromJson = (l: LaunchJson): Launch => ({ ...l, blockNumber: BigInt(l.blockNumber) });

async function launchApi(query = ''): Promise<Launch[]> {
  const res = await fetch(`/api/launches${query}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`The launch list request failed (${res.status})`);
  const body = (await res.json()) as { launches: LaunchJson[] };
  return body.launches.map(fromJson);
}

export async function fetchLaunches(): Promise<Launch[]> {
  const indexed = await indexerGet<LaunchJson[]>('/launches');
  if (indexed) return indexed.map(fromJson);
  return launchApi();
}

/** null only when the index confirms the address isn't a launch; throws when the lookup itself fails. */
export async function fetchLaunch(token: Address): Promise<Launch | null> {
  const [hit] = await launchApi(`?token=${token}`);
  return hit ?? null;
}

// ---------------------------------------------------------------------------
// REAL: spot price + market cap straight from PoolManager storage.
// ---------------------------------------------------------------------------
/**
 * When the launch's position range is known, the displayed price is clamped
 * to it. Outside the range there is no liquidity, so slot0 there is not a
 * tradable price — and anyone can move it there for free (a swap across empty
 * ticks costs nothing), which would otherwise let a griefer make any fresh
 * launch show a ~$0 or absurd market cap.
 */
export async function fetchSpot(token: Address, range?: { tickLower: number; tickUpper: number }) {
  const { key, tokenIsToken0 } = poolKeyFor(token);
  const id = poolId(key);
  const word = await publicClient.readContract({ address: CONFIG.poolManager, abi: poolManagerAbi, functionName: 'extsload', args: [slot0Slot(id)] });
  const s0 = decodeSlot0(word);
  let priceUsd = s0.sqrtPriceX96 === 0n ? 0 : priceFromSqrt(s0.sqrtPriceX96, tokenIsToken0, CONFIG.quoteDecimals);
  if (range && s0.sqrtPriceX96 !== 0n && (s0.tick < range.tickLower || s0.tick >= range.tickUpper)) {
    const edge = s0.tick < range.tickLower ? range.tickLower : range.tickUpper;
    priceUsd = priceFromTick(edge, tokenIsToken0, CONFIG.quoteDecimals);
  }
  return { priceUsd, marketCapUsd: priceUsd * 1e9, tick: s0.tick, poolId: id, tokenIsToken0 };
}

// ---------------------------------------------------------------------------
// getStats / getTrades / getHolders / getCandles all prefer pad-indexer's
// HTTP API (see indexerGet above). Without one configured, each falls back to
// whatever is CHEAPLY and HONESTLY readable straight from chain — never to
// invented numbers. Trade history, holder counts and OHLC candles need a
// real event-log index to answer honestly, so those come back empty/unknown
// until NEXT_PUBLIC_INDEXER_URL points at a running pad-indexer — every
// consumer (StatCards, TradesTable, HoldersTable, CandleChart) already
// renders that as "—" or an empty-state line, not a zero.
// ---------------------------------------------------------------------------

export async function getStats(token: Address, launch?: Launch | null): Promise<TokenStats> {
  const indexed = await indexerGet<TokenStats>(`/stats/${token}`);
  if (indexed) return indexed;

  const { priceUsd, marketCapUsd } = await fetchSpot(token, rangeOf(launch)).catch(() => ({ priceUsd: 0, marketCapUsd: 0 }));
  return { priceUsd, marketCapUsd };
}

export async function getTrades(token: Address, n = 30): Promise<Trade[]> {
  const indexed = await indexerGet<Trade[]>(`/trades/${token}?n=${n}`);
  if (indexed) return indexed;
  return [];
}

/**
 * The launch's locked liquidity lives in the Uniswap v4 PoolManager, not the
 * locker: seeding moves the whole supply into the position, and the locker
 * keeps only rounding dust. So the PoolManager's balance is the locked-LP
 * row (it can also include any other pool for this token), the locker's
 * dust is dropped, and without an indexer that row is the one real holder
 * we can show from a single on-chain read.
 */
const LOCKED_LP_TAG = 'Pool liquidity, locked';

export async function getHolders(token: Address, launch?: Launch | null): Promise<Holder[]> {
  const pm = CONFIG.poolManager.toLowerCase();
  const locker = launch?.locker.toLowerCase();
  const indexed = await indexerGet<Holder[]>(`/holders/${token}?n=20`);
  if (indexed) {
    return indexed
      .filter((h) => h.address.toLowerCase() !== locker)
      .map((h) => (h.address.toLowerCase() === pm ? { ...h, tag: LOCKED_LP_TAG } : h));
  }
  if (!launch) return [];

  const balance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [CONFIG.poolManager] }).catch(() => 0n);
  if (balance === 0n) return [];
  const pct = Number((balance * 10_000n) / CONFIG.totalSupply) / 100;
  return [{ address: CONFIG.poolManager, balance: Number(balance) / 1e18, pct, tag: LOCKED_LP_TAG }];
}

export async function getCandles(token: Address, n = 96, intervalSec = 900): Promise<Candle[]> {
  const indexed = await indexerGet<Candle[]>(`/candles/${token}?n=${n}&interval=${intervalSec}`);
  if (indexed && indexed.length) return indexed;
  return [];
}
