// Command and button flows, one block per round-2 finding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Interface, getAddress } from 'ethers';
import { FACTORY_ABI, SWAP_TOPIC } from '../src/abi.js';
import { Indexer } from '../src/indexer.js';
import { parseAmount } from '../src/util.js';
import {
  ADMIN, CHANNEL, E18, StubModerator, acceptTerms, addLaunch, button, makeBot, makeCfg, msg, photo, send, tap,
} from './helpers.js';

const U = '12345';
const iface = new Interface(FACTORY_ABI);

async function ready(bot, chain, uid = U, usdc = 100n) {
  await acceptTerms(bot, uid);
  chain.setBalance(bot.wallets.address(uid), usdc * E18);
}

async function wizard(bot, uid, { name = 'Cap Doge', ticker = 'CAPD', withPhoto = false, description = null } = {}) {
  await send(bot, msg(uid, '/launch'));
  await send(bot, msg(uid, name));
  await send(bot, msg(uid, ticker));
  await send(bot, withPhoto ? photo(uid, typeof withPhoto === 'string' ? withPhoto : 'pic1') : msg(uid, '/skip'));
  await send(bot, description === null ? msg(uid, '/skip') : msg(uid, description));
}

// ---------------------------------------------------------------- R2-TGPAD-04

test('R2-TGPAD-04: with no model, a text-only launch goes live but waits for an admin: nothing is auto-published', async () => {
  const { bot, tg, chain, store } = await makeBot({ moderator: null });
  await ready(bot, chain);
  await wizard(bot, U, { name: 'Cap Doge', ticker: 'capd' });
  assert.match(tg.lastText(U), /A moderator will check this/);
  await send(bot, tap(U, button(tg, U)));
  const l = Object.values(store.data.launches)[0];
  assert.equal(l.status, 'pending');
  assert.equal(tg.sentTo(CHANNEL).length, 0, 'no channel post');
  assert.equal(tg.sentTo(ADMIN).length, 1, 'an admin review card');
  assert.match(tg.lastEditText(), /announced once a moderator approves it/);
});

test('R2-TGPAD-04: the auditors\' no-model launches are refused before they reach the chain', async () => {
  for (const c of [
    { name: 'LoliDoge', ticker: 'LD' },
    { name: 'N!gger Doge', ticker: 'NGD' },
    { name: '$USDC', ticker: 'USDC2' },
    { name: 'Circle USDC', ticker: 'usdc2' },
    { name: 'Moon Doge', ticker: 'MD', description: 'claim your USDC bonus at usdc-refund.top' },
    { name: 'Moon Doge', ticker: 'MD', description: 'nіgger coin' },
  ]) {
    const { bot, tg, chain } = await makeBot({ moderator: null });
    await ready(bot, chain);
    await wizard(bot, U, c);
    assert.notEqual(String(button(tg, U)).slice(0, 3), 'ok:', `${c.name} ${c.description ?? ''}: ${tg.lastText(U)}`);
    assert.equal(chain.calls.length, 0);
  }
});

// ---------------------------------------------------------------- R2-TGPAD-05

test('R2-TGPAD-05: wizard input Telegram itself marks as a link is refused', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  await send(bot, msg(U, '/launch'));
  await send(bot, msg(U, 'ArcDrop.pro'));
  assert.match(tg.lastText(U), /No links/);
  await send(bot, msg(U, 'Arc Drop'));
  await send(bot, msg(U, 'ADROP'));
  await send(bot, msg(U, '/skip'));
  await send(bot, msg(U, 'see arcdrop dot pro', { entities: [{ type: 'url', offset: 4, length: 15 }] }));
  assert.match(tg.lastText(U), /No links/);
  assert.equal(bot.getConvo(U).step, 'description', 'still on the description step');
});

// ---------------------------------------------------------------- R2-TGPAD-07 / R2-LAUNCH-03

