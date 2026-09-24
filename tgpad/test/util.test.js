import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyedSerializer, SlidingWindow, parseAmount, parsePercentBps } from '../src/util.js';
import { esc, fmtPrice, fmtUnits } from '../src/format.js';
import { redeemValue6, recordSwap, usdPerToken, volume24h } from '../src/market.js';
import { Sender } from '../src/telegram.js';
import { friendlyError } from '../src/errors.js';

test('parseAmount is strict', () => {
  assert.equal(parseAmount('10', 6), 10_000_000n);
  assert.equal(parseAmount('2.5', 6), 2_500_000n);
  assert.equal(parseAmount('1,000.5', 6), 1_000_500_000n);
  assert.equal(parseAmount('0.1234567', 6), null, 'too many decimals for USDC');
  assert.equal(parseAmount('-1', 6), null);
  assert.equal(parseAmount('1e5', 6), null);
  assert.equal(parseAmount('0', 6), null);
  assert.equal(parseAmount('', 6), null);
  assert.equal(parseAmount('abc', 18), null);
});

test('parsePercentBps', () => {
  assert.equal(parsePercentBps('50%'), 5000);
  assert.equal(parsePercentBps('12.5%'), 1250);
  assert.equal(parsePercentBps('all'), 10000);
  assert.equal(parsePercentBps('MAX'), 10000);
  assert.equal(parsePercentBps('0%'), null);
  assert.equal(parsePercentBps('101%'), null);
  assert.equal(parsePercentBps('50'), null);
});

test('formatting', () => {
  assert.equal(fmtUnits(1234567890000000000000n, 18), '1,234.5678');
  assert.equal(fmtUnits(5_000_000n, 6), '5');
  assert.equal(fmtUnits(-1_500_000n, 6), '-1.5');
  assert.equal(esc('<b>"&"</b>'), '&lt;b&gt;&quot;&amp;&quot;&lt;/b&gt;');
  assert.equal(fmtPrice(0), 'n/a');
  assert.match(fmtPrice(0.0000082157), /^\$0\.0000082/);
});

test('price math matches the live SDOGE pool (slot0 read on Arc)', () => {
  // sqrtPriceX96 read from the real SDOGE/USDC pool via extsload; that pool
  // has the same USDC(6)/token(18) layout as launchpad pools.
  const p = usdPerToken(27641247771705842833748883489379503725n);
  assert.ok(Math.abs(p - 8.215686894661932e-6) < 1e-12, `got ${p}`);
});

test('24h volume uses hourly buckets and prunes old ones', () => {
  const l = {};
  const h = 3_600_000;
  recordSwap(l, { usdc6: 5_000_000n, isBuy: true, sqrtPriceX96: 2n ** 96n, at: 100 * h });
  recordSwap(l, { usdc6: 3_000_000n, isBuy: false, sqrtPriceX96: 2n ** 96n, at: 110 * h });
  assert.equal(volume24h(l, 110 * h), 8_000_000n);
  assert.equal(volume24h(l, 125 * h), 3_000_000n, 'the hour-100 bucket is older than 24h');
  recordSwap(l, { usdc6: 1n, isBuy: true, sqrtPriceX96: 2n ** 96n, at: 200 * h });
  assert.deepEqual(Object.keys(l.stats.hourly), ['200'], 'buckets older than 48h are pruned');
  assert.equal(l.stats.buys, 2);
  assert.equal(l.stats.sells, 1);
});

test('redeem value is pro-rata of the vault backing over the supply, rounded down', () => {
  const v = { backing6: 1000n, supply: 1000n * 10n ** 18n };
  assert.equal(redeemValue6(100n * 10n ** 18n, v), 100n);
  assert.equal(redeemValue6(10n ** 18n - 1n, v), 0n, 'rounds down like the contract');
  assert.equal(redeemValue6(1n, { backing6: 0n, supply: 0n }), 0n);
});

test('KeyedSerializer runs one key strictly in order, even after a failure', async () => {
  const s = new KeyedSerializer();
  const order = [];
  const slow = (tag, ms, fail) => () => new Promise((res, rej) => setTimeout(() => { order.push(tag); fail ? rej(new Error(tag)) : res(tag); }, ms));
  const a = s.run('k', slow('a', 30, true));
  const b = s.run('k', slow('b', 1));
  const c = s.run('other', slow('c', 1));
  await assert.rejects(a);
  await b;
  await c;
  assert.deepEqual(order, ['c', 'a', 'b']);
});

test('SlidingWindow limits per key', () => {
  let t = 0;
  const w = new SlidingWindow(2, 1000, () => t);
  assert.ok(w.hit('u'));
  assert.ok(w.hit('u'));
  assert.ok(!w.hit('u'));
  assert.ok(w.hit('v'));
  t = 1001;
  assert.ok(w.hit('u'));
});

test('Sender paces one chat but never blocks other chats behind it', async () => {
  let now = 0;
  const waits = [];
  const log = [];
  const tg = { call: async (method, p) => { log.push([p.chat_id, now]); return { message_id: 1 }; } };
  const sender = new Sender(tg, { privateGapMs: 1000, groupGapMs: 3000, globalGapMs: 0, now: () => now, wait: async (ms) => { waits.push(ms); now += ms; } });
  await sender.send('1', 'sendMessage', { text: 'a' });
  await sender.send('1', 'sendMessage', { text: 'b' });
  await sender.send('-100', 'sendMessage', { text: 'c' });
  await sender.send('-100', 'sendMessage', { text: 'd' });
  assert.deepEqual(log.map((x) => x[0]), ['1', '1', '-100', '-100']);
  assert.ok(waits.includes(1000), 'second private message waited ~1s');
  assert.ok(waits.includes(3000), 'second channel message waited ~3s');
});

test('friendlyError never leaks raw RPC text', () => {
  assert.match(friendlyError(new Error('insufficient funds for gas * price + value')), /Not enough USDC/);
  assert.match(friendlyError({ shortMessage: 'execution reverted: TooLittleReceived()' }), /slippage/);
  assert.match(friendlyError(new Error('Blocked address')), /blocked/);
  const generic = friendlyError(new Error('rpc https://secret-key@node/ exploded'));
  assert.doesNotMatch(generic, /secret-key/);
});
