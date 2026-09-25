import { getAddress, isAddress } from 'ethers';
import { bpsToPct, esc, fmtTokens, fmtUsdc6, fmtUsdcWei, short, tokenLine, txLink } from '../format.js';
import { usdPerToken } from '../market.js';
import { amountHint, parseAmount, parsePercentBps } from '../util.js';

const uidOf = (m) => String(m.from.id);
const GAS_BUFFER_WEI = 10n ** 16n; // 0.01 USDC: plenty for a few Arc txs at ~0.003 each
const MIN_BUY6 = 100_000n; // 0.1 USDC
const TRADING_SOON = '🚧 Trading opens as soon as the launchpad router is live on Arc. Stay tuned!';
// From this price impact on, a trade is big enough to be worth sandwiching.
const IMPACT_WARN = 0.02;

const slippageOf = (bot, uid) => bot.store.user(uid).slippageBps ?? bot.cfg.limits.defaultSlippageBps;
const withSlippage = (amount, bps) => (amount * BigInt(10000 - bps)) / 10000n;
const deadline = (bot) => Math.floor(bot.now() / 1000) + 300;
// At confirm the quote is fresh, so the on-chain limit only has to cover the
// second or so until the transaction lands.
const execSlippageOf = (bot, bps) => Math.min(bps, bot.cfg.limits.execSlippageBps ?? 100);

function trackToken(bot, uid, token) {
  const user = bot.store.user(uid);
  user.tokens = [...new Set([...(user.tokens ?? []), token.toLowerCase()])].slice(-50);
  bot.store.touch();
}

async function hasGas(bot, address) {
  return (await bot.chain.nativeBalance(address)) >= GAS_BUFFER_WEI;
}

function buyable(bot, key) {
  const l = bot.store.launchByKey(String(key ?? '').toLowerCase());
  return l && !l.hidden && l.status === 'approved' ? l : null;
}

// How much a trade moves the price, from the pool's spot price (after the 2%
// fee on both sides). Null when it can't be told.
async function priceImpact(bot, l, { isBuy, amountIn, amountOut }) {
  const sqrt = await bot.chain.poolSqrtPrice(l.poolId).catch(() => null);
  const px = sqrt ? usdPerToken(sqrt) : 0;
  if (!(px > 0)) return null;
  const spot = isBuy ? (Number(amountIn) / 1e6) * 0.98 / px : (Number(amountIn) / 1e18) * px * 0.98;
  const got = isBuy ? Number(amountOut) / 1e18 : Number(amountOut) / 1e6;
  const impact = 1 - got / spot;
  return Number.isFinite(impact) ? impact : null;
}

const impactLines = (impact) => (impact !== null && impact >= IMPACT_WARN
  ? ['', `⚠️ This trade moves the price about ${(impact * 100).toFixed(1)}%. Trades this big can be front-run: consider splitting it.`]
  : []);

// An earlier transaction of the same kind whose outcome isn't known yet.
export function unconfirmedLines(bot, uid, kind, what) {
  const open = Object.values(bot.store.data.txs ?? {}).filter((t) => t.uid === String(uid) && t.kind === kind && t.label !== 'approve');
  if (!open.length) return [];
  return ['', `⚠️ Your previous ${what} (${txLink(bot.cfg.explorerUrl, open.at(-1).hash)}) isn't confirmed yet. If it goes through, this one comes on top of it.`];
}

// ---------- buy ----------

export async function buy(bot, m, user, args) {
  const uid = uidOf(m);
  if (!bot.chain.canTrade) return bot.reply(uid, TRADING_SOON);
  if (!args[0]) return bot.reply(uid, 'Usage: /buy $TICKER 10 (spends 10 USDC)');
  const r = bot.resolveToken(args[0], { uid });
  if (r.error) return bot.reply(uid, r.error);
  if (r.launch.status !== 'approved') return bot.reply(uid, 'That token is still waiting for moderator review.');
  if (!args[1]) return promptBuyAmount(bot, uid, r.launch.key);
  return prepareBuy(bot, uid, r.launch, args[1]);
}

