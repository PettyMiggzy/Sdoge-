// Buy and sell $SDOGE on this site. It trades the official $SDOGE/USDC pool (the Uniswap v4
// pool $SDOGE launched into on Arc) through Uniswap's Universal Router on Arc: the same pool,
// price, fees and Treasury cut as trading on Argus, which uses the same router.
//
// Safety:
// - exact approvals only: the token to Permit2 for this trade's amount, and Permit2 to the
//   router for the same amount, expiring after a day, so nothing is left approved afterwards;
// - every trade is simulated before the wallet is asked to sign, and a failed simulation says
//   why instead of sending;
// - the router refuses to pay out less than the minimum shown (slippage), or the trade reverts.
//
// Quotes are exact, not estimates from the price: the page asks the router to do the swap with
// an impossible minimum in an eth_call, and the router reverts with V4TooLittleReceived(min,
// amount it would pay). Nothing is signed or moved, and the pool fee, the token's trade tax and
// price impact are all included. Needs arc.js and wallet.js loaded first.

const SWAP_CONFIG = Object.freeze({
  router: '0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  usdc: '0x3600000000000000000000000000000000000000',
  hook: '0x572c15cdf8902231f0d8b35432dfc817d726a044',
});
const SWAP_POOL_FEE = 10000; // the pool's 1% LP fee
const SWAP_TICK_SPACING = 200;
// keccak256 of the pool key: the pool DexScreener tracks (checked by the front-end tests).
const SWAP_POOL_ID = '0xbb2cff1ea59daa260919f3f579c32cc261eebeb69126ec2a5b3ea77018f3e8e2';
const SWAP_USDC_DECIMALS = 6; // USDC's ERC-20 interface on Arc; the pool trades that
const SWAP_GAS_RESERVE = 100000n; // Max on a buy leaves 0.10 USDC for gas (USDC is Arc's gas)
const SWAP_LOW_USDC = 1000000n; // under 1 USDC on Arc, the box points the buyer at the bridge
const SWAP_ALLOWANCE_SECONDS = 86400; // the router's Permit2 allowance expires after a day
const SWAP_DEADLINE_SECONDS = 600;
const SWAP_QUOTE_DELAY_MS = 350;

// Universal Router command and v4 actions (the same values the pad's router code uses on Arc).
const SWAP_CMD_V4_SWAP = 0x10;
const SWAP_ACT_EXACT_IN_SINGLE = 0x06;
const SWAP_ACT_SETTLE_ALL = 0x0c;
const SWAP_ACT_TAKE_ALL = 0x0f;
// Arc's Universal Router (v2.1.1) has six fields here: the fifth is a per-hop minimum price
// (0 = off). Leaving it out makes every swap revert with empty data.
const SWAP_PARAMS_TYPE =
  'tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)';

const SWAP_ROUTER_ABI = [
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
  'error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)',
  'error DeadlinePassed(uint256 deadline)',
];
const SWAP_PERMIT2_ABI = [
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
];
const SWAP_ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];

const swapCoder = ethers.AbiCoder.defaultAbiCoder();
const swapRouterIface = new ethers.Interface(SWAP_ROUTER_ABI);
const swapState = {
  side: 'buy', // 'buy' = USDC -> SDOGE, 'sell' = SDOGE -> USDC
  amountIn: 0n,
  quote: null, // what the router would pay out for amountIn, or null
  refRate: null, // out/in of a tiny trade, for the price and the price impact
  balances: { usdc: null, sdoge: null },
  busy: false,
  seq: 0, // drops quotes that come back after a newer input
  timer: null,
};

// ---------- the pool ----------
function swapTokens() {
  const token = SDOGE_CONTRACTS.token;
  const usdcIsZero = BigInt(SWAP_CONFIG.usdc) < BigInt(token);
  return { token, usdcIsZero, key: usdcIsZero ? [SWAP_CONFIG.usdc, token] : [token, SWAP_CONFIG.usdc] };
}