test('R2-TGPAD-07: the fee shown is the fee sent; a fee change before the tap fails instead of charging more', async () => {
  const { bot, tg, chain, store } = await makeBot();
  await ready(bot, chain, U, 200n);
  await wizard(bot, U);
  assert.match(tg.lastText(U), /Cost: <b>2 USDC<\/b>/);
  chain.fee = 100n * E18; // the owner raised it inside the confirmation window
  await send(bot, tap(U, button(tg, U)));
  assert.equal(chain.calls.at(-1).fee, 2n * E18, 'exactly the previewed fee was offered');
  assert.equal(chain.launches, 0, 'nothing launched');
  assert.match(tg.lastEditText(), /launch fee changed from 2 to 100 USDC, so nothing was sent and nothing was spent\. Start \/launch again/);
  assert.deepEqual(store.data.pendingLaunches, {});

  chain.fee = 2n * E18;
  await wizard(bot, U);
  await send(bot, tap(U, button(tg, U)));
  assert.match(tg.lastEditText(), /Launch fee paid: 2 USDC/);
});

test('R2-TGPAD-07: a preview needs the fee plus the gas estimate, not just more than the fee', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  chain.setBalance(bot.wallets.address(U), 2n * E18 + 10n ** 16n); // enough to start the wizard
  chain.estimateLaunch = async (signer, draft, fee) => ({ fee, gasCost: 2n * 10n ** 16n });
  await wizard(bot, U);
  assert.match(tg.lastText(U), /Launching costs 2 USDC plus a little gas/);
  assert.equal(button(tg, U), undefined);
});

// ---------------------------------------------------------------- R2-TGPAD-08 / R2-LAUNCH-04

test('R2-LAUNCH-04: the default slippage is 1%', () => {
  const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(cfg.limits.defaultSlippageBps, 100);
  assert.ok(cfg.limits.execSlippageBps <= 100);
});

test('R2-TGPAD-08: the price is quoted again at confirm; a favourable move tightens minOut to the fresh quote', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain, U, 1000n);
  addLaunch(bot);
  let quotes = 0;
  const q = chain.quoteBuy.bind(chain);
  chain.quoteBuy = async (...a) => { quotes++; return q(...a); };
  await send(bot, msg(U, '/buy CAPD 10'));
  const before = quotes;
  chain.quoteBuy = async (t, u) => { quotes++; return (u * 10n ** 15n * 17n) / 10n; }; // 70% more tokens now
  await send(bot, tap(U, button(tg, U)));
  const call = chain.calls.find((c) => c.fn === 'buy');
  assert.equal(quotes - before, 1, 'quoted again right before sending');
  assert.equal(call.minOut, (10n ** 22n * 17n / 10n * 99n) / 100n, '99% of the fresh quote, not 99% of the stale one');
});

test('R2-TGPAD-08: a price move past the slippage limit since the preview sends nothing', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain, U, 1000n);
  const l = addLaunch(bot);
  await send(bot, msg(U, '/buy CAPD 10'));
  chain.quoteBuy = async (t, u) => (u * 10n ** 15n * 95n) / 100n;
  await send(bot, tap(U, button(tg, U)));
  assert.equal(chain.calls.filter((c) => c.fn === 'buy').length, 0);
  assert.match(tg.lastEditText(), /price moved more than your 1% limit since the preview, so nothing was sent/);

  chain.setTokenBalance(l.token, bot.wallets.address(U), 100n * E18);
  await send(bot, msg(U, '/sell CAPD 50%'));
  chain.quoteSell = async (t, a) => (a / 10n ** 15n) * 90n / 100n;
  await send(bot, tap(U, button(tg, U)));
  assert.equal(chain.calls.filter((c) => c.fn === 'sell').length, 0);
});

test('R2-LAUNCH-04: a trade that moves the price a lot is flagged in the preview', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain, U, 5000n);
  addLaunch(bot);
  await send(bot, msg(U, '/buy CAPD 10'));
  assert.doesNotMatch(tg.lastText(U), /moves the price/, 'a small buy isn\'t');
  chain.quoteBuy = async (t, u) => (u * 10n ** 15n * 90n) / 100n; // ~8% worse than the spot price after the fee
  await send(bot, msg(U, '/buy CAPD 1000'));
  assert.match(tg.lastText(U), /moves the price about 8\.2%.*front-run/);
});

// ---------------------------------------------------------------- R2-TGPAD-10

