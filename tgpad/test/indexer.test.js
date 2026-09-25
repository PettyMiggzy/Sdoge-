import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, getAddress, toBeHex, zeroPadValue } from 'ethers';
import { FACTORY_ABI, SWAP_TOPIC } from '../src/abi.js';
import { Chain, LAUNCHED_TOPIC, makeProvider } from '../src/chain.js';
import { Indexer, isRangeError, rpcMessage } from '../src/indexer.js';
import { ADMIN, CHANNEL, StubModerator, acceptTerms, gate, makeBot, makeCfg, msg, send } from './helpers.js';
import { MockRpc } from './rpcmock.js';

const iface = new Interface(FACTORY_ABI);
const TOKEN = getAddress('0x7700000000000000000000000000000000000001');
const VAULT = getAddress('0x8800000000000000000000000000000000000001');
const CREATOR = getAddress('0x9900000000000000000000000000000000000001');
const POOL = '0x' + 'ab'.repeat(32);

function launchedLog({ name = 'Cap Doge', symbol = 'CAPD', creator = CREATOR } = {}) {
  const { data, topics } = iface.encodeEventLog('Launched', [7, POOL, TOKEN, VAULT, creator, name, symbol, '']);
  return { address: '0x1111111111111111111111111111111111111111', data, topics, transactionHash: '0x' + '1'.repeat(64) };
}

const word = (v) => zeroPadValue(toBeHex(BigInt.asUintN(256, v)), 32).slice(2);
function swapLog(amount0, amount1, sqrtPriceX96 = 2n ** 96n * 1000n) {
  return { topics: [SWAP_TOPIC, POOL, '0x' + '0'.repeat(64)], data: '0x' + [amount0, amount1, sqrtPriceX96, 0n, 0n, 0n].map(word).join('') };
}

function seedLaunch(bot, overrides = {}) {
  const record = {
    key: 'aaaa0001', source: 'bot', tgUserId: '1', index: 0, token: TOKEN, vault: VAULT, poolId: POOL, creator: CREATOR,
    name: 'Cap Doge', symbol: 'CAPD', description: '', imageFileId: null, moderation: { verdict: 'allow' },
    status: 'approved', hidden: false, createdAt: bot.now(), txHash: '0x', channelMessageId: null,
    stats: { buys: 0, sells: 0, volume6: '0', hourly: {} }, ...overrides,
  };
  bot.store.putLaunch(record);
  return record;
}

test('an on-chain launch with a banned name is recorded hidden, with no review ping', async () => {
  const { bot, tg } = await makeBot();
  await new Indexer({ bot }).onLaunched(launchedLog({ name: 'Tether', symbol: 'USDT' }));
  const l = bot.store.launch(TOKEN);
  assert.equal(l.status, 'rejected');
  assert.equal(l.hidden, true);
  assert.equal(l.source, 'chain');
  assert.equal(tg.sentTo(ADMIN).length, 0);
});

test('a clean on-chain launch is approved by the model but never auto-announced', async () => {
  const { bot, tg } = await makeBot({ moderator: new StubModerator('allow') });
  await new Indexer({ bot }).onLaunched(launchedLog());
  const l = bot.store.launch(TOKEN);
  assert.equal(l.status, 'approved');
  assert.equal(l.hidden, false);
  assert.equal(l.poolId, POOL);
  assert.equal(tg.sentTo(CHANNEL).length, 0);
});

test('without a moderator, on-chain launches wait for admin review', async () => {
  const { bot, tg } = await makeBot({ moderator: null });
  await new Indexer({ bot }).onLaunched(launchedLog());
  assert.equal(bot.store.launch(TOKEN).status, 'pending');
  assert.match(tg.lastText(ADMIN), /Review needed/);
});

test('the bot\'s own in-flight launch is recorded as the user\'s, whoever sees it first', async () => {
  const { bot } = await makeBot();
  // What launch.execute saves before broadcasting.
  bot.store.data.botWallets[CREATOR.toLowerCase()] = '42';
  bot.store.data.pendingLaunches['0x' + '1'.repeat(64)] = {
    uid: '42', name: 'Cap Doge', symbol: 'CAPD', description: 'the goodest boy', imageFileId: 'pic1',
    moderation: { verdict: 'allow', categories: [], reasons: [] }, fee: String(2n * 10n ** 18n), at: bot.now(),
  };
  await new Indexer({ bot }).onLaunched(launchedLog());
  const l = bot.store.launch(TOKEN);
  assert.equal(l.source, 'bot');
  assert.equal(l.tgUserId, '42');
  assert.equal(l.description, 'the goodest boy');
  assert.equal(l.status, 'approved');
  assert.deepEqual(bot.store.data.pendingLaunches, {}, 'consumed');
});