function swapPoolKey() {
  const { key } = swapTokens();
  return [key[0], key[1], SWAP_POOL_FEE, SWAP_TICK_SPACING, SWAP_CONFIG.hook];
}

function swapPoolId() {
  return ethers.keccak256(swapCoder.encode(['address', 'address', 'uint24', 'int24', 'address'], swapPoolKey()));
}

// { zeroForOne, tokenIn, tokenOut, decimalsIn, decimalsOut } for a side.
function swapLeg(side) {
  const { token, usdcIsZero } = swapTokens();
  const buy = side === 'buy';
  return {
    zeroForOne: buy ? usdcIsZero : !usdcIsZero,
    tokenIn: buy ? SWAP_CONFIG.usdc : token,
    tokenOut: buy ? token : SWAP_CONFIG.usdc,
    decimalsIn: buy ? SWAP_USDC_DECIMALS : 18,
    decimalsOut: buy ? 18 : SWAP_USDC_DECIMALS,
    symbolIn: buy ? 'USDC' : 'SDOGE',
    symbolOut: buy ? 'SDOGE' : 'USDC',
  };
}

function swapParams(leg, amountIn, minOut) {
  return swapCoder.encode([SWAP_PARAMS_TYPE], [[swapPoolKey(), leg.zeroForOne, amountIn, minOut, 0n, '0x']]);
}

// execute() arguments for an exact-input swap: SWAP_EXACT_IN_SINGLE, then SETTLE_ALL pays the
// input (through Permit2) and TAKE_ALL sends the output, refusing less than minOut.
function swapBuild(side, amountIn, minOut, deadline) {
  const leg = swapLeg(side);
  const actions = ethers.solidityPacked(['uint8', 'uint8', 'uint8'], [SWAP_ACT_EXACT_IN_SINGLE, SWAP_ACT_SETTLE_ALL, SWAP_ACT_TAKE_ALL]);
  const params = [
    swapParams(leg, amountIn, minOut),
    swapCoder.encode(['address', 'uint256'], [leg.tokenIn, amountIn]),
    swapCoder.encode(['address', 'uint256'], [leg.tokenOut, minOut]),
  ];
  const input = swapCoder.encode(['bytes', 'bytes[]'], [actions, params]);
  return [ethers.solidityPacked(['uint8'], [SWAP_CMD_V4_SWAP]), [input], deadline];
}

// Revert data inside an ethers error, wherever this provider put it.
function swapRevertData(err) {
  for (let e = err, i = 0; e && i < 6; e = e.error || e.info?.error || e.cause, i++) {
    const d = typeof e.data === 'string' ? e.data : e.data?.data;
    if (typeof d === 'string' && d.startsWith('0x') && d.length >= 10) return d;
  }
  return null;
}

// Exactly what the router would pay out for amountIn right now (see the top of this file).
async function swapQuote(side, amountIn) {
  const leg = swapLeg(side);
  const actions = ethers.solidityPacked(['uint8', 'uint8'], [SWAP_ACT_EXACT_IN_SINGLE, SWAP_ACT_TAKE_ALL]);
  const input = swapCoder.encode(['bytes', 'bytes[]'], [
    actions,
    [swapParams(leg, amountIn, 0n), swapCoder.encode(['address', 'uint256'], [leg.tokenOut, ethers.MaxUint256])],
  ]);
  const data = swapRouterIface.encodeFunctionData('execute', [ethers.solidityPacked(['uint8'], [SWAP_CMD_V4_SWAP]), [input], ethers.MaxUint256]);
  try {
    await arcRetry(() => arcReadProvider.call({ to: SWAP_CONFIG.router, data }));
  } catch (err) {
    const revert = swapRevertData(err);
    if (revert) {
      try {
        const parsed = swapRouterIface.parseError(revert);
        if (parsed?.name === 'V4TooLittleReceived') return parsed.args[1];
      } catch {
        // some other revert: thrown below
      }
    }
    throw err;
  }
  throw new Error('The quote call returned instead of reverting');
}

