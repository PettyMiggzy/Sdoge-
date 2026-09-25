// Browser E2E of the create flow against an anvil fork of Arc mainnet.
// Runs the site's production bundle unmodified (SITE, e.g. a local
// `next start` or the live site). Its RPC traffic (Alchemy /
// rpc.mainnet.arc.io) is rerouted to the fork,
// and a stand-in injected "MetaMask" answers for an impersonated fork
// account, so nothing touches the real chain. The stand-in refuses to sign,
// so a successful run ends at "The token launched, but saving its details
// failed: Declined in the wallet, so nothing was sent."
//
//   anvil --fork-url <arc mainnet rpc> --port 8547 --chain-id 5042
//   PORTAL=<SdogePadPortal> SITE=http://localhost:3000 \
//     node pad-web/scripts/e2e-create-fork.cjs                     # funded wallet: launches
//   PORTAL=<SdogePadPortal> BALANCE_WEI=10000000000000000 ACCOUNT=0x5555555555555555555555555555555555555555 \
//     node pad-web/scripts/e2e-create-fork.cjs                     # 0.01 USDC: "Short on gas"
//
// Needs Playwright with a Chromium (PLAYWRIGHT_PATH / CHROMIUM_PATH if they
// aren't on the default paths). Behind a TLS-intercepting proxy, pass its
// SPKI via CHROMIUM_ARGS=--ignore-certificate-errors-spki-list=<spki>.
// The portal must exist on the fork (deploy it there first if it isn't live yet).
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const S = process.env.OUT_DIR || '.';
const FORK = process.env.ARC_FORK_RPC || 'http://127.0.0.1:8547';
const SITE = process.env.SITE || 'http://localhost:3000';
const PORTAL = process.env.PORTAL;
if (!/^0x[0-9a-fA-F]{40}$/.test(PORTAL || '')) throw new Error('set PORTAL to the SdogePadPortal address');
const ACCOUNT = process.env.ACCOUNT || '0x4444444444444444444444444444444444444444';
const BALANCE = BigInt(process.env.BALANCE_WEI || 5n * 10n ** 18n); // native USDC, 18 decimals
const SYMBOL = process.env.SYMBOL || 'FKTST';

async function rpc(method, params = []) {
  const r = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
async function toFork(route) {
  const req = route.request();
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  const r = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: req.postData() });
  return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: await r.text() });
}

const walletScript = (account) => `(() => {
  const listeners = {};
  let n = 0;
  async function forward(method, params) {
    const r = await fetch('https://mock-wallet.invalid/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
    const j = await r.json();
    if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; }
    return j.result;
  }
  const provider = {
    isMetaMask: true,
    async request({ method, params }) {
      (window.__walletCalls = window.__walletCalls || []).push(method);
      switch (method) {
        case 'eth_requestAccounts': case 'eth_accounts': return ['${account}'];
        case 'eth_chainId': return '0x13b2';
        case 'net_version': return '5042';
        case 'wallet_switchEthereumChain': case 'wallet_addEthereumChain': case 'wallet_watchAsset': case 'wallet_revokePermissions': return null;
        case 'wallet_requestPermissions': case 'wallet_getPermissions': return [{ parentCapability: 'eth_accounts' }];
        case 'personal_sign': case 'eth_signTypedData_v4': { const e = new Error('User rejected the request.'); e.code = 4001; throw e; }
        case 'eth_sendTransaction': window.__lastTx = params[0]; return forward(method, params);
        default: return forward(method, params);
      }
    },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return provider; },
    removeListener(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); return provider; },
  };
  provider.off = provider.removeListener;
  window.ethereum = provider;
  const info = { uuid: '0b8f0d2e-6d5a-4f7e-9d0e-7a1c2b3d4e5f', name: 'MetaMask', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=', rdns: 'io.metamask' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
})();`;