test('swaps update volume/price; big buys alert once per cooldown; sells never alert', async () => {
  const { bot, tg, time } = await makeBot();
  const l = seedLaunch(bot);
  const idx = new Indexer({ bot });

  idx.onSwap(swapLog(-30_000_000n, 5n * 10n ** 22n));
  assert.equal(l.stats.buys, 1);
  assert.equal(l.stats.volume6, '30000000');
  assert.equal(tg.sentTo(CHANNEL).length, 1);
  assert.match(tg.lastText(CHANNEL), /\$CAPD<\/b> buy: <b>30 USDC/);

  idx.onSwap(swapLog(-40_000_000n, 5n * 10n ** 22n));
  assert.equal(tg.sentTo(CHANNEL).length, 1, 'cooldown');
  time.t += 61_000;
  idx.onSwap(swapLog(-10_000_000n, 1n));
  assert.equal(tg.sentTo(CHANNEL).length, 1, 'below the 25 USDC threshold');
  idx.onSwap(swapLog(50_000_000n, -(10n ** 22n)));
  assert.equal(l.stats.sells, 1);
  assert.equal(tg.sentTo(CHANNEL).length, 1, 'sells do not alert');
  idx.onSwap(swapLog(-26_000_000n, 1n));
  assert.equal(tg.sentTo(CHANNEL).length, 2);
});

test('hidden or unreviewed tokens never produce public alerts', async () => {
  const { bot, tg } = await makeBot();
  seedLaunch(bot, { hidden: true });
  new Indexer({ bot }).onSwap(swapLog(-100_000_000n, 1n));
  assert.equal(tg.sentTo(CHANNEL).length, 0);
});

test('swaps on unrelated pools are ignored', async () => {
  const { bot } = await makeBot();
  const l = seedLaunch(bot);
  const other = swapLog(-100_000_000n, 1n);
  other.topics[1] = '0x' + 'cd'.repeat(32);
  new Indexer({ bot }).onSwap(other);
  assert.equal(l.stats.buys, 0);
});

test('tick: starts at head, then scans bounded ranges', async () => {
  const { bot, chain } = await makeBot();
  seedLaunch(bot);
  const queries = [];
  let head = 1000;
  chain.blockNumber = async () => head;
  chain.getLogs = async (f) => { queries.push(f); return []; };
  const idx = new Indexer({ bot });
  await idx.tick();
  assert.equal(bot.store.data.indexer.lastBlock, 1000);
  assert.equal(queries.length, 0);
  head = 10_000;
  await idx.tick();
  assert.deepEqual(queries.map((q) => [q.fromBlock, q.toBlock]), [[1001, 3000], [1001, 3000]]);
  assert.equal(bot.store.data.indexer.lastBlock, 3000);
});

// ---------------------------------------------------------------- R2-TGPAD-06

const SENDER = '0x' + '5e4d'.padStart(64, '0');
const DUST = '0x' + [-1n, 0n, 2n ** 96n * 1000n, 10n ** 20n, 0n, 20000n].map(word).join('');

// The real Chain and ethers provider against a node with Arc's public-RPC
// limits (> 20,000 results or > 10,000 blocks refused, with Arc's messages).
async function arcLikeNode() {
  const rpc = new MockRpc();
  rpc.maxResults = 20_000;
  rpc.maxBlocks = 10_000;
  const url = await rpc.listen();
  const cfg = makeCfg({ rpcUrl: url });
  const { bot, tg } = await makeBot({ cfg, moderator: new StubModerator('allow') });
  const provider = makeProvider(cfg);
  bot.chain = new Chain(cfg, provider);
  return { rpc, cfg, bot, tg, provider, close: async () => { provider.destroy(); await rpc.close(); } };
}