// ---------- amounts and text ----------
function swapParseAmount(raw, decimals) {
  const s = String(raw ?? '').trim().replace(/,/g, '');
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(s)) return null;
  return ethers.parseUnits(s, decimals);
}

function swapAmountText(v, decimals, maxFrac) {
  const n = Number(ethers.formatUnits(v, decimals));
  return n.toLocaleString('en-US', { maximumFractionDigits: n !== 0 && n < 1 ? Math.max(maxFrac, 6) : maxFrac });
}

function swapPriceText(rate) {
  // rate: SDOGE per USDC (both as plain numbers)
  if (!rate || !Number.isFinite(rate)) return '—';
  const usd = 1 / rate;
  return `1 SDOGE ≈ $${usd.toPrecision(3)}`;
}

function swapSlippageBps() {
  const v = Number(document.getElementById('swapSlippage').value || 100);
  return BigInt([50, 100, 300, 500].includes(v) ? v : 100);
}

const swapMinOut = (quote) => (quote * (10000n - swapSlippageBps())) / 10000n;

// ---------- the card ----------
function swapRender() {
  const leg = swapLeg(swapState.side);
  const $ = (id) => document.getElementById(id);
  $('swapTabBuy').classList.toggle('is-active', swapState.side === 'buy');
  $('swapTabSell').classList.toggle('is-active', swapState.side === 'sell');
  $('swapInToken').textContent = leg.symbolIn;
  $('swapOutToken').textContent = leg.symbolOut;
  for (const [id, sym] of [['swapInIcon', leg.symbolIn], ['swapOutIcon', leg.symbolOut]]) {
    const img = $(id);
    if (img.dataset.sym !== sym) {
      img.dataset.sym = sym;
      img.src = sym === 'USDC' ? 'assets/img/usdc.svg' : 'assets/img/sdoge-icon.jpg';
    }
  }
  const bal = swapState.side === 'buy' ? swapState.balances.usdc : swapState.balances.sdoge;
  $('swapBalance').textContent = bal === null ? 'Balance: —' : `Balance: ${swapAmountText(bal, leg.decimalsIn, 2)} ${leg.symbolIn}`;

  const q = swapState.quote;
  $('swapOut').textContent = q === null ? '0' : swapAmountText(q, leg.decimalsOut, leg.decimalsOut === 18 ? 0 : 4);
  $('swapMin').textContent = q === null ? '—' : `${swapAmountText(swapMinOut(q), leg.decimalsOut, leg.decimalsOut === 18 ? 0 : 4)} ${leg.symbolOut}`;
  let impact = null;
  if (q !== null && swapState.refRate && swapState.amountIn > 0n) {
    const rate = Number(ethers.formatUnits(q, leg.decimalsOut)) / Number(ethers.formatUnits(swapState.amountIn, leg.decimalsIn));
    impact = Math.max(0, 1 - rate / swapState.refRate);
  }
  $('swapImpact').textContent = impact === null ? '—' : `${(impact * 100).toFixed(impact < 0.01 ? 2 : 1)}%`;
  $('swapImpact').classList.toggle('is-high', impact !== null && impact > 0.05);
  const sdogePerUsdc = swapState.refRate && (swapState.side === 'buy' ? swapState.refRate : 1 / swapState.refRate);
  $('swapPrice').textContent = swapPriceText(sdogePerUsdc);

  const go = $('swapGo');
  const short = bal !== null && swapState.amountIn > bal;
  if (!userAddress) go.textContent = 'Connect wallet';
  else if (swapState.busy) go.textContent = 'Working…';
  else if (swapState.amountIn === 0n) go.textContent = 'Enter an amount';
  else if (short) go.textContent = `Not enough ${leg.symbolIn}`;
  else go.textContent = swapState.side === 'buy' ? 'Buy SDOGE' : 'Sell SDOGE';
  go.disabled = swapState.busy || (!!userAddress && (swapState.amountIn === 0n || short || q === null || q === 0n));
  $('swapIn').disabled = swapState.busy;
  for (const pct of [25, 50, 75, 100]) $(`swapPct${pct}`).disabled = swapState.busy;

  const bridge = swapBridgeHint();
  $('swapBridge').hidden = bridge === null;
  if (bridge !== null) $('swapBridgeTitle').textContent = bridge;
}

