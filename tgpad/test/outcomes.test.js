// What users are told after they confirm, and what the bot remembers:
// R2-TGPAD-01 (outcomes by hash), -02 (late taps, queue), -12 (drain,
// restart), -13 (launches the indexer sees first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Interface, getAddress } from 'ethers';
import { FACTORY_ABI } from '../src/abi.js';
import { LAUNCHED_TOPIC } from '../src/chain.js';
import { Indexer } from '../src/indexer.js';
import { Sender } from '../src/telegram.js';
import { Store } from '../src/store.js';
import { CHANNEL, E18, acceptTerms, addLaunch, button, gate, makeBot, msg, send, settle, tap } from './helpers.js';

const U = '12345';
const DEST = '0x1234567890123456789012345678901234567890';
const iface = new Interface(FACTORY_ABI);

async function ready(bot, chain, uid = U, usdc = 100n) {
  await acceptTerms(bot, uid);
  chain.setBalance(bot.wallets.address(uid), usdc * E18);
}

// Everything the bot did in the user's chat after call index `from`.
function timeline(tg, from, uid = U) {
  return tg.calls.slice(from).flatMap(({ method, payload }) => {
    if (method === 'answerCallbackQuery') return [`answer(${payload.text ?? ''})`];
    if (String(payload.chat_id) !== uid) return [];
    const t = (payload.text ?? payload.caption ?? '').replace(/<[^>]+>/g, '').split('\n')[0].slice(0, 60);
    if (method === 'editMessageText' || method === 'editMessageCaption') return [`edit#${payload.message_id}(${t})`];
    if (method === 'sendMessage') return [`send(${t})`];
    return [];
  });
}

async function launchPreview(bot, tg, uid = U, { name = 'Lost Doge', ticker = 'LOST' } = {}) {
  await send(bot, msg(uid, '/launch'));
  await send(bot, msg(uid, name));
  await send(bot, msg(uid, ticker));
  await send(bot, msg(uid, '/skip'));
  await send(bot, msg(uid, '/skip'));
  const ok = button(tg, uid);
  assert.match(String(ok), /^ok:/, tg.lastText(uid));
  return ok;
}

// ---------------------------------------------------------------- R2-TGPAD-01

