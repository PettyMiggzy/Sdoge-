// The process around the bot (src/app.js): crash safety (R2-TGPAD-03),
// indexer visibility (R2-TGPAD-06), graceful shutdown (R2-TGPAD-12) and a
// second instance on the same token (R2-TGPAD-20).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { App, installProcessHandlers } from '../src/app.js';
import { ADMIN, E18, acceptTerms, button, gate, makeBot, msg, send, settle, tap } from './helpers.js';

const U = '12345';
const DEST = '0x1234567890123456789012345678901234567890';
const quiet = () => {
  const lines = [];
  return { lines, error: (...a) => lines.push(a.map(String).join(' ')), log: () => {}, warn: () => {} };
};

// Telegram's long poll: waits until updates are pushed, or the poll is aborted.
class LongPoll {
  constructor() { this.polls = []; }
  getUpdates(offset, timeout, { signal } = {}) {
    return new Promise((resolve, reject) => {
      this.polls.push({ offset, resolve, reject, signal });
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
    });
  }
  push(updates) { this.polls.at(-1).resolve(updates); }
}

async function makeApp(extra = {}) {
  const env = await makeBot();
  const exits = [];
  const log = quiet();
  const indexer = { tick: async () => {}, behind: () => 0, lastRangeError: null };
  const app = new App({
    cfg: env.cfg, store: env.store, tg: extra.tg ?? new LongPoll(), bot: env.bot, indexer: extra.indexer ?? indexer, log,
    sleep: () => new Promise((r) => setTimeout(r, 2)), exit: (code) => exits.push(code), drainTimeoutMs: 5000, ...extra.opts,
  });
  return { ...env, app, exits, log };
}

// ---------------------------------------------------------------- R2-TGPAD-03

test('R2-TGPAD-03: an unhandled rejection is logged and the process keeps running (plain Node would exit)', () => {
  const src = new URL('../src/app.js', import.meta.url).href;
  const run = (install) => spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { installProcessHandlers } from ${JSON.stringify(src)};
    ${install ? 'installProcessHandlers({ log: { error: (m) => console.log("LOGGED " + m) } });' : ''}
    Promise.reject(new Error('server response 503 Service Unavailable'));
    setTimeout(() => console.log('ALIVE'), 50);`], { encoding: 'utf8' });
  const without = run(false);
  assert.equal(without.status, 1, 'plain Node dies on it');
  const withHandlers = run(true);
  assert.equal(withHandlers.status, 0);
  assert.match(withHandlers.stdout, /LOGGED unhandled rejection \(the bot keeps running\)/);
  assert.match(withHandlers.stdout, /ALIVE/);

  const fatal = [];
  const uninstall = installProcessHandlers({ log: quiet(), onFatal: (e) => fatal.push(e) });
  try {
    const onException = process.listeners('uncaughtException').at(-1);
    onException(new Error('a real bug'));
    assert.equal(fatal.length, 1, 'an uncaught exception shuts the bot down gracefully');
  } finally {
    uninstall();
  }
});

// ---------------------------------------------------------------- R2-TGPAD-06

test('R2-TGPAD-06: a failing tick logs the node\'s own error text', async () => {
  const rpcError = Object.assign(new Error('could not coalesce error'), {
    code: 'UNKNOWN_ERROR', shortMessage: 'could not coalesce error',
    error: { code: -32602, message: 'request exceeded max allowed range: query exceeds max results 20000' },
  });
  const indexer = { tick: async () => { throw rpcError; }, behind: () => 0 };
  const { app, log } = await makeApp({ indexer });
  app.running = true;
  app.sleep = async () => { app.running = false; };
  await app.indexLoop();
  assert.match(log.lines[0], /indexer tick failed: request exceeded max allowed range: query exceeds max results 20000/);
});

test('R2-TGPAD-06: admins are told when the indexer falls far behind (at most hourly), and when it recovers', async () => {
  let behind = 5000;
  const indexer = { tick: async () => {}, behind: () => behind, lastRangeError: 'query exceeds max results 20000' };
  let now = 0;
  const { app, tg } = await makeApp({ indexer, opts: { now: () => now } });
  await app.checkIndexer(0);
  assert.match(tg.lastText(ADMIN), /indexer is 5000 blocks behind/);
  assert.match(tg.lastText(ADMIN), /query exceeds max results 20000/);
  const sent = tg.sentTo(ADMIN).length;
  now += 60_000;
  await app.checkIndexer(0);
  assert.equal(tg.sentTo(ADMIN).length, sent, 'not again within the hour');
  behind = 3;
  await app.checkIndexer(0);
  assert.match(tg.lastText(ADMIN), /caught up/);
  await app.checkIndexer(10);
  assert.match(tg.lastText(ADMIN), /last 10 ticks failed/, 'repeated failures alert too');
});

// ---------------------------------------------------------------- R2-TGPAD-12

test('R2-TGPAD-12: shutdown aborts the long poll, never dispatches what it returns, waits for jobs, saves and exits', async () => {
  const poll = new LongPoll();
  const { app, bot, chain, tg, store, exits } = await makeApp({ tg: poll });
  await acceptTerms(bot, U);
  chain.setBalance(bot.wallets.address(U), 100n * E18);
  await send(bot, msg(U, `/withdraw 5 ${DEST}`));
  const first = button(tg, U);
  await send(bot, msg(U, `/withdraw 6 ${DEST}`));
  const second = button(tg, U);
  const mined = gate();
  const realWithdraw = chain.withdraw.bind(chain);
  chain.withdraw = async (...a) => { await mined.promise; return realWithdraw(...a); };

  const loops = app.start();
  await settle();
  poll.push([tap(U, first)]); // a job in flight when the stop signal comes
  await settle();
  const offset = store.data.tgOffset;
  // The next poll returns a Confirm as it is being aborted: it must not run.
  poll.getUpdates = (o, t, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve([tap(U, second)])));
  await settle();
  const stopping = app.shutdown('SIGTERM');
  await settle();
  assert.deepEqual(exits, [], 'still waiting for the withdraw in flight');
  mined.open();
  await stopping;
  await loops;
  assert.deepEqual(exits, [0]);
  assert.equal(chain.calls.filter((c) => c.fn === 'withdraw').length, 1, 'only the job already running');
  assert.equal(store.data.tgOffset, offset, 'the undispatched update will be delivered again after the restart');
  assert.match(tg.lastEditText(), /Sent 5 USDC/);
  assert.deepEqual(store.data.txs, {});
});

test('R2-TGPAD-12: the pm2 kill timeout outlasts the longest receipt wait', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const eco = require('../ecosystem.config.cjs');
  const cfg = require('../config.json');
  assert.ok(eco.apps[0].kill_timeout >= cfg.txTimeoutSec * 1000 + 10_000, `kill_timeout ${eco.apps[0].kill_timeout}`);
  const { app } = await makeApp();
  assert.ok(app.drainTimeoutMs < eco.apps[0].kill_timeout);
});

// ---------------------------------------------------------------- R2-TGPAD-20

test('R2-TGPAD-20: an instance that keeps getting 409 (another poller) stops itself', async () => {
  const conflict = { getUpdates: async () => { throw Object.assign(new Error('Conflict'), { code: 409 }); } };
  const { app, exits, log } = await makeApp({ tg: conflict, opts: { maxConflicts: 3 } });
  await app.start();
  await app.stopping;
  assert.deepEqual(exits, [1]);
  assert.ok(log.lines.some((l) => /Still conflicting: stopping this instance/.test(l)));
});
