// Prints every new SDOGE Pad launch the moment it's mined. Read-only.
//   npm run build && node examples/watch-launches.mjs
// (installed from npm, import from 'sdoge-pad-sdk' instead of '../dist/index.js')
import { createPublicClient, http } from 'viem';
import { arc, createPadClient } from '../dist/index.js';

const publicClient = createPublicClient({ chain: arc, transport: http(process.env.ARC_RPC_URL ?? 'https://rpc.mainnet.arc.io') });
const pad = createPadClient({ publicClient });

console.log(`Watching SDOGE Pad (portal ${pad.config.portal}) for new launches…`);
pad.watchLaunches(async (l) => {
  const t = await pad.getToken(l.token).catch(() => null);
  const market = t ? `  price $${t.priceUsd.toPrecision(3)}  MC $${Math.round(t.marketCapUsd).toLocaleString('en-US')}` : '';
  console.log(`${new Date().toISOString()}  $${l.symbol} (${l.name})  ${l.token}  tax ${l.buyTaxBps / 100}% buy / ${l.sellTaxBps / 100}% sell${market}`);
}, { onError: (e) => console.error('RPC error, retrying:', e.shortMessage ?? e.message) });