test('R2-TGPAD-01: an unknown outcome is never "nothing was spent": link, don\'t-retry, saved by hash, then reconciled', async () => {
  const { bot, tg, chain, store, dir } = await makeBot();
  await ready(bot, chain);
  await send(bot, msg(U, `/withdraw 30 ${DEST}`));
  chain.outcomeNext = 'unknown';
  await send(bot, tap(U, button(tg, U)));
  const shown = tg.lastEditText();
  assert.match(shown, /Sent, but not confirmed yet/);
  assert.match(shown, /Don't retry/);
  assert.doesNotMatch(shown, /nothing was spent/i);
  const [hash] = Object.keys(store.data.txs);
  assert.match(shown, new RegExp(`/tx/${hash}`), 'the transaction link is shown');

  // Saved before the broadcast: a restarted bot still knows about it.
  await store.flush();
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8'));
  assert.equal(onDisk.txs[hash].kind, 'withdraw');

  // A retry warns that the first one may still land.
  await send(bot, msg(U, `/withdraw 30 ${DEST}`));
  assert.match(tg.lastText(U), /previous withdrawal .* isn't confirmed yet/);

  // The receipt shows up later: the message is updated and the record dropped.
  await bot.reconcileTxs();
  assert.ok(store.data.txs[hash], 'no receipt yet: kept');
  chain.receipts.set(hash, { status: 1 });
  await bot.reconcileTxs();
  assert.match(tg.lastEditText(), /went through after all/);
  assert.equal(store.data.txs[hash], undefined);
});

test('R2-TGPAD-01: reverted and refused outcomes say exactly what was spent', async () => {
  const { bot, tg, chain, store } = await makeBot();
  await ready(bot, chain);
  const l = addLaunch(bot);
  await send(bot, msg(U, '/buy CAPD 10'));
  chain.outcomeNext = { outcome: 'reverted', reason: { name: 'InsufficientOutput', args: [1n, 2n] } };
  await send(bot, tap(U, button(tg, U)));
  assert.match(tg.lastEditText(), /reverted on-chain<\/b>: The price moved past your slippage limit\. Nothing was bought; only the gas fee was spent/);
  assert.match(tg.lastEditText(), /\/tx\/0x/);

  await send(bot, msg(U, `/withdraw 5 ${DEST}`));
  chain.outcomeNext = { outcome: 'refused', reason: { name: 'nonce' } };
  await send(bot, tap(U, button(tg, U)));
  assert.match(tg.lastEditText(), /another transaction in flight, so nothing was sent and nothing was spent/);
  assert.deepEqual(store.data.txs, {}, 'final outcomes leave nothing to reconcile');

  // A sell whose approval went through before the sell failed.
  chain.needsApproval = true;
  chain.setTokenBalance(l.token, bot.wallets.address(U), 100n * E18);
  await send(bot, msg(U, '/sell CAPD 50%'));
  chain.outcomeNext = null;
  const sellTap = tap(U, button(tg, U));
  const realSell = chain.sell.bind(chain);
  chain.sell = async (...a) => {
    const track = a[5];
    const wrapped = { ...track, onFinal: (h, o) => { track.onFinal(h, o); if (o === 'confirmed' && h.startsWith('0x61')) chain.outcomeNext = { outcome: 'refused', reason: { name: 'insufficient_funds' } }; } };
    return realSell(a[0], a[1], a[2], a[3], a[4], wrapped);
  };
  await send(bot, sellTap);
  assert.match(tg.lastEditText(), /Nothing was sold; the token approval before it did go through/);
  assert.doesNotMatch(tg.lastEditText(), /nothing was spent/);
});

test('R2-TGPAD-01/-13: a launch with an unknown outcome is still recorded as the user\'s when the indexer sees it', async () => {
  const { bot, tg, chain, store } = await makeBot();
  await ready(bot, chain);
  const ok = await launchPreview(bot, tg);
  chain.outcomeNext = 'unknown';
  await send(bot, tap(U, ok));
  assert.match(tg.lastEditText(), /Sent, but not confirmed yet/);
  const wallet = bot.wallets.address(U);
  assert.equal(store.data.botWallets[wallet.toLowerCase()], U, 'the wallet belongs to the user before anything is sent');
  const [hash] = Object.keys(store.data.pendingLaunches);
  assert.equal(store.data.pendingLaunches[hash].name, 'Lost Doge');
  assert.equal(bot.launchesToday(U), 1, 'an unconfirmed launch counts toward the daily limit');
  await launchPreview(bot, tg, U, { name: 'Second Doge', ticker: 'SECD' });
  assert.match(tg.lastText(U), /previous launch .* isn't confirmed yet/, 'a second launch preview warns');

  // The launch was mined after all; the indexer finds the Launched log first.
  const TOKEN = getAddress('0x7700000000000000000000000000000000000abc');
  const { data, topics } = iface.encodeEventLog('Launched', [0, '0x' + 'cd'.repeat(32), TOKEN, getAddress('0x8800000000000000000000000000000000000abc'), wallet, 'Lost Doge', 'LOST', '']);
  store.data.indexer.lastBlock = 1000;
  chain.blockNumber = async () => 1001;
  chain.getLogs = async (f) => (f.topics[0] === LAUNCHED_TOPIC ? [{ address: bot.cfg.factory, data, topics, transactionHash: hash }] : []);
  await new Indexer({ bot }).tick();
  await bot.drain();
  const l = store.launch(TOKEN);
  assert.equal(l.source, 'bot');
  assert.equal(l.tgUserId, U);
  assert.equal(l.status, 'approved');
  assert.equal(tg.sentTo(CHANNEL).length, 1, 'announced like any bot launch');
  assert.equal(bot.launchesToday(U), 1, 'counted once');
  await send(bot, msg(U, '/mylaunches'));
  assert.match(tg.lastText(U), /Lost Doge/);

  // The reconciler then finds the receipt: the user's message gets the launch result.
  chain.receipts.set(hash, { status: 1, launched: { index: 0, poolId: '0x' + 'cd'.repeat(32), token: TOKEN, vault: TOKEN, creator: wallet } });
  await bot.reconcileTxs();
  await bot.drain();
  assert.match(tg.lastEditText(), /\$LOST is live on Arc/);
  assert.deepEqual(store.data.txs, {});
});

test('R2-TGPAD-13: the indexer ticking while the launch is in flight no longer loses it when the receipt wait fails', async () => {
  const { bot, tg, chain, store } = await makeBot();
  await ready(bot, chain);
  const idx = new Indexer({ bot });
  const ok = await launchPreview(bot, tg);
  const TOKEN = getAddress('0x7700000000000000000000000000000000000def');
  store.data.indexer.lastBlock = 1000;
  chain.launch = async (signer, draft, fee, track) => {
    const hash = '0x' + '2'.repeat(64);
    await track.onSigned(hash, { label: 'launch' });
    const { data, topics } = iface.encodeEventLog('Launched', [0, '0x' + 'cd'.repeat(32), TOKEN, getAddress('0x8800000000000000000000000000000000000def'), signer.address, 'Lost Doge', 'LOST', '']);
    chain.blockNumber = async () => 1001;
    chain.getLogs = async (f) => (f.topics[0] === LAUNCHED_TOPIC ? [{ address: bot.cfg.factory, data, topics, transactionHash: hash }] : []);
    await idx.tick(); // mined; the indexer sees it while the job still waits for the receipt
    const { TxError } = await import('../src/errors.js');
    throw new TxError('unknown', 'no receipt yet', { hash, label: 'launch' });
  };
  await send(bot, tap(U, ok));
  const l = store.launch(TOKEN);
  assert.ok(l, 'recorded');
  assert.equal(l.tgUserId, U);
  await send(bot, msg(U, `/token ${TOKEN}`));
  assert.match(tg.lastText(U), /Lost Doge/);
});

// ---------------------------------------------------------------- R2-TGPAD-02

test('R2-TGPAD-02 (a): Confirm then a quick Cancel: sent once, the result stays, and the user\'s other messages are answered meanwhile', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  await send(bot, msg(U, `/withdraw 25 ${DEST}`));
  const previewId = tg.nextMessageId - 1;
  const [ok, no] = [button(tg, U, 0), button(tg, U, 1)];
  const mined = gate();
  const realWithdraw = chain.withdraw.bind(chain);
  chain.withdraw = async (...a) => { await mined.promise; return realWithdraw(...a); };

  const mark = tg.calls.length;
  const ps = [
    bot.dispatch(tap(U, ok, { messageId: previewId })),
    bot.dispatch(tap(U, no, { messageId: previewId })),
    bot.dispatch(msg(U, '/wallet')),
    bot.dispatch(msg(U, '/help')),
  ];
  await settle();
  const whilePending = timeline(tg, mark);
  assert.ok(whilePending.includes('answer(Too late to cancel: it was already confirmed.)'), JSON.stringify(whilePending));
  assert.ok(whilePending.some((x) => x.startsWith('send(👛 Your wallet')), '/wallet answered while the transaction is pending');
  assert.ok(whilePending.some((x) => x.startsWith('send(🐕 SDOGE Launchpad')), '/help answered too');

  mined.open();
  await Promise.all(ps);
  await bot.drain();
  const edits = timeline(tg, mark).filter((x) => x.startsWith(`edit#${previewId}`));
  assert.equal(chain.calls.filter((c) => c.fn === 'withdraw').length, 1);
  assert.match(edits.at(-1), /Sent 25 USDC/, 'the result is the last word');
  assert.ok(!edits.some((x) => /Cancelled/.test(x)));
});

test('R2-TGPAD-02 (b): a double-tapped Confirm buys once and keeps the result', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  addLaunch(bot, { name: 'Tap Doge', symbol: 'TAPD' });
  await send(bot, msg(U, '/buy $TAPD 20'));
  const previewId = tg.nextMessageId - 1;
  const ok = button(tg, U, 0);
  const mined = gate();
  const realBuy = chain.buy.bind(chain);
  chain.buy = async (...a) => { await mined.promise; return realBuy(...a); };
  const mark = tg.calls.length;
  const ps = [bot.dispatch(tap(U, ok, { messageId: previewId })), bot.dispatch(tap(U, ok, { messageId: previewId }))];
  await settle();
  mined.open();
  await Promise.all(ps);
  await bot.drain();
  const all = timeline(tg, mark);
  assert.equal(chain.calls.filter((c) => c.fn === 'buy').length, 1);
  assert.ok(all.includes('answer(Already confirmed. The result will appear here.)'));
  assert.match(all.filter((x) => x.startsWith(`edit#${previewId}`)).at(-1), /Bought/);
});

test('R2-TGPAD-02 (c): the launch result and the user\'s next reply don\'t wait for a busy launch channel', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  bot.sender = new Sender(tg, { privateGapMs: 0, groupGapMs: 150, globalGapMs: 0 });
  for (let i = 0; i < 5; i++) bot.sender.send(CHANNEL, 'sendMessage', { text: `alert ${i}` });
  const pid = bot.createPending(U, 'launch', {
    name: 'Tap Doge', symbol: 'TAPD', description: '', imageFileId: null,
    moderation: { verdict: 'allow', categories: [], reasons: [] }, fee: chain.fee,
  });
  const t0 = Date.now();
  await bot.dispatch(tap(U, `ok:${pid}`, { messageId: 77 }));
  await bot.dispatch(msg(U, '/help'));
  const helpAt = Date.now() - t0;
  const resultEdit = () => tg.calls.findIndex((c) => c.method === 'editMessageText' && /is live on Arc/.test(c.payload.text ?? ''));
  for (let i = 0; i < 50 && resultEdit() < 0; i++) await settle(10);
  const announceIdx = () => tg.calls.findIndex((c) => String(c.payload.chat_id) === CHANNEL && /just launched/.test(c.payload.text ?? ''));
  assert.ok(resultEdit() >= 0 && (announceIdx() < 0 || resultEdit() < announceIdx()), 'the result edit went out before the channel post');
  assert.ok(helpAt < 300, `/help answered after ${helpAt} ms, not after the ~750 ms channel backlog`);
  await bot.drain();
  assert.match(tg.lastEditText(), /Announced in the launch channel/);
});

