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
import { App, installProcessHandlers } from './app.js';

const cfg = loadConfig();
const store = await Store.open(path.join(cfg.dataDir, 'store.json'));
// Only one process may run on this data directory (and this bot token).
await store.lock();

const provider = makeProvider(cfg);
const chain = new Chain(cfg, provider, { txTimeoutMs: cfg.txTimeoutSec * 1000 });
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
const indexer = new Indexer({ bot });
const app = new App({ cfg, store, tg, bot, indexer });

installProcessHandlers({ onFatal: () => app.shutdown('uncaughtException', 1) });
process.on('SIGINT', () => app.shutdown('SIGINT'));
process.on('SIGTERM', () => app.shutdown('SIGTERM'));

try {
  await bot.init();
} catch (err) {
  await store.unlock();
  throw err;
}

console.log([
  `@${bot.username} is up.`,
  `factory: ${cfg.factory || 'NOT SET (launching disabled)'}`,
  `router: ${cfg.router || 'NOT SET (trading disabled)'}`,
  `hook: ${cfg.hook || 'NOT SET (claims disabled)'}`,
  `moderation: ${moderator ? cfg.moderation.model : 'OFF: every launch is held for admin review'}`,
  `admins: ${cfg.admins.size || 'NONE (nobody can review or moderate!)'}`,
  `launch channel: ${cfg.launchesChannel || 'not set'}`,
  `transactions awaiting confirmation: ${Object.keys(store.data.txs ?? {}).length}`,
].join('\n  '));

await app.start();
