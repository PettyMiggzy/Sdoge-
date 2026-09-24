#!/usr/bin/env node
// SDOGE Telegram launchpad bot. Run under pm2: see README.md.
import path from 'node:path';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Chain, makeProvider } from './chain.js';
import { Wallets } from './wallets.js';
import { Sender, Telegram } from './telegram.js';
import { VeniceModerator, loadBlocklist } from './moderation.js';
import { Bot } from './bot.js';
import { Indexer } from './indexer.js';
import { sleep } from './util.js';

const cfg = loadConfig();
const store = await Store.open(path.join(cfg.dataDir, 'store.json'));
const provider = makeProvider(cfg);
const chain = new Chain(cfg, provider);
const tg = new Telegram(cfg.telegramToken);
const moderator = cfg.veniceKey && cfg.moderation.provider === 'venice'
  ? new VeniceModerator({ apiKey: cfg.veniceKey, model: cfg.moderation.model, timeoutMs: cfg.moderation.timeoutMs })
  : null;

const bot = new Bot({
  cfg,
  store,
  tg,
  sender: new Sender(tg),
  chain,
  wallets: new Wallets(cfg.walletSecret, provider),
  moderator,
  blocklist: loadBlocklist(),
});
await bot.init();
const indexer = new Indexer({ bot });

console.log([
  `@${bot.username} is up.`,
  `factory: ${cfg.factory || 'NOT SET (launching disabled)'}`,
  `router: ${cfg.router || 'NOT SET (trading disabled)'}`,
  `hook: ${cfg.hook || 'NOT SET (claims disabled)'}`,
  `moderation: ${moderator ? cfg.moderation.model : 'OFF, every image held for admin review'}`,
  `admins: ${cfg.admins.size || 'NONE (nobody can review or moderate!)'}`,
  `launch channel: ${cfg.launchesChannel || 'not set'}`,
].join('\n  '));

let running = true;

async function pollUpdates() {
  let offset = store.data.tgOffset ?? 0;
  while (running) {
    try {
      const updates = await tg.getUpdates(offset, 25);
      for (const u of updates) {
        offset = u.update_id + 1;
        // Not awaited: one user's slow action must not stall everyone else.
        bot.dispatch(u).catch((err) => console.error('dispatch failed:', err));
      }
      if (updates.length) {
        store.data.tgOffset = offset;
        store.touch();
      }
    } catch (err) {
      if (err.code === 409) console.error('Another process is polling this bot token. Only one instance may run.');
      else console.error('getUpdates failed:', err.message);
      await sleep(3000);
    }
  }
}

async function indexLoop() {
  let backoff = cfg.pollIntervalMs;
  while (running) {
    try {
      await indexer.tick();
      backoff = cfg.pollIntervalMs;
    } catch (err) {
      console.error('indexer tick failed:', err.shortMessage ?? err.message);
      backoff = Math.min(backoff * 2, 60_000);
    }
    await sleep(backoff);
  }
}

async function shutdown(signal) {
  if (!running) return;
  running = false;
  console.log(`${signal}: finishing in-flight transactions and saving state...`);
  await bot.drain();
  await store.flush();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await Promise.all([pollUpdates(), indexLoop()]);