test('R2-TGPAD-02 (d): while one job runs, another preview\'s Confirm is handled at once; its re-tap only gets a toast', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  addLaunch(bot, { name: 'Tap Doge', symbol: 'TAPD' });
  await send(bot, msg(U, `/withdraw 5 ${DEST}`));
  const idA = tg.nextMessageId - 1;
  const okA = button(tg, U, 0);
  await send(bot, msg(U, '/buy $TAPD 10'));
  const idB = tg.nextMessageId - 1;
  const okB = button(tg, U, 0);
  const minedA = gate();
  const realWithdraw = chain.withdraw.bind(chain);
  chain.withdraw = async (...a) => { await minedA.promise; return realWithdraw(...a); };
  const mark = tg.calls.length;
  const ps = [bot.dispatch(tap(U, okA, { messageId: idA }))];
  await settle();
  ps.push(bot.dispatch(tap(U, okB, { messageId: idB })));
  await settle();
  // B is answered and marked at once (it then waits its turn in the wallet's
  // queue, after A, so nonces stay in order): its buttons don't stay live.
  const whileA = timeline(tg, mark);
  assert.equal(whileA.filter((x) => x === 'answer(Working on it…)').length, 2, JSON.stringify(whileA));
  assert.ok(whileA.includes(`edit#${idB}(⏳ Working on it…)`));
  ps.push(bot.dispatch(tap(U, okB, { messageId: idB })));
  minedA.open();
  await Promise.all(ps);
  await bot.drain();
  const editsB = timeline(tg, mark).filter((x) => x.startsWith(`edit#${idB}`));
  assert.match(editsB.at(-1), /Bought/);
  assert.equal(chain.calls.filter((c) => c.fn === 'buy').length, 1);
});