test('R2-TGPAD-10: a decimal comma is refused with a hint, never read as thousands', async () => {
  assert.equal(parseAmount('2,50', 6), null);
  assert.equal(parseAmount('1,5', 18), null);
  assert.equal(parseAmount('0,5', 6), null);
  assert.equal(parseAmount('0,500', 6), null);
  assert.equal(parseAmount('1,00', 6), null);
  assert.equal(parseAmount('1,000', 6), 1_000_000_000n);
  assert.equal(parseAmount('12,345,678.9', 6), 12_345_678_900_000n);
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain, U, 1000n);
  const l = addLaunch(bot);
  await send(bot, msg(U, '/buy CAPD 2,50'));
  assert.match(tg.lastText(U), /Use a dot for decimals/);
  assert.equal(button(tg, U), undefined);
  await send(bot, msg(U, '/withdraw 1,5 0x1234567890123456789012345678901234567890'));
  assert.match(tg.lastText(U), /Use a dot for decimals/);
  chain.setTokenBalance(l.token, bot.wallets.address(U), 10n * E18);
  await send(bot, msg(U, '/sell CAPD 0,5'));
  assert.match(tg.lastText(U), /Use a dot for decimals/);
  await send(bot, msg(U, '/buy CAPD 2.5'));
  assert.match(tg.lastText(U), /Spend: <b>2\.5 USDC<\/b>/);
});

// ---------------------------------------------------------------- R2-TGPAD-15

test('R2-TGPAD-15: button taps share the per-user rate limit, and a flooded queue is cut off', async () => {
  const cfg = makeCfg();
  cfg.limits = { ...cfg.limits, commandsPerUserPerMinute: 20 };
  const { bot, tg, chain } = await makeBot({ cfg });
  await ready(bot, chain);
  const l = addLaunch(bot);
  let reads = 0;
  const orig = chain.vaultState.bind(chain);
  chain.vaultState = async (...a) => { reads++; return orig(...a); };
  const base = tg.sentTo(U).length;
  for (let i = 0; i < 200; i++) await send(bot, tap(U, `v:${l.key}`));
  assert.ok(tg.sentTo(U).length - base <= 20, `${tg.sentTo(U).length - base} replies to 200 taps`);
  assert.ok(reads <= 20);
  assert.match(tg.called('answerCallbackQuery').at(-1).payload.text, /Slow down/);
  const pendingBefore = bot.pending.size;
  for (let i = 0; i < 50; i++) await send(bot, tap(U, `ba:${l.key}:5`));
  assert.equal(bot.pending.size, pendingBefore, 'no more confirmations over the limit');

  // Updates piling up in one user's queue beyond the cap are dropped.
  const { bot: b2, tg: tg2 } = await makeBot();
  let release;
  b2.handleUpdate = () => new Promise((r) => { release = release ?? r; });
  const ps = [];
  for (let i = 0; i < 30; i++) ps.push(b2.dispatch(tap(U, 'v:x')));
  assert.equal(b2.perUser.depth(U), 20);
  assert.equal(tg2.called('answerCallbackQuery').length, 10, 'the 10 extra taps were answered and dropped');
});

// ---------------------------------------------------------------- R2-TGPAD-16

test('R2-TGPAD-16: abandoned wizards hold no image, and are swept', async () => {
  const { bot, tg, chain, time } = await makeBot();
  tg.downloadFile = async () => Buffer.alloc(4_000_000, 7);
  for (let i = 0; i < 10; i++) {
    const uid = String(20000 + i);
    await ready(bot, chain, uid);
    await send(bot, msg(uid, '/launch'));
    await send(bot, msg(uid, 'Heavy Doge'));
    await send(bot, msg(uid, `HVY${i}`));
    await send(bot, photo(uid, `p${i}`));
  }
  let bytes = 0;
  for (const c of bot.convos.values()) bytes += c.draft?.image?.buffer?.length ?? 0;
  assert.equal(bytes, 0, 'only Telegram file ids are kept');
  assert.equal(bot.convos.size, 10);
  time.t += 86_400_000;
  bot.sweep();
  assert.equal(bot.convos.size, 0);
});

// ---------------------------------------------------------------- R2-TGPAD-17

