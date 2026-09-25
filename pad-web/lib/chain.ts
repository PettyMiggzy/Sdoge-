import { defineChain } from 'viem';
import { CONFIG } from './config';

export const arc = defineChain({
  id: CONFIG.chainId,
  name: CONFIG.chainName,
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.rpcUrl] } },
  blockExplorers: CONFIG.explorerUrl ? { default: { name: 'Arc Explorer', url: CONFIG.explorerUrl } } : undefined,
});
