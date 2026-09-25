import type { Address } from 'viem';

// Next.js only inlines NEXT_PUBLIC_* vars into the client bundle when they're
// referenced as a literal `process.env.NEXT_PUBLIC_X` (static dot access) —
// its compiler pattern-matches that exact syntax at build time. A helper
// that does `process.env[name]` with a dynamic `name` can NEVER be inlined:
// the browser has no real process.env, so that lookup silently returns
// undefined for every visitor, no matter what's set in Vercel. This is why
// each addr() call below passes the already-resolved `process.env.NEXT_PUBLIC_X`
// value in, rather than the var's name — the CONFIG object is what needs the
// static references, not this function.
function addr(value: string | undefined, label: string, fallback?: string): Address {
  const v = value ?? fallback;
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${label} is unset or isn't a 0x address`);
  return v as Address;
}

export const CONFIG = {
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? 'https://rpc.mainnet.arc.io',
  // An env var rather than a constant; the default, 5042, is Arc mainnet,
  // where SDOGE Pad is deployed.
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 5042),
  chainName: process.env.NEXT_PUBLIC_CHAIN_NAME ?? 'Arc',
  explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL ?? '',
  brand: process.env.NEXT_PUBLIC_BRAND ?? 'SDOGE Launchpad',
  tagline: process.env.NEXT_PUBLIC_TAGLINE ?? 'Ideas today. A more stable tomorrow.',
  // Optional: the site's public URL, for absolute social-preview links.
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? '',
  // Optional: the main Stable Doge site, linked as "Home" in the nav.
  homeUrl: process.env.NEXT_PUBLIC_HOME_URL ?? '',
  // Optional: the pad admin wallet, shown on the /admin page.
  padAdmin: process.env.NEXT_PUBLIC_PAD_ADMIN ?? '',
  // $SDOGE itself, pinned first in Featured Launches with live DexScreener data.
  sdogeToken: process.env.NEXT_PUBLIC_SDOGE_TOKEN ?? '0xf8df98fda14cabb2e8b6efe920081ffcbb0bb405',
  milestoneUsd: Number(process.env.NEXT_PUBLIC_MILESTONE_USD ?? 30000),
  portal: addr(process.env.NEXT_PUBLIC_PORTAL, 'NEXT_PUBLIC_PORTAL'),
  hook: addr(process.env.NEXT_PUBLIC_HOOK, 'NEXT_PUBLIC_HOOK'),
  // Uniswap v4's PoolManager and UniversalRouter on Arc mainnet.
  poolManager: addr(process.env.NEXT_PUBLIC_POOL_MANAGER, 'NEXT_PUBLIC_POOL_MANAGER', '0x8366a39CC670B4001A1121B8F6A443A643e40951'),
  router: addr(process.env.NEXT_PUBLIC_ROUTER, 'NEXT_PUBLIC_ROUTER', '0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1'),
  permit2: addr(process.env.NEXT_PUBLIC_PERMIT2, 'NEXT_PUBLIC_PERMIT2', '0x000000000022D473030F116dDEE9F6B43aC78BA3'),
  usdc: addr(process.env.NEXT_PUBLIC_USDC, 'NEXT_PUBLIC_USDC', '0x3600000000000000000000000000000000000000'),
  // FALSE, not true (see the comment in .env.example):
  // SdogePadHook/SdogePadPortal explicitly revert on quoteAsset == address(0)
  // (NativeQuoteUnsupported / ZeroAddress). There is no native-currency
  // code path in these contracts at all — confirmed directly against
  // SdogePadLocker's unconditional IERC20.safeTransfer usage on both pool
  // currencies. The quote leg is always a real ERC-20 transfer, never
  // msg.value, regardless of what Arc's native/USDC balance relationship
  // looks like at the chain level.
  quoteIsNative: (process.env.NEXT_PUBLIC_QUOTE_IS_NATIVE ?? 'false') === 'true',
  quoteDecimals: Number(process.env.NEXT_PUBLIC_QUOTE_DECIMALS ?? 6),
  // Optional. When set, lib/data.ts reads stats/trades/holders/candles from
  // pad-indexer's HTTP API instead of returning honest empty/unknown values for
  // the fields that need real trade history — no other code changes needed.
  indexerUrl: process.env.NEXT_PUBLIC_INDEXER_URL ?? '',
  // The block CONFIG.portal was deployed at. No LaunchCreated log can exist
  // before this, so it's a safe, permanent floor for the launch scan in
  // lib/launches.ts — it avoids an unbounded fromBlock:0 eth_getLogs call,
  // which public RPC providers (Alchemy included) reject past a ~10k block
  // range on any chain with real age.
  portalGenesisBlock: BigInt(process.env.NEXT_PUBLIC_PORTAL_GENESIS_BLOCK || 0),
  poolFee: 10_000,
  tickSpacing: 200,
  totalSupply: 1_000_000_000n * 10n ** 18n,
  maxTaxBps: 1000,
} as const;

export const explorerTx = (h: string) => (CONFIG.explorerUrl ? `${CONFIG.explorerUrl}/tx/${h}` : '');
export const explorerAddr = (a: string) => (CONFIG.explorerUrl ? `${CONFIG.explorerUrl}/address/${a}` : '');
