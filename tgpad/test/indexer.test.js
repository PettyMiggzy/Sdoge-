import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, getAddress, toBeHex, zeroPadValue } from 'ethers';
import { FACTORY_ABI, SWAP_TOPIC } from '../src/abi.js';
import { Indexer } from '../src/indexer.js';
import { ADMIN, CHANNEL, StubModerator, makeBot } from './helpers.js';

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

test('the bot\'s own in-flight launch is left for the bot to record', async () => {
  const { bot } = await makeBot();
  bot.inflight.add(CREATOR);
  await new Indexer({ bot }).onLaunched(launchedLog());
  assert.equal(bot.store.launch(TOKEN), null);
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
