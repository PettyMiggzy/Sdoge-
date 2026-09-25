// A simple sniper: buys a fixed amount of every new launch as soon as it's
// mined. SDOGE Pad has no anti-snipe window, max buy or cooldown, so the
// first block is fair game. This spends real USDC: start small.
//
//   PRIVATE_KEY=0x... BUY_USDC=1 MAX_TAX_BPS=500 SLIPPAGE_BPS=500 node examples/buy-new-launches.mjs
import { formatUnits, parseUnits } from 'viem';
import { createArcClients, createPadClient } from '../dist/index.js';

if (!process.env.PRIVATE_KEY) throw new Error('Set PRIVATE_KEY (a wallet holding a little USDC on Arc)');
const { account, publicClient, walletClient } = createArcClients(process.env.PRIVATE_KEY, process.env.ARC_RPC_URL);
const pad = createPadClient({ publicClient, walletClient });

const usdcIn = parseUnits(process.env.BUY_USDC ?? '1', 6);
const maxTaxBps = Number(process.env.MAX_TAX_BPS ?? 500);
const slippageBps = Number(process.env.SLIPPAGE_BPS ?? 500);

if (!(await pad.isLive())) console.log('The pad is not switched on yet; waiting anyway.');
console.log(`Buying $${formatUnits(usdcIn, 6)} of each new launch (buy tax <= ${maxTaxBps / 100}%) from ${account.address}`);

pad.watchLaunches(async (l) => {
  if (l.buyTaxBps > maxTaxBps) return console.log(`skip $${l.symbol}: buy tax ${l.buyTaxBps / 100}%`);
  try {
    const r = await pad.buy({ token: l.token, usdcIn, slippageBps });
    console.log(`bought $${l.symbol}: quoted ${formatUnits(r.quotedOut, 18)}, min ${formatUnits(r.amountOutMin, 18)}  tx ${r.hash}`);
  } catch (e) {
    console.error(`buy $${l.symbol} failed: ${e.shortMessage ?? e.message}`);
  }
}, { onError: (e) => console.error('RPC error, retrying:', e.shortMessage ?? e.message) });