// Why this wallet should bridge USDC to Arc before buying, or null when it has enough. Arc is new,
// so most buyers arrive with their USDC on another chain; the box then links Circle's bridge.
function swapBridgeHint() {
  const usdc = swapState.balances.usdc;
  if (swapState.side !== 'buy' || !userAddress || usdc === null) return null;
  const amount = swapAmountText(usdc, SWAP_USDC_DECIMALS, 2);
  if (usdc === 0n) return 'No USDC on Arc in this wallet yet.';
  if (swapState.amountIn > usdc) return `This wallet has ${amount} USDC on Arc, not enough for that.`;
  if (usdc < SWAP_LOW_USDC) return `This wallet has only ${amount} USDC on Arc.`;
  return null;
}

function swapStatus(text) {
  document.getElementById('swapStatus').innerHTML = text;
}

async function swapLoadBalances() {
  if (!userAddress) return;
  const usdc = new ethers.Contract(SWAP_CONFIG.usdc, SWAP_ERC20_ABI, arcReadProvider);
  const sdoge = new ethers.Contract(SDOGE_CONTRACTS.token, SWAP_ERC20_ABI, arcReadProvider);
  const [u, s] = await arcRetry(() => Promise.all([usdc.balanceOf(userAddress), sdoge.balanceOf(userAddress)]));
  swapState.balances = { usdc: u, sdoge: s };
  swapRender();
}

// The reference rate: a tiny trade on the same side (0.01 USDC or 1,000 SDOGE).
async function swapLoadRefRate() {
  const side = swapState.side;
  const leg = swapLeg(side);
  const refIn = side === 'buy' ? 10n ** 4n : 1000n * 10n ** 18n;
  const out = await swapQuote(side, refIn);
  if (side !== swapState.side) return; // switched sides meanwhile
  swapState.refRate = out > 0n ? Number(ethers.formatUnits(out, leg.decimalsOut)) / Number(ethers.formatUnits(refIn, leg.decimalsIn)) : null;
}

// Quote whatever is in the box now. Returns the quote (bigint) or null.
async function swapRequote() {
  const seq = ++swapState.seq;
  const leg = swapLeg(swapState.side);
  const amount = swapParseAmount(document.getElementById('swapIn').value, leg.decimalsIn);
  swapState.amountIn = amount ?? 0n;
  if (!amount) {
    swapState.quote = null;
    swapRender();
    return null;
  }
  try {
    const [q] = await Promise.all([swapQuote(swapState.side, amount), swapState.refRate ? null : swapLoadRefRate().catch(() => null)]);
    if (seq !== swapState.seq) return null; // a newer input is on its way
    swapState.quote = q;
    if (q === 0n) swapStatus('The pool has nothing to fill that trade with right now.');
    else if (!swapState.busy) swapStatus('');
  } catch (err) {
    if (seq !== swapState.seq) return null;
    swapState.quote = null;
    swapStatus(`Couldn't get a price: ${escHtml(arcErrorText(err))}`);
  }
  swapRender();
  return swapState.quote;
}

function swapOnInput() {
  clearTimeout(swapState.timer);
  swapState.quote = null;
  swapRender();
  swapState.timer = setTimeout(swapRequote, SWAP_QUOTE_DELAY_MS);
}

