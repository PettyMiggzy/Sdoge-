import { esc, fmtCompactUsd, fmtPrice, fmtTokens, fmtUsdc6, fmtUsdcWei, bpsToPct } from '../format.js';
import { TOTAL_SUPPLY, usdPerToken, volume24h } from '../market.js';
import { promptBuyAmount } from './trade.js';

const uidOf = (m) => String(m.from.id);

const TERMS = `📜 <b>Before you start</b>

• This bot creates a wallet for you. Its key is held by this bot's server; you can export it anytime with /export. Only keep here what you're actively using.
• Meme tokens are extremely risky and most go to zero. Nothing here is financial advice.
• No sexual, hateful, violent or illegal content, no scams, no impersonating real projects. Launches that break these rules are hidden and their creators restricted.
• Every buy and sell pays a 2% fee in USDC. On buys, 0.5% goes to the token's vault (the redeemable floor), 0.5% to the creator and 1% to the platform. On sells, 2% goes to the platform.
• You must be allowed to use crypto services where you live.`;

export async function terms(bot, m, user) {
  const uid = uidOf(m);
  if (user.tosAt) return bot.reply(uid, TERMS);
  return bot.reply(uid, `${TERMS}\n\nTap below to agree and get started.`, {
    buttons: [[{ text: '✅ I agree', callback_data: 'tos:ok' }]],
  });
}

export async function start(bot, m, user, args) {
  const uid = uidOf(m);
  const payload = args[0] ?? '';
  if (!user.tosAt) return terms(bot, m, user);
  if (payload.startsWith('b_')) return promptBuyAmount(bot, uid, payload.slice(2));
  if (payload.startsWith('t_')) return token(bot, m, user, [payload.slice(2)], '', { byKey: true });
  return help(bot, m, user);
}

export async function help(bot, m) {
  const uid = uidOf(m);
  return bot.reply(uid, [
    '🐕 <b>SDOGE Launchpad</b>: launch and trade meme tokens on Arc, right here.',
    '',
    '<b>Launch</b>',
    '/launch: create a token (name, ticker, image) in one tap',
    '/mylaunches: your tokens · /claim: collect your creator fees',
    '',
    '<b>Trade</b>',
    '/buy $TICKER 10: spend 10 USDC',
    '/sell $TICKER 50%: or an amount, or "all"',
    '/token $TICKER · /trending · /slippage 5',
    '',
    '<b>Meme vault</b>',
    '/vault $TICKER: the USDC floor behind a token',
    '/redeem $TICKER 25%: burn tokens for their share of the vault',
    '',
    '<b>Wallet</b>',
    '/wallet · /deposit · /withdraw 10 0xAddress · /export',
    '',
    '/report $TICKER reason · /terms',
  ].join('\n'));
}

export async function cancel(bot, m) {
  bot.clearConvo(uidOf(m));
  return bot.reply(uidOf(m), 'Cancelled.');
}

export async function deposit(bot, m) {
  const address = bot.wallets.address(uidOf(m));
  return bot.reply(uidOf(m), [
    '📥 <b>Deposit</b>',
    'Send USDC on <b>Arc</b> (chain 5042) to:',
    `<code>${address}</code>`,
    '',
    'USDC is also Arc\'s gas, so one balance covers trades and fees. Only send on Arc: tokens sent on other chains won\'t arrive.',
  ].join('\n'));
}

export async function wallet(bot, m, user) {
  const uid = uidOf(m);
  const address = bot.wallets.address(uid);
  const balance = await bot.chain.nativeBalance(address);
  const lines = ['👛 <b>Your wallet</b>', `<code>${address}</code>`, '', `USDC: <b>${fmtUsdcWei(balance)}</b>`];

  const tokens = [...new Set(user.tokens ?? [])].slice(-15);
  const holdings = await Promise.all(tokens.map(async (t) => {
    const l = bot.store.launch(t);
    if (!l) return null;
    const b = await bot.chain.tokenBalance(l.token, address).catch(() => 0n);
    return b > 0n ? `• $${esc(l.symbol)}: ${fmtTokens(b)} (/t_${l.key})` : null;
  }));
  const held = holdings.filter(Boolean);
  if (held.length) lines.push('', '<b>Tokens</b>', ...held);

  if (bot.chain.canClaim) {
    const owed = await bot.chain.owed(address).catch(() => 0n);
    if (owed > 0n) lines.push('', `💰 Creator fees ready: <b>${fmtUsdc6(owed)} USDC</b> → /claim`);
  }
  lines.push('', '/deposit to add USDC · /withdraw to send it out');
  return bot.reply(uid, lines.join('\n'));
}

export async function slippage(bot, m, user, args) {
  const uid = uidOf(m);
  const current = user.slippageBps ?? bot.cfg.limits.defaultSlippageBps;
  if (!args[0]) return bot.reply(uid, `Max slippage: <b>${bpsToPct(current)}</b>. Change it with /slippage 3 (for 3%).`);
  const pct = Number(String(args[0]).replace('%', ''));
  const bps = Math.round(pct * 100);
  if (!Number.isFinite(pct) || bps < 10 || bps > bot.cfg.limits.maxSlippageBps) {
    return bot.reply(uid, `Pick between 0.1% and ${bpsToPct(bot.cfg.limits.maxSlippageBps)}.`);
  }
  user.slippageBps = bps;
  bot.store.touch();
  return bot.reply(uid, `✅ Max slippage set to <b>${bpsToPct(bps)}</b>.`);
}