test('R2-TGPAD-06: a burst over the RPC\'s 20k-log cap halves the window and the indexer catches up (was: stalled forever)', async () => {
  const s = await arcLikeNode();
  try {
    const BOT_POOL = '0x' + 'b0'.repeat(32);
    seedLaunch(s.bot, { poolId: BOT_POOL });
    const L = 1_000_000;
    s.bot.store.data.indexer.lastBlock = L;
    s.rpc.head = L + 3000;
    // 21,000 one-wei swaps on a launchpad pool in blocks L+50..L+149 (an
    // attacker, or organic volume after downtime)...
    for (let i = 0; i < 21_000; i++) s.rpc.logs.push({ address: s.cfg.poolManager, topics: [SWAP_TOPIC, BOT_POOL, SENDER], data: DUST, blockNumber: L + 50 + (i % 100) });
    // ...plus unrelated pools' swaps, which the pool filter keeps out of every query...
    for (let i = 0; i < 5000; i++) s.rpc.logs.push({ address: s.cfg.poolManager, topics: [SWAP_TOPIC, '0x' + 'cd'.repeat(32), SENDER], data: DUST, blockNumber: L + 1 + (i % 2999) });
    // ...and a clean launch made directly on-chain after the burst.
    const CHAIN_TOKEN = getAddress('0x7700000000000000000000000000000000000002');
    const { data, topics } = iface.encodeEventLog('Launched', [1, '0x' + 'c0'.repeat(32), CHAIN_TOKEN, CHAIN_TOKEN, CHAIN_TOKEN, 'Fresh Doge', 'FRSH', '']);
    s.rpc.logs.push({ address: s.cfg.factory, topics, data, blockNumber: L + 2500 });

    const idx = new Indexer({ bot: s.bot });
    let failures = 0;
    const windows = [];
    const getLogs = s.bot.chain.getLogs.bind(s.bot.chain);
    s.bot.chain.getLogs = (f) => {
      if (f.topics[0] === SWAP_TOPIC) windows.push(f.toBlock - f.fromBlock + 1);
      return getLogs(f);
    };
    for (let i = 0; i < 40 && s.bot.store.data.indexer.lastBlock < s.rpc.head; i++) {
      try { await idx.tick(); } catch { failures++; }
    }
    assert.equal(failures, 0, 'the loop never sees an error');
    assert.equal(s.bot.store.data.indexer.lastBlock, s.rpc.head, 'caught up');
    assert.ok(Math.min(...windows) < 2000, `the window shrank: ${windows.join(',')}`);
    assert.equal(idx.range, 2000, 'and grew back');
    assert.match(idx.lastRangeError, /query exceeds max results 20000/);
    assert.ok(s.bot.store.launch(CHAIN_TOKEN), 'the on-chain launch after the burst is recorded');
    const { buys, sells } = s.bot.store.launch(TOKEN).stats;
    assert.equal(buys + sells, 21_000, 'every swap in the burst was indexed once');
  } finally { await s.close(); }
});

test('R2-TGPAD-06: the node\'s own error text is kept, not ethers\' "could not coalesce error"', async () => {
  const s = await arcLikeNode();
  try {
    seedLaunch(s.bot);
    s.bot.store.data.indexer.lastBlock = 1000;
    s.rpc.head = 1100;
    s.rpc.fault('eth_getLogs', 'error', { error: { code: -32000, message: 'backend overloaded, try later' } });
    const err = await new Indexer({ bot: s.bot }).tick().catch((e) => e);
    assert.equal(err.shortMessage, 'could not coalesce error');
    assert.equal(rpcMessage(err), 'backend overloaded, try later');
    assert.equal(isRangeError(err), false, 'not a size problem: retried as is');
    assert.equal(s.bot.store.data.indexer.lastBlock, 1000);
  } finally { await s.close(); }
});

test('R2-TGPAD-06: Swap logs are only fetched for the launchpad\'s own pools, 100 pool ids per query', async () => {
  const { bot, chain } = await makeBot();
  for (let i = 1; i <= 150; i++) seedLaunch(bot, { key: `k${i}`, token: getAddress('0x77' + i.toString(16).padStart(38, '0')), poolId: '0x' + i.toString(16).padStart(64, '0') });
  const queries = [];
  bot.store.data.indexer.lastBlock = 1000;
  chain.blockNumber = async () => 1010;
  chain.getLogs = async (f) => { queries.push(f); return []; };
  await new Indexer({ bot }).tick();
  const swaps = queries.filter((q) => q.topics[0] === SWAP_TOPIC);
  assert.deepEqual(swaps.map((q) => q.topics[1].length), [100, 50]);
  assert.ok(swaps[0].topics[1].includes('0x' + '1'.padStart(64, '0')));
});