function swapSetSide(side) {
  if (swapState.busy || (side !== 'buy' && side !== 'sell') || side === swapState.side) return;
  swapState.side = side;
  swapState.refRate = null;
  swapState.quote = null;
  document.getElementById('swapIn').value = '';
  swapState.amountIn = 0n;
  swapStatus('');
  swapRender();
  swapLoadRefRate()
    .then(swapRender)
    .catch(() => {});
}

function swapSetPct(pct) {
  const leg = swapLeg(swapState.side);
  const bal = swapState.side === 'buy' ? swapState.balances.usdc : swapState.balances.sdoge;
  if (bal === null) return;
  let v = (bal * BigInt(pct)) / 100n;
  if (swapState.side === 'buy' && pct === 100) v = bal > SWAP_GAS_RESERVE ? bal - SWAP_GAS_RESERVE : 0n;
  document.getElementById('swapIn').value = ethers.formatUnits(v, leg.decimalsIn).replace(/\.0$/, '');
  return swapRequote();
}

// Exact allowances for this trade: the token to Permit2, then Permit2 to the router (a day).
async function swapEnsureAllowances(leg, amountIn, step) {
  const token = new ethers.Contract(leg.tokenIn, SWAP_ERC20_ABI, signer);
  const permit2 = new ethers.Contract(SWAP_CONFIG.permit2, SWAP_PERMIT2_ABI, signer);
  const current = await arcRetry(() => token.allowance(userAddress, SWAP_CONFIG.permit2));
  if (current < amountIn) {
    step(`Approve exactly ${swapAmountText(amountIn, leg.decimalsIn, 6)} ${leg.symbolIn} in your wallet (1 of 3)…`);
    await (await token.approve(SWAP_CONFIG.permit2, amountIn, arcTx())).wait();
  }
  const [allowed, expiration] = await arcRetry(() => permit2.allowance(userAddress, leg.tokenIn, SWAP_CONFIG.router));
  const now = await arcNow();
  if (allowed < amountIn || expiration <= now + 60n) {
    step('Let the swap router use that amount, for one day (2 of 3)…');
    await (await permit2.approve(leg.tokenIn, SWAP_CONFIG.router, amountIn, now + BigInt(SWAP_ALLOWANCE_SECONDS), arcTx())).wait();
  }
}

// What the trade paid this wallet: the output token's Transfer logs to it (0n if none found).
const SWAP_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
function swapReceived(receipt, tokenOut) {
  let sum = 0n;
  for (const log of receipt?.logs || []) {
    if (!sameAddr(log.address, tokenOut) || log.topics?.[0] !== SWAP_TRANSFER_TOPIC || log.topics.length < 3) continue;
    if (sameAddr(ethers.getAddress(ethers.dataSlice(log.topics[2], 12)), userAddress)) sum += BigInt(log.data);
  }
  return sum;
}

// Why a simulated swap failed, in words.
function swapFailText(err) {
  const revert = swapRevertData(err);
  if (revert) {
    try {
      const parsed = swapRouterIface.parseError(revert);
      if (parsed?.name === 'V4TooLittleReceived') return 'The price moved past your slippage since the quote. Get a new quote, or allow more slippage.';
      if (parsed?.name === 'DeadlinePassed') return 'The trade took too long to send. Try again.';
    } catch {
      // not the router's own error
    }
  }
  return arcErrorText(err);
}

