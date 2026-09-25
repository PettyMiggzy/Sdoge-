import type { Address, Hex } from 'viem';
import { ARC_MAINNET } from './config.js';

// Typed client for the pad site's public JSON API. Everything here is also
// readable straight from the chain with the rest of this SDK; the API just
// saves bots the RPC calls. No key, no rate-limit tiers, CORS open.

export type ApiLaunch = {
  token: Address; creator: Address; locker: Address; splitter: Address; poolId: Hex;
  name: string; symbol: string; tokenIsToken0: boolean; buyTaxBps: number; sellTaxBps: number;
  tickLower: number; tickUpper: number; blockNumber: string; txHash: Hex; createdAt: number;
};

export type ApiMarketToken = {
  address: Address; name: string; symbol: string;
  priceUsd: number; marketCapUsd: number;
  /** Price change since the pool opened, in percent. */
  changeSinceLaunchPct: number;
  buyTaxBps: number; sellTaxBps: number; createdAt: number;
  image: string | null;
};

export type ApiConfig = {
  chainId: number; rpcUrl: string; explorerUrl: string; live: boolean;
  contracts: { portal: Address; hook: Address; treasury: Address; poolManager: Address; universalRouter: Address; permit2: Address; usdc: Address };
  poolFee: number; tickSpacing: number; totalSupply: string; quoteDecimals: number; portalGenesisBlock: string;
};

export type ApiToken = {
  launch: ApiLaunch;
  market: { sqrtPriceX96: string; tick: number; priceUsd: number; marketCapUsd: number; changeSinceLaunchPct: number; pendingTaxUsdc: string };
  meta: { description: string; image: string | null; links: { x?: string; website?: string; telegram?: string } } | null;
};

export function createPadApi(baseUrl = ARC_MAINNET.apiUrl) {
  const base = baseUrl.replace(/\/$/, '');
  async function get<T>(path: string): Promise<T> {
    const r = await fetch(base + path, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`GET ${path} failed: ${r.status} ${await r.text().catch(() => '')}`.trim());
    return (await r.json()) as T;
  }
  return {
    config: () => get<ApiConfig>('/config'),
    /** Newest first. `before` pages back by block number. */
    launches: (o: { limit?: number; before?: string } = {}) =>
      get<{ live: boolean; launches: ApiLaunch[] }>(`/launches?limit=${o.limit ?? 50}${o.before ? `&before=${o.before}` : ''}`),
    /** Live prices of the newest launches, for tickers and screeners. */
    market: (o: { limit?: number } = {}) => get<{ live: boolean; updatedAt: number; tokens: ApiMarketToken[] }>(`/market?limit=${o.limit ?? 30}`),
    token: (address: Address) => get<ApiToken>(`/tokens/${address}`),
  };
}

export type PadApi = ReturnType<typeof createPadApi>;