test('R2-TGPAD-06: a big batch of logs yields to the event loop instead of blocking it', async () => {
  const { bot, chain } = await makeBot();
  seedLaunch(bot);
  bot.store.data.indexer.lastBlock = 1000;
  chain.blockNumber = async () => 1010;
  const logs = Array.from({ length: 5000 }, () => ({ ...swapLog(-1n, 1n), blockNumber: 1005 }));
  chain.getLogs = async (f) => (f.topics[0] === SWAP_TOPIC ? logs : []);
  const order = [];
  const done = new Indexer({ bot }).tick().then(() => order.push('tick'));
  setImmediate(() => order.push('other work'));
  await done;
  assert.deepEqual(order, ['other work', 'tick']);
});

test('R2-TGPAD-06: on-chain launch screening never holds up the tick', async () => {
  const { bot, chain } = await makeBot();
  const slow = gate();
  bot.moderator = { review: async () => { await slow.promise; return { verdict: 'allow', categories: [], reason: '' }; } };
  bot.store.data.indexer.lastBlock = 1000;
  chain.blockNumber = async () => 1010;
  chain.getLogs = async (f) => (f.topics[0] === LAUNCHED_TOPIC ? [launchedLog()] : []);
  await new Indexer({ bot }).tick();
  assert.equal(bot.store.data.indexer.lastBlock, 1010, 'the chunk is done while the model is still thinking');
  assert.equal(bot.store.launch(TOKEN).status, 'pending');
  slow.open();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(bot.store.launch(TOKEN).status, 'approved');
});

// ---------------------------------------------------------------- R2-TGPAD-14

test('R2-TGPAD-14: after downtime, backlog buys are booked when they happened and never alerted as fresh', async () => {
  const { bot, tg, chain, time } = await makeBot();
  const l = seedLaunch(bot);
  const idx = new Indexer({ bot });
  bot.store.data.indexer.lastBlock = 1000;
  chain.blockNumber = async () => 1000 + 144_000; // 20 h of downtime at 0.5 s blocks
  chain.getLogs = async (f) => (f.topics[0] === SWAP_TOPIC && f.fromBlock === 1001 ? [{ ...swapLog(-500_000_000n, 5n * 10n ** 25n), blockNumber: 1001 }] : []);
  await idx.tick();
  assert.equal(tg.sentTo(CHANNEL).length, 0, 'a 20-hour-old buy is not posted');
  const hourNow = Math.floor(time.t / 3_600_000);
  assert.equal(l.stats.hourly[hourNow], undefined, 'not booked into the current hour');
  assert.equal(l.stats.hourly[Math.floor((time.t - 143_999 * 500) / 3_600_000)], '500000000');

  // A buy a few blocks old is still news.
  idx.onSwap({ ...swapLog(-30_000_000n, 1n), blockNumber: 1000 + 144_000 - 5 }, undefined, 1000 + 144_000);
  assert.equal(tg.sentTo(CHANNEL).length, 1);
});

// ---------------------------------------------------------------- R2-TGPAD-18 (alerts)

test('R2-TGPAD-18: a buy alert waiting for its channel slot isn\'t posted once the token is hidden; posted alerts are remembered', async () => {
  const { bot, tg } = await makeBot();
  const l = seedLaunch(bot);
  const idx = new Indexer({ bot });
  idx.onSwap(swapLog(-100_000_000n, 1n));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(l.alertMessageIds.length, 1, 'alert ids are kept so /hide can remove them');

  const slot = gate();
  const direct = bot.sender;
  bot.sender = { send: async (chat, method, payload, opts) => { if (String(chat) === CHANNEL) await slot.promise; return direct.send(chat, method, payload, opts); } };
  bot.lastAlertAt = 0;
  idx.lastAlert.clear();
  idx.onSwap(swapLog(-100_000_000n, 1n)); // queued behind the channel's gap
  await acceptTerms(bot, ADMIN);
  await send(bot, msg(ADMIN, `/hide ${l.token} scam`));
  slot.open();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(tg.sentTo(CHANNEL).length, 1, 'only the alert sent before /hide');
});