async function swapTrade() {
  if (swapState.busy) return false;
  if (!userAddress) {
    const ok = await connectWallet();
    if (ok) {
      await swapLoadBalances().catch(() => {});
      swapRender();
    }
    return false;
  }
  const leg = swapLeg(swapState.side);
  const amountIn = swapState.amountIn;
  if (amountIn === 0n) return false;
  swapState.busy = true;
  swapRender();
  const step = (t) => swapStatus(escHtml(t));
  try {
    if (!(await walletReady())) return false;
    await swapLoadBalances();
    const bal = swapState.side === 'buy' ? swapState.balances.usdc : swapState.balances.sdoge;
    if (amountIn > bal) {
      alert(`This wallet holds ${swapAmountText(bal, leg.decimalsIn, 6)} ${leg.symbolIn}, less than ${swapAmountText(amountIn, leg.decimalsIn, 6)}.`);
      return false;
    }
    step('Getting a fresh price…');
    const quote = await swapQuote(swapState.side, amountIn);
    if (quote === 0n) {
      alert('The pool has nothing to fill that trade with right now.');
      return false;
    }
    const shown = swapState.quote;
    if (shown && quote < swapMinOut(shown)) {
      const was = swapAmountText(shown, leg.decimalsOut, 4);
      const now = swapAmountText(quote, leg.decimalsOut, 4);
      if (!confirm(`The price moved since your quote: you'd now get about ${now} ${leg.symbolOut} instead of ${was}. Trade anyway?`)) {
        swapState.quote = quote;
        swapStatus('Price updated. Nothing was traded.');
        return false;
      }
    }
    swapState.quote = quote;
    const minOut = swapMinOut(quote);
    await swapEnsureAllowances(leg, amountIn, step);
    const args = swapBuild(swapState.side, amountIn, minOut, (await arcNow()) + BigInt(SWAP_DEADLINE_SECONDS));
    const router = new ethers.Contract(SWAP_CONFIG.router, SWAP_ROUTER_ABI, signer);
    step('Checking the trade…');
    try {
      await router.execute.staticCall(...args, arcTx());
    } catch (err) {
      alert(`This trade would fail, so nothing was sent: ${swapFailText(err)}`);
      return false;
    }
    step(`Confirm the ${swapState.side === 'buy' ? 'buy' : 'sale'} in your wallet (3 of 3)…`);
    const tx = await router.execute(...args, arcTx());
    step('Waiting for Arc to confirm…');
    const receipt = await tx.wait();
    const link = `${ARC_EXPLORER_URL}/tx/${receipt?.hash || tx.hash}`;
    const got = swapReceived(receipt, leg.tokenOut);
    const amountText = got > 0n ? `got ${swapAmountText(got, leg.decimalsOut, 4)}` : `got at least ${swapAmountText(minOut, leg.decimalsOut, 4)}`;
    swapStatus(`Done: you ${escHtml(amountText)} ${leg.symbolOut}. <a href="${link}" target="_blank" rel="noopener">View on the explorer</a>`);
    document.getElementById('swapIn').value = '';
    swapState.amountIn = 0n;
    swapState.quote = null;
    // The trade is done: free the box now; the new balances follow a moment later.
    swapState.busy = false;
    swapRender();
    arcSleep(1000)
      .then(swapLoadBalances)
      .catch(() => {})
      .then(swapRender);
    return true;
  } catch (err) {
    console.error(err);
    if (userRejected(err)) swapStatus('Cancelled in the wallet. Nothing was traded.');
    else {
      swapStatus('');
      alert(`The trade didn't go through: ${swapFailText(err)}`);
    }
    return false;
  } finally {
    swapState.busy = false;
    swapRender();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('swapGo')) return;
  const $ = (id) => document.getElementById(id);
  $('swapTabBuy').addEventListener('click', () => swapSetSide('buy'));
  $('swapTabSell').addEventListener('click', () => swapSetSide('sell'));
  $('swapIn').addEventListener('input', swapOnInput);
  $('swapSlippage').addEventListener('change', swapRender);
  for (const pct of [25, 50, 75, 100]) $(`swapPct${pct}`).addEventListener('click', () => swapSetPct(pct));
  $('swapGo').addEventListener('click', swapTrade);
  document.addEventListener('sdoge:wallet-connected', () => {
    swapLoadBalances()
      .catch(() => {})
      .then(swapRender);
  });
  swapRender();
  swapLoadRefRate()
    .then(swapRender)
    .catch(() => {});
});