export async function promptBuyAmount(bot, uid, key) {
  const l = buyable(bot, key);
  if (!l) return bot.reply(uid, 'That token isn\'t available to buy.');
  if (!bot.chain.canTrade) return bot.reply(uid, TRADING_SOON);
  bot.setConvo(uid, { flow: 'buyAmount', key: l.key });
  return bot.reply(uid, `How much USDC do you want to spend on ${tokenLine(l)}? Tap one or type an amount.`, {
    buttons: [['5', '10', '25', '50', '100'].map((v) => ({ text: `${v} USDC`, callback_data: `ba:${l.key}:${v}` }))],
  });
}

export async function onBuyAmount(bot, m, user, convo) {
  const uid = uidOf(m);
  bot.clearConvo(uid);
  return prepareBuyByKey(bot, uid, convo.key, (m.text ?? '').trim());
}

export async function prepareBuyByKey(bot, uid, key, amountText) {
  const l = buyable(bot, key);
  if (!l) return bot.reply(uid, 'That token isn\'t available to buy.');
  return prepareBuy(bot, uid, l, amountText);
}

async function prepareBuy(bot, uid, l, amountText) {
  const usdc6 = parseAmount(amountText, 6);
  if (usdc6 === null) return bot.reply(uid, amountHint(amountText) ?? 'Send an amount like 10 or 2.5.');
  if (usdc6 < MIN_BUY6) return bot.reply(uid, 'The minimum buy is 0.1 USDC.');
  const wallet = bot.wallets.get(uid);
  const balance = await bot.chain.nativeBalance(wallet.address);
  if (balance < usdc6 * 10n ** 12n + GAS_BUFFER_WEI) {
    return bot.reply(uid, `💸 You have ${fmtUsdcWei(balance)} USDC. This buy needs ${fmtUsdc6(usdc6)} plus a little gas. /deposit`);
  }
  let out;
  try {
    out = await bot.chain.quoteBuy(l.token, usdc6);
  } catch (err) {
    bot.log.error('quoteBuy failed:', err);
    return bot.reply(uid, 'Couldn\'t get a price right now. Try again shortly.');
  }
  const slip = slippageOf(bot, uid);
  const minOut = withSlippage(out, slip);
  const impact = await priceImpact(bot, l, { isBuy: true, amountIn: usdc6, amountOut: out });
  const id = bot.createPending(uid, 'buy', { key: l.key, usdc6, minOut, slippageBps: slip });
  return bot.reply(uid, [
    `🟢 <b>Buy $${esc(l.symbol)}</b>`,
    tokenLine(l),
    '',
    `Spend: <b>${fmtUsdc6(usdc6)} USDC</b> (2% fee included)`,
    `Get: ~<b>${fmtTokens(out)}</b> $${esc(l.symbol)}`,
    `At least ${fmtTokens(minOut)} after ${bpsToPct(slip)} max slippage`,
    ...impactLines(impact),
    ...unconfirmedLines(bot, uid, 'buy', 'buy'),
  ].join('\n'), { buttons: bot.confirmButtons(id, '✅ Buy') });
}

// Quotes again right before sending: the on-chain minimum is the previewed
// one or the fresh quote minus a small margin, whichever is higher, so a
// price move in the user's favour isn't left for someone else to take.
async function freshMinOut(bot, p, quote) {
  let fresh;
  try {
    fresh = await quote();
  } catch (err) {
    bot.log.error('re-quote failed:', err);
    return { text: '❌ Couldn\'t re-check the price, so nothing was sent. Try again in a moment.' };
  }
  const slip = p.slippageBps ?? bot.cfg.limits.defaultSlippageBps;
  if (fresh < p.minOut) return { text: `⚠️ The price moved more than your ${bpsToPct(slip)} limit since the preview, so nothing was sent. Try again for a fresh quote.` };
  const tight = withSlippage(fresh, execSlippageOf(bot, slip));
  return { minOut: tight > p.minOut ? tight : p.minOut };
}

