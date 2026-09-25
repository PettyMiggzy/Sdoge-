import { defineChain, type Address } from 'viem';

/** Everything the SDK needs to know about one SDOGE Pad deployment. */
export type PadConfig = {
  chainId: number;
  rpcUrl: string;
  /** The pad site's public HTTP API (see api.ts). */
  apiUrl: string;
  portal: Address;
  hook: Address;
  treasury: Address;
  poolManager: Address;
  universalRouter: Address;
  permit2: Address;
  /** The quote asset every launch pairs with: Arc's USDC (ERC-20 interface). */
  usdc: Address;
  quoteDecimals: number;
  tokenDecimals: number;
  /** 1% LP fee on every pool. */
  poolFee: number;
  tickSpacing: number;
  /** Every launch mints exactly this many tokens (1B, 18 decimals). */
  totalSupply: bigint;
  /** Block the portal was deployed at: no launch exists before it. */
  portalGenesisBlock: bigint;
  explorerUrl: string;
};

/** SDOGE Pad on Arc mainnet (pad/deployments/arc-mainnet.json in this repo). */
export const ARC_MAINNET: PadConfig = {
  chainId: 5042,
  rpcUrl: 'https://rpc.mainnet.arc.io',
  apiUrl: 'https://sdoge-launchpad.vercel.app/api/v1',
  portal: '0x7F80b1198e6DAa56b0019Cb45020382358E385Fd',
  hook: '0x10dE365Cc583bA953a9e6C36658A138082d9e8cc',
  treasury: '0x5B2A7f99b3Bd79211b2154dC997f2F8c3CAaF3Aa',
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  universalRouter: '0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  usdc: '0x3600000000000000000000000000000000000000',
  quoteDecimals: 6,
  tokenDecimals: 18,
  poolFee: 10_000,
  tickSpacing: 200,
  totalSupply: 1_000_000_000n * 10n ** 18n,
  portalGenesisBlock: 22_720_736n,
  explorerUrl: 'https://explorer.arc.io',
};

/** Arc mainnet for viem. USDC is the gas token (18 decimals natively). */
export const arc = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } },
});

/**
 * USDC pays for gas on Arc, so a buy should never spend the whole balance.
 * This much (in 6-decimal USDC units) is left untouched by default: enough
 * for the approvals and the swap itself.
 */
export const DEFAULT_GAS_RESERVE_USDC = 100_000n; // $0.10