async function marketSnapshot(bot, l) {
  const [sqrt, vs] = await Promise.all([
    bot.chain.poolSqrtPrice(l.poolId).catch(() => null),
    bot.chain.vaultState(l.vault).catch(() => null),
  ]);
  const price = sqrt ? usdPerToken(sqrt) : 0;
  const backing6 = vs?.backing6 ?? 0n;
  const floor = vs ? Number(vs.floor18) / 1e18 : 0;
  return { price, mcap: price * TOTAL_SUPPLY, backing6, supply: vs?.supply ?? 0n, floor };
}

export async function token(bot, m, user, args, rest, { byKey = false } = {}) {
  const uid = uidOf(m);
  let l;
  if (byKey) {
    l = bot.store.launchByKey(String(args[0] ?? '').toLowerCase());
    if (!l || ((l.hidden || l.status !== 'approved') && !bot.isAdmin(uid))) return bot.reply(uid, 'Token not found.');
  } else {
    const r = bot.resolveToken(args[0], { includeHidden: true });
    if (r.error) return bot.reply(uid, r.error);
    l = r.launch;
  }
  const s = await marketSnapshot(bot, l);
  const lines = [
    `🪙 <b>${esc(l.name)}</b> ($${esc(l.symbol)})`,
    `<code>${l.token}</code>`,
    '',
    `Price: <b>${fmtPrice(s.price)}</b> · MCap: <b>${fmtCompactUsd(s.mcap)}</b>`,
    `24h volume: ${fmtCompactUsd(Number(volume24h(l, bot.now())) / 1e6)}`,
    `Vault: ${fmtUsdc6(s.backing6)} USDC · floor ${fmtPrice(s.floor)}`,
  ];
  if (l.description) lines.push('', esc(l.description));
  if (l.hidden) lines.push('', '⚠️ Hidden by moderators. Buying is disabled here; holders can still /sell or /redeem.');
  const buttons = [[{ text: '🔍 Explorer', url: bot.explorer('token', l.token) }]];
  if (!l.hidden && l.status === 'approved') buttons[0].unshift({ text: '🟢 Buy', callback_data: `b:${l.key}` });
  return bot.reply(uid, lines.join('\n'), { buttons });
}

export async function vault(bot, m, user, args) {
  const uid = uidOf(m);
  const r = bot.resolveToken(args[0], { includeHidden: true });
  if (r.error) return bot.reply(uid, r.error);
  const l = r.launch;
  const s = await marketSnapshot(bot, l);
  const premium = s.floor > 0 && s.price > 0 ? (s.price / s.floor - 1) * 100 : null;
  return bot.reply(uid, [
    `🏦 <b>$${esc(l.symbol)} meme vault</b>`,
    '',
    `Backing: <b>${fmtUsdc6(s.backing6)} USDC</b> (0.5% of every buy)`,
    `Shared by: ${fmtTokens(s.supply)} $${esc(l.symbol)} (every token, even the ones still in the pool)`,
    `Floor: <b>${fmtPrice(s.floor)}</b> per token`,
    `Market: ${fmtPrice(s.price)}${premium === null ? '' : ` (${premium >= 0 ? '+' : ''}${premium.toFixed(1)}% vs floor)`}`,
    '',
    'The floor only goes up: buys add USDC, and redeeming or burning tokens never lowers it.',
    'Redeeming burns your tokens and pays their share of the vault in USDC. It only makes sense when the market price is below the floor.',
    `/redeem $${esc(l.symbol)} 25%`,
  ].join('\n'));
}

export async function trending(bot, m) {
  const uid = uidOf(m);
  const now = bot.now();
  const rows = bot.visibleLaunches()
    .map((l) => ({ l, vol: volume24h(l, now) }))
    .filter((x) => x.vol > 0n)
    .sort((a, b) => (b.vol > a.vol ? 1 : b.vol < a.vol ? -1 : 0))
    .slice(0, 10);
  if (!rows.length) return bot.reply(uid, 'No trades in the last 24h yet. Be first: /launch');
  const lines = rows.map(({ l, vol }, i) => `${i + 1}. <b>$${esc(l.symbol)}</b>: ${fmtCompactUsd(Number(vol) / 1e6)} 24h · /t_${l.key}`);
  return bot.reply(uid, ['🔥 <b>Trending (24h volume)</b>', '', ...lines].join('\n'));
}

export async function myLaunches(bot, m) {
  const uid = uidOf(m);
  const mine = Object.values(bot.store.data.launches)
    .filter((l) => l.tgUserId === uid)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20);
  if (!mine.length) return bot.reply(uid, 'You haven\'t launched anything yet. /launch');
  const status = (l) => (l.hidden ? '🚫 hidden' : l.status === 'approved' ? '✅ live' : l.status === 'pending' ? '⏳ in review' : '🚫 rejected');
  const lines = mine.map((l) => `• <b>$${esc(l.symbol)}</b> ${esc(l.name)}: ${status(l)} · /t_${l.key}`);
  return bot.reply(uid, ['🚀 <b>Your launches</b>', '', ...lines, '', 'You earn 0.5% of every buy of your tokens. /claim to collect.'].join('\n'));
}