export async function executeBuy(bot, uid, p, track) {
  const l = buyable(bot, p.key);
  if (!l) return { text: 'That token isn\'t available to buy anymore. Nothing was sent.' };
  const q = await freshMinOut(bot, p, () => bot.chain.quoteBuy(l.token, p.usdc6));
  if (q.text) return { text: q.text };
  const res = await bot.chain.buy(bot.wallets.get(uid), l.token, p.usdc6, q.minOut, deadline(bot), track);
  trackToken(bot, uid, l.token);
  return {
    text: `✅ Bought <b>${fmtTokens(res.received)} $${esc(l.symbol)}</b> (${esc(l.name)}) for ${fmtUsdc6(p.usdc6)} USDC · ${txLink(bot.cfg.explorerUrl, res.txHash)}`,
    buttons: [[{ text: '🔴 Sell', callback_data: `s:${l.key}` }, { text: '🏦 Vault', callback_data: `v:${l.key}` }]],
  };
}

// ---------- sell ----------

export async function sell(bot, m, user, args) {
  const uid = uidOf(m);
  if (!bot.chain.canTrade) return bot.reply(uid, TRADING_SOON);
  if (!args[0]) return bot.reply(uid, 'Usage: /sell $TICKER 50% (or an amount, or all)');
  const r = bot.resolveToken(args[0], { includeHidden: true, uid });
  if (r.error) return bot.reply(uid, r.error);
  if (!args[1]) return promptSellAmount(bot, uid, r.launch.key);
  return prepareSell(bot, uid, r.launch, args[1]);
}

export async function promptSellAmount(bot, uid, key) {
  const l = bot.store.launchByKey(String(key ?? '').toLowerCase());
  if (!l) return bot.reply(uid, 'Token not found.');
  if (!bot.chain.canTrade) return bot.reply(uid, TRADING_SOON);
  return bot.reply(uid, `How much of ${tokenLine(l)} do you want to sell?`, {
    buttons: [['25', '50', '100'].map((v) => ({ text: `${v}%`, callback_data: `sa:${l.key}:${v}` }))],
  });
}

export async function prepareSellByKey(bot, uid, key, amountText) {
  const l = bot.store.launchByKey(String(key ?? '').toLowerCase());
  if (!l) return bot.reply(uid, 'Token not found.');
  return prepareSell(bot, uid, l, amountText);
}

async function resolveTokenAmount(bot, uid, l, amountText) {
  const wallet = bot.wallets.get(uid);
  const balance = await bot.chain.tokenBalance(l.token, wallet.address);
  if (balance === 0n) return { error: `You don't hold any ${tokenLine(l)}.` };
  const bps = parsePercentBps(amountText);
  const amount = bps !== null ? (balance * BigInt(bps)) / 10000n : parseAmount(amountText, 18);
  if (!amount) return { error: amountHint(amountText) ?? 'Send an amount, a percentage like 50%, or "all".' };
  if (amount > balance) return { error: `You only have ${fmtTokens(balance)} $${esc(l.symbol)}.` };
  if (!(await hasGas(bot, wallet.address))) return { error: 'You need a little USDC for gas first. /deposit' };
  return { amount };
}

async function prepareSell(bot, uid, l, amountText) {
  const r = await resolveTokenAmount(bot, uid, l, amountText);
  if (r.error) return bot.reply(uid, r.error);
  let out;
  try {
    out = await bot.chain.quoteSell(l.token, r.amount);
  } catch (err) {
    bot.log.error('quoteSell failed:', err);
    return bot.reply(uid, 'Couldn\'t get a price right now. Try again shortly.');
  }
  const slip = slippageOf(bot, uid);
  const minOut = withSlippage(out, slip);
  const impact = await priceImpact(bot, l, { isBuy: false, amountIn: r.amount, amountOut: out });
  const id = bot.createPending(uid, 'sell', { key: l.key, amount: r.amount, minOut, slippageBps: slip });
  return bot.reply(uid, [
    `🔴 <b>Sell $${esc(l.symbol)}</b>`,
    tokenLine(l),
    '',
    `Sell: <b>${fmtTokens(r.amount)}</b> $${esc(l.symbol)}`,
    `Get: ~<b>${fmtUsdc6(out)} USDC</b> (2% fee included)`,
    `At least ${fmtUsdc6(minOut)} USDC after ${bpsToPct(slip)} max slippage`,
    ...impactLines(impact),
    ...unconfirmedLines(bot, uid, 'sell', 'sell'),
  ].join('\n'), { buttons: bot.confirmButtons(id, '✅ Sell') });
}