test('R2-TGPAD-17: a wallet that can\'t pay never gets a paid vision check', async () => {
  const cfg = makeCfg();
  cfg.limits = { ...cfg.limits, commandsPerUserPerMinute: 20 };
  const moderator = new StubModerator('allow');
  const { bot, tg, time } = await makeBot({ cfg, moderator });
  await acceptTerms(bot, U);
  for (let minute = 0; minute < 3; minute++) {
    for (let i = 0; i < 4; i++) await wizard(bot, U, { withPhoto: `pic-${minute}-${i}`, description: 'nice dog' });
    time.t += 60_000;
  }
  assert.equal(moderator.seen.length, 0);
  assert.ok(tg.sentTo(U).some((c) => /Launching costs 2 USDC/.test(c.payload.text ?? '')));
  assert.equal(tg.downloads ?? 0, 0, 'no image was even downloaded');
});

test('R2-TGPAD-17: model checks are capped per user per day, and the same draft is only screened once', async () => {
  const cfg = makeCfg();
  cfg.limits = { ...cfg.limits, moderationChecksPerUserPerDay: 3 };
  const moderator = new StubModerator('allow');
  const { bot, tg, chain } = await makeBot({ cfg, moderator });
  await ready(bot, chain);
  await wizard(bot, U, { withPhoto: 'same' });
  await wizard(bot, U, { withPhoto: 'same' });
  assert.equal(moderator.seen.length, 1, 'cached verdict for an identical draft');
  assert.equal(tg.downloads, 1, 'the image is only downloaded to be screened');
  for (let i = 0; i < 3; i++) await wizard(bot, U, { withPhoto: `other-${i}` });
  assert.equal(moderator.seen.length, 3);
  assert.match(tg.lastText(U), /launch check many times today/);
});

// ---------------------------------------------------------------- R2-TGPAD-19

test('R2-TGPAD-19: /ban @username hits the account that holds the name now, after a confirm', async () => {
  const { bot, tg, store } = await makeBot();
  const old = store.user('5000');
  old.username = 'moondev';
  old.tosAt = 1;
  await send(bot, { update_id: 1e9, message: { message_id: 1, from: { id: 7000000, is_bot: false, username: 'moondev' }, chat: { id: 7000000, type: 'private' }, text: '/help' } });
  assert.equal(store.user('7000000').username, 'moondev');
  assert.equal(store.user('5000').username, null, 'the stale claim is cleared');
  await acceptTerms(bot, ADMIN);
  await send(bot, msg(ADMIN, '/ban @moondev spam'));
  assert.match(tg.lastText(ADMIN), /Ban user 7000000 \(@moondev, last seen/);
  await send(bot, tap(ADMIN, button(tg, ADMIN)));
  assert.equal(store.user('7000000').banned, true);
  assert.equal(store.user('5000').banned, false);
  await send(bot, msg(ADMIN, '/ban 5000 old account'));
  assert.equal(store.user('5000').banned, true, 'a numeric id needs no confirm');
});

// ---------------------------------------------------------------- R2-TGPAD-21

function copycatLog(token, pool, { name = 'Cap Doge', symbol = 'CAPD' } = {}) {
  const { data, topics } = iface.encodeEventLog('Launched', [9, pool, token, getAddress('0x8800000000000000000000000000000000000c0c'), getAddress('0x' + '66'.repeat(20)), name, symbol, '']);
  return { address: '0x1111111111111111111111111111111111111111', data, topics, transactionHash: '0x' + '3'.repeat(64) };
}

test('R2-TGPAD-21: an on-chain copycat of a listed ticker goes to review, and never gets channel alerts', async () => {
  const { bot, tg, chain, store } = await makeBot({ moderator: new StubModerator('allow') });
  await ready(bot, chain);
  const orig = addLaunch(bot, { stats: { buys: 50, sells: 10, volume6: '90000000000', hourly: {} } });
  const idx = new Indexer({ bot });
  const COPY = getAddress('0x7700000000000000000000000000000000000c0c');
  const POOL2 = '0x' + 'ee'.repeat(32);
  await idx.onLaunched(copycatLog(COPY, POOL2));
  const copy = store.launch(COPY);
  assert.equal(copy.status, 'pending', 'the model said allow, but the ticker is taken');
  assert.match(tg.lastText(ADMIN), /Review needed/);
  assert.match(tg.lastText(ADMIN), /already uses this ticker/);

  // Even approved by the model, an on-chain launch gets no alerts until an admin approves it.
  const word = (v) => BigInt.asUintN(256, v).toString(16).padStart(64, '0');
  const buy = (pool) => ({ topics: [SWAP_TOPIC, pool, '0x' + '0'.repeat(64)], data: '0x' + [-30_000_000n, 5n * 10n ** 24n, 2n ** 96n * 1000n, 0n, 0n, 0n].map(word).join('') });
  copy.status = 'approved';
  idx.onSwap(buy(POOL2));
  assert.equal(tg.sentTo(CHANNEL).length, 0);
  // The original's alerts carry its name and address.
  idx.onSwap(buy(orig.poolId));
  assert.match(tg.lastText(CHANNEL), /\$CAPD<\/b> buy: <b>30 USDC<\/b>\nCap Doge · <code>0x7700…0001<\/code>/);
});

test('R2-TGPAD-21: buy and sell confirmations name the token and show its address', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  const l = addLaunch(bot);
  await send(bot, msg(U, `/start b_${l.key}`));
  assert.match(tg.lastText(U), /<b>Cap Doge<\/b> \(\$CAPD\) · <code>0x7700…0001<\/code>/);
  await send(bot, tap(U, `ba:${l.key}:10`));
  assert.match(tg.lastText(U), /Buy \$CAPD<\/b>\n<b>Cap Doge<\/b> \(\$CAPD\) · <code>0x7700…0001<\/code>/);
  chain.setTokenBalance(l.token, bot.wallets.address(U), 10n * E18);
  await send(bot, msg(U, '/sell CAPD 50%'));
  assert.match(tg.lastText(U), /Cap Doge<\/b> \(\$CAPD\) · <code>0x7700…0001<\/code>/);
});