test('R2-TGPAD-02: an expired confirmation still says so, and a Cancel on nothing edits nothing', async () => {
  const { bot, tg, chain, time } = await makeBot();
  await ready(bot, chain);
  addLaunch(bot);
  await send(bot, msg(U, '/buy CAPD 10'));
  const [ok, no] = [button(tg, U, 0), button(tg, U, 1)];
  time.t += 121_000;
  await send(bot, tap(U, no));
  assert.match(tg.lastEditText(), /expired/);
  const edits = tg.edits().length;
  await send(bot, tap(U, 'no:doesnotexist'));
  assert.equal(tg.edits().length, edits);
  await send(bot, tap(U, ok));
  assert.equal(chain.calls.length, 0);
});

// ---------------------------------------------------------------- R2-TGPAD-12

test('R2-TGPAD-12: drain() also waits for jobs started while draining, and a stopping bot refuses new confirmations', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  const mined = gate();
  const realWithdraw = chain.withdraw.bind(chain);
  chain.withdraw = async (...a) => { await mined.promise; return realWithdraw(...a); };
  await send(bot, msg(U, `/withdraw 5 ${DEST}`));
  const first = button(tg, U);
  await send(bot, msg(U, `/withdraw 6 ${DEST}`));
  const second = button(tg, U);
  // A Confirm already queued when shutdown begins: its job starts after drain() did.
  const queued = bot.dispatch(tap(U, first));
  const drained = bot.drain();
  let done = false;
  drained.then(() => { done = true; });
  await queued;
  await settle();
  assert.equal(done, false, 'drain waits for the job that started after it');
  bot.stopping = true;
  await bot.dispatch(tap(U, second));
  assert.match(tg.called('answerCallbackQuery').at(-1).payload.text, /restarting/);
  mined.open();
  await drained;
  assert.equal(chain.calls.filter((c) => c.fn === 'withdraw').length, 1);
  assert.match(tg.lastEditText(), /Sent 5 USDC/);
});