export async function executeSell(bot, uid, p, track) {
  const l = bot.store.launchByKey(p.key);
  if (!l) return { text: 'Token not found. Nothing was sent.' };
  const q = await freshMinOut(bot, p, () => bot.chain.quoteSell(l.token, p.amount));
  if (q.text) return { text: q.text };
  const res = await bot.chain.sell(bot.wallets.get(uid), l.token, p.amount, q.minOut, deadline(bot), track);
  return { text: `✅ Sold ${fmtTokens(p.amount)} $${esc(l.symbol)} (${esc(l.name)}) for <b>${fmtUsdc6(res.received6)} USDC</b> · ${txLink(bot.cfg.explorerUrl, res.txHash)}` };
}

// ---------- creator fees ----------

export async function claim(bot, m) {
  const uid = uidOf(m);
  if (!bot.chain.canClaim) return bot.reply(uid, '🚧 Creator fees become claimable once the launchpad contracts are live.');
  const wallet = bot.wallets.get(uid);
  const owed = await bot.chain.owed(wallet.address);
  if (owed === 0n) return bot.reply(uid, 'No creator fees to claim yet. You earn 0.5% of every buy of the tokens you launch.');
  if (!(await hasGas(bot, wallet.address))) return bot.reply(uid, 'You need a little USDC for gas to claim. /deposit');
  const id = bot.createPending(uid, 'claim', { owed });
  return bot.reply(uid, `💰 Claim <b>${fmtUsdc6(owed)} USDC</b> of creator fees to your wallet?`, { buttons: bot.confirmButtons(id, '✅ Claim') });
}

export async function executeClaim(bot, uid, p, track) {
  const res = await bot.chain.claim(bot.wallets.get(uid), track);
  return { text: `✅ Claimed <b>${fmtUsdc6(res.received6)} USDC</b> · ${txLink(bot.cfg.explorerUrl, res.txHash)}` };
}

// ---------- meme vault ----------

export async function redeem(bot, m, user, args) {
  const uid = uidOf(m);
  if (!args[0] || !args[1]) return bot.reply(uid, 'Usage: /redeem $TICKER 25% (or an amount, or all)');
  const r = bot.resolveToken(args[0], { includeHidden: true, uid });
  if (r.error) return bot.reply(uid, r.error);
  const l = r.launch;
  const amt = await resolveTokenAmount(bot, uid, l, args[1]);
  if (amt.error) return bot.reply(uid, amt.error);

  const payout6 = await bot.chain.quoteRedeem(l.vault, amt.amount);
  if (payout6 === 0n) return bot.reply(uid, 'The vault is empty for now, so redeeming would pay nothing.');

  const lines = [
    `🏦 <b>Redeem $${esc(l.symbol)}</b>`,
    tokenLine(l),
    '',
    `Burn: <b>${fmtTokens(amt.amount)}</b> $${esc(l.symbol)} (permanently)`,
    `Get: at least <b>${fmtUsdc6(payout6)} USDC</b> from the vault`,
  ];
  if (bot.chain.canTrade) {
    const sellQuote = await bot.chain.quoteSell(l.token, amt.amount).catch(() => null);
    if (sellQuote !== null && sellQuote > payout6) {
      lines.push('', `⚠️ Selling would get ~${fmtUsdc6(sellQuote)} USDC, more than redeeming. /sell may be better.`);
    }
  }
  lines.push(...unconfirmedLines(bot, uid, 'redeem', 'redeem'));
  const id = bot.createPending(uid, 'redeem', { key: l.key, amount: amt.amount, minOut: payout6 });
  return bot.reply(uid, lines.join('\n'), { buttons: bot.confirmButtons(id, '🔥 Burn & redeem') });
}

export async function executeRedeem(bot, uid, p, track) {
  const l = bot.store.launchByKey(p.key);
  if (!l) return { text: 'Token not found. Nothing was sent.' };
  const res = await bot.chain.redeem(bot.wallets.get(uid), l, p.amount, p.minOut, track);
  return { text: `✅ Burned ${fmtTokens(p.amount)} $${esc(l.symbol)} (${esc(l.name)}) for <b>${fmtUsdc6(res.received6)} USDC</b> · ${txLink(bot.cfg.explorerUrl, res.txHash)}` };
}