(async () => {
  await rpc('anvil_setBalance', [ACCOUNT, '0x' + BALANCE.toString(16)]);
  await rpc('anvil_impersonateAccount', [ACCOUNT]);
  const countBefore = BigInt(await rpc('eth_call', [{ to: PORTAL, data: '0x27cca59f' }, 'latest']).catch(() => '0x0'));

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: process.env.CHROMIUM_ARGS ? process.env.CHROMIUM_ARGS.split(' ') : [],
  });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
  await ctx.route(/arc-mainnet\.g\.alchemy\.com|rpc\.mainnet\.arc\.io|mock-wallet\.invalid/, toFork);
  await ctx.addInitScript(walletScript(ACCOUNT));
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await p.goto(`${SITE}/create`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('served deployment:', (await p.content()).match(/dpl_[A-Za-z0-9]+/)?.[0]);

  await p.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  const connectBtn = p.getByRole('button', { name: 'Connect Wallet' }).first();
  const connected = p.getByRole('button', { name: new RegExp(ACCOUNT.slice(0, 6), 'i') }).first();
  const state = await Promise.race([
    connectBtn.waitFor({ timeout: 60000 }).then(() => 'connect'),
    connected.waitFor({ timeout: 60000 }).then(() => 'already-connected'),
  ]).catch(async (e) => { await p.screenshot({ path: `${S}/e2e-create-noconnect.png` }); throw e; });
  console.log('wallet state on load:', state);
  if (state === 'connect') {
    await connectBtn.click();
    const dialog = p.getByRole('dialog');
    await dialog.waitFor({ timeout: 20000 });
    await dialog.getByText('MetaMask', { exact: true }).first().click();
    await dialog.waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});
  }
  await p.waitForTimeout(1500);

  await p.getByPlaceholder('Much Wow Coin', { exact: true }).fill('Fork Browser Test');
  await p.getByPlaceholder('WOW', { exact: true }).fill(SYMBOL);
  const create = p.getByRole('button', { name: /Launch token/ });
  await create.click();

  // Wait for either the post-launch "Sign and save" state or an error message.
  const outcome = await Promise.race([
    p.getByRole('button', { name: /Skip for now/ }).waitFor({ timeout: 90000 }).then(() => 'launched'),
    p.getByText(/Short on gas|short on USDC for gas|Declined in the wallet|Contract said no|Reverted with reason|failed on-chain/i).first().waitFor({ timeout: 90000 }).then(() => 'error'),
  ]).catch((e) => 'timeout: ' + e.message);
  await p.waitForTimeout(1000);
  const body = (await p.innerText('main').catch(() => p.innerText('body'))).replace(/\n+/g, ' | ');
  const msg = body.match(/(The token launched[^|]*|Short on gas[^|]*|This wallet is short on USDC[^|]*|Declined in the wallet[^|]*|Reverted with reason[^|]*|Contract said no[^|]*|[^|]*failed on-chain[^|]*)/)?.[0];
  const lastTx = await p.evaluate(() => window.__lastTx || null);
  const calls = await p.evaluate(() => (window.__walletCalls || []).filter((m) => m.startsWith('eth_send') || m === 'personal_sign'));
  const countAfter = BigInt(await rpc('eth_call', [{ to: PORTAL, data: '0x27cca59f' }, 'latest']).catch(() => '0x0'));
  console.log('outcome:', outcome);
  console.log('message on page:', msg ?? '(none)');
  console.log('wallet send/sign calls:', calls.join(', ') || 'none');
  console.log('tx sent with explicit gas:', lastTx ? `${lastTx.gas ? BigInt(lastTx.gas) : 'NO gas field'}` : 'no tx');
  console.log(`portal launchCount on fork: ${countBefore} -> ${countAfter}`);
  console.log('page errors:', errs.length ? errs : 'none');
  await p.screenshot({ path: `${S}/e2e-create-${outcome.split(':')[0]}.png`, fullPage: false });
  await browser.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