test('R2-TGPAD-12: after a restart, unfinished jobs are told whether anything was sent', async () => {
  const { bot, tg, chain, store, dir } = await makeBot();
  await ready(bot, chain);
  store.data.jobs = {
    a: { uid: U, kind: 'buy', chatId: Number(U), messageId: 50, captioned: false, at: 0, sent: false },
    b: { uid: U, kind: 'withdraw', chatId: Number(U), messageId: 51, captioned: false, at: 0, sent: true },
    c: { uid: U, kind: 'sell', chatId: Number(U), messageId: 52, captioned: false, at: 0, sent: true },
  };
  store.data.txs = { ['0x' + '5'.repeat(64)]: { hash: '0x' + '5'.repeat(64), uid: U, kind: 'sell', label: 'sell', chatId: Number(U), messageId: 52, sentAt: bot.now() } };
  await store.flush();
  const reopened = await Store.open(path.join(dir, 'store.json'));
  bot.store = reopened;
  bot.recoverJobs();
  await bot.drain();
  const byId = (id) => tg.edits().filter((e) => e.payload.message_id === id).map((e) => e.payload.text);
  assert.match(byId(50).at(-1), /before this was sent\. Nothing was sent/);
  assert.match(byId(51).at(-1), /Check \/wallet/);
  assert.equal(byId(52).length, 0, 'still tracked by hash: the reconciler will update it');
  assert.deepEqual(reopened.data.jobs, {});
});

test('R2-TGPAD-12: an exported key\'s deletion survives a restart', async () => {
  const { bot, tg, chain, store } = await makeBot();
  await ready(bot, chain);
  await send(bot, msg(U, '/export'));
  await send(bot, tap(U, button(tg, U)));
  assert.equal(store.data.deletions.length, 1);
  const keyMessage = store.data.deletions[0].messageId;
  // Restart before the timer fires: only the persisted entry is left.
  const fresh = (await makeBot()).bot;
  fresh.store = store;
  fresh.tg = tg;
  fresh.now = () => bot.now() + 61_000;
  await fresh.processDeletions();
  assert.deepEqual(tg.called('deleteMessage').at(-1).payload, { chat_id: U, message_id: keyMessage });
  assert.equal(store.data.deletions.length, 0);
});