// ---------- wallet out ----------

// Arc: value sent to 0x0 reverts; value sent to standard precompiles
// (0x01-0x0a, 0x100) is accepted and lost forever; Arc's system contracts
// (0x1800..., 0x3600..., 0xff..fe) reject it.
function unsafeDestination(address) {
  const n = BigInt(address);
  const a = address.toLowerCase();
  return n < 0x10000n
    || a.startsWith('0x18000000000000000000000000000000000000')
    || a.startsWith('0x36000000000000000000000000000000000000')
    || a === '0xfffffffffffffffffffffffffffffffffffffffe';
}

export async function withdraw(bot, m, user, args) {
  const uid = uidOf(m);
  const [amountText, to] = args;
  if (!amountText || !to) return bot.reply(uid, 'Usage: /withdraw 10 0xYourAddress (or /withdraw all 0xYourAddress)');
  if (!isAddress(to)) return bot.reply(uid, 'That isn\'t a valid address. Paste a full 0x… Arc address.');
  const dest = getAddress(to);
  const wallet = bot.wallets.get(uid);
  if (unsafeDestination(dest)) return bot.reply(uid, 'That\'s a system or precompile address, and USDC sent there is lost. Double-check the address.');
  if (dest === wallet.address) return bot.reply(uid, 'That\'s your bot wallet itself.');

  let value;
  if (amountText.toLowerCase() === 'all') {
    value = await bot.chain.maxWithdrawable(wallet, dest);
  } else {
    value = parseAmount(amountText, 18);
    if (value === null) return bot.reply(uid, amountHint(amountText) ?? 'Send an amount like 10 or 2.5, or "all".');
    const balance = await bot.chain.nativeBalance(wallet.address);
    if (balance < value + GAS_BUFFER_WEI) return bot.reply(uid, `You have ${fmtUsdcWei(balance)} USDC. Leave a little for gas, or use "all".`);
  }
  if (!value || value <= 0n) return bot.reply(uid, 'Nothing to withdraw after gas.');

  const isContract = await bot.chain.isContract(dest).catch(() => false);
  const id = bot.createPending(uid, 'withdraw', { to: dest, value });
  return bot.reply(uid, [
    '📤 <b>Withdraw</b>',
    '',
    `Send <b>${fmtUsdcWei(value, 6)} USDC</b> on Arc to:`,
    `<code>${dest}</code>`,
    ...(isContract ? ['', '⚠️ This is a smart-contract address. Make sure it can receive USDC, or the funds may be stuck.'] : []),
    ...unconfirmedLines(bot, uid, 'withdraw', 'withdrawal'),
  ].join('\n'), { buttons: bot.confirmButtons(id, '📤 Send') });
}

export async function executeWithdraw(bot, uid, p, track) {
  const res = await bot.chain.withdraw(bot.wallets.get(uid), p.to, p.value, track);
  return { text: `✅ Sent ${fmtUsdcWei(p.value, 6)} USDC to ${short(p.to)} · ${txLink(bot.cfg.explorerUrl, res.txHash)}` };
}

export async function exportKey(bot, m) {
  const uid = uidOf(m);
  const id = bot.createPending(uid, 'export', {});
  return bot.reply(uid, [
    '🔐 <b>Export private key</b>',
    '',
    'Anyone with this key controls your wallet and everything in it. Never share it: no admin or support will ever ask for it.',
    `The key message deletes itself after ${bot.cfg.limits.exportMessageTtlSec} seconds.`,
  ].join('\n'), { buttons: bot.confirmButtons(id, '🔑 Show my key') });
}

export async function executeExport(bot, uid) {
  const wallet = bot.wallets.get(uid);
  const msg = await bot.reply(uid, `🔑 <tg-spoiler>${wallet.privateKey}</tg-spoiler>\n\nImport it into any EVM wallet (Rabby, MetaMask) on Arc, chain 5042.`, {
    protect_content: true,
  });
  // Persisted, so a restart inside the window still deletes it.
  bot.scheduleDeletion(uid, msg.message_id, bot.cfg.limits.exportMessageTtlSec * 1000);
  return { text: `🔑 Key sent below. It will delete itself in ${bot.cfg.limits.exportMessageTtlSec} seconds.` };
}