test('R2-TGPAD-21: a hidden copycat no longer breaks /sell $TICKER, and duplicates are listed with name, age and volume', async () => {
  const { bot, tg, chain, time } = await makeBot();
  await ready(bot, chain);
  const real = addLaunch(bot, { stats: { buys: 5, sells: 0, volume6: '5000000', hourly: { [Math.floor(time.t / 3_600_000)]: '5000000' } } });
  addLaunch(bot, { source: 'chain', tgUserId: null, name: 'Cap Doge Nazi', status: 'rejected', hidden: true, createdAt: bot.now() + 1 });
  chain.setTokenBalance(real.token, bot.wallets.address(U), 1000n * E18);
  for (const cmd of ['/sell $CAPD 50%', '/redeem $CAPD 50%', '/vault $CAPD', '/token $CAPD', '/report $CAPD rug']) {
    await send(bot, msg(U, cmd));
    assert.doesNotMatch(tg.lastText(U), /Several tokens/, cmd);
  }
  // Two listed tokens with one ticker: listed by volume, with name, age and address.
  time.t += 3 * 86_400_000;
  const second = addLaunch(bot, { name: 'Cap Doge Two' });
  await send(bot, msg(U, '/buy $CAPD 5'));
  const text = tg.lastText(U);
  assert.match(text, /Several tokens use \$CAPD/);
  assert.match(text, /<b>Cap Doge<\/b> · 3d old/);
  assert.ok(text.indexOf(real.token) < text.indexOf(second.token), 'the older, traded one first');
});

// ---------------------------------------------------------------- R2-TGPAD-21 (bot launches)

test('R2-TGPAD-21: a bot launch reusing a listed ticker is held for review instead of being announced', async () => {
  const { bot, tg, chain, store } = await makeBot({ moderator: new StubModerator('allow') });
  await ready(bot, chain);
  addLaunch(bot);
  await wizard(bot, U, { name: 'Cap Doge Too', ticker: 'CAPD' });
  assert.match(tg.lastText(U), /A moderator will check this/);
  await send(bot, tap(U, button(tg, U)));
  const mine = Object.values(store.data.launches).find((l) => l.tgUserId === U);
  assert.equal(mine.status, 'pending');
  assert.equal(tg.sentTo(CHANNEL).length, 0);
});
