// The HTTP API, no RPC needed: live prices of the newest launches.
//   node examples/market-api.mjs
import { createPadApi } from '../dist/index.js';

const api = createPadApi(process.env.PAD_API_URL);
const { live, tokens } = await api.market({ limit: 20 });
console.log(live ? 'SDOGE Pad is live' : 'SDOGE Pad is not switched on yet');
for (const t of tokens) {
  console.log(`$${t.symbol.padEnd(8)} $${t.priceUsd.toPrecision(3).padEnd(10)} MC $${Math.round(t.marketCapUsd).toLocaleString('en-US').padEnd(10)} ${t.changeSinceLaunchPct >= 0 ? '+' : ''}${t.changeSinceLaunchPct.toFixed(1)}% since launch  ${t.address}`);
}
