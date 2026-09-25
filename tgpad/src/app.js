// The long-running loops around the Bot: Telegram polling, the chain indexer
// and maintenance, plus graceful shutdown. index.js wires in the real pieces.
import { esc } from './format.js';
import { notifyAdmins } from './flows/publish.js';
import { rpcMessage } from './indexer.js';
import { sleep as realSleep } from './util.js';

// A rejection nobody handled must not take the bot down (plain Node exits on
// one): every user's in-flight job, pending confirmation and scheduled key
// deletion would go with it. It's logged instead. An uncaught exception is a
// real bug, so the bot shuts down gracefully and pm2 restarts it.
export function installProcessHandlers({ log = console, onFatal } = {}) {
  const onRejection = (err) => log.error('unhandled rejection (the bot keeps running):', err);
  const onException = (err) => {
    log.error('uncaught exception, shutting down:', err);
    onFatal?.(err);
  };
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  return () => {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
  };
}

export class App {
  constructor({
    cfg, store, tg, bot, indexer, log = console, sleep = realSleep, exit = (code) => process.exit(code), now = () => Date.now(),
    drainTimeoutMs = 140_000, maxConflicts = 5,
  }) {
    Object.assign(this, { cfg, store, tg, bot, indexer, log, sleep, exit, now, drainTimeoutMs, maxConflicts });
    this.running = false;
    this.stopping = null;
    this.pollAbort = null;
    this.lagAlertAt = null;
    this.lastIndexError = null;
  }

  start() {
    this.running = true;
    this.bot.recoverJobs();
    return Promise.all([this.pollUpdates(), this.indexLoop(), this.maintenanceLoop()]);
  }

  async pollUpdates() {
    let offset = this.store.data.tgOffset ?? 0;
    let conflicts = 0;
    while (this.running) {
      this.pollAbort = new AbortController();
      try {
        const updates = await this.tg.getUpdates(offset, 25, { signal: this.pollAbort.signal });
        conflicts = 0;
        for (const u of updates) {
          // Shutting down: nothing new starts. Updates not dispatched are
          // delivered again after the restart (their offset isn't confirmed).
          if (!this.running) break;
          offset = u.update_id + 1;
          // Not awaited: one user's slow action must not stall everyone else.
          this.bot.dispatch(u).catch((err) => this.log.error('dispatch failed:', err));
        }
        if (offset !== this.store.data.tgOffset) {
          this.store.data.tgOffset = offset;
          this.store.touch();
        }
      } catch (err) {
        if (!this.running) break;
        if (err.code === 409) {
          conflicts++;
          this.log.error('Another process is polling this bot token. Only one instance may run.');
          if (conflicts >= this.maxConflicts) {
            // Keep no second copy of the indexer or its channel alerts running.
            this.log.error('Still conflicting: stopping this instance.');
            this.shutdown('409 conflict', 1);
            break;
          }
        } else {
          this.log.error('getUpdates failed:', err.message);
        }
        await this.sleep(3000);
      }
    }
  }

  async indexLoop() {
    let backoff = this.cfg.pollIntervalMs;
    let failures = 0;
    while (this.running) {
      try {
        await this.indexer.tick();
        backoff = this.cfg.pollIntervalMs;
        failures = 0;
      } catch (err) {
        failures++;
        // The node's own message ("query exceeds max results..."), not
        // ethers' "could not coalesce error".
        this.lastIndexError = rpcMessage(err);
        this.log.error('indexer tick failed:', this.lastIndexError);
        backoff = Math.min(backoff * 2, 60_000);
      }
      await this.checkIndexer(failures).catch((err) => this.log.error('indexer alert failed:', err));
      if (!this.running) break;
      await this.sleep(backoff);
    }
  }

  // Admins hear about an indexer that fell far behind or keeps failing (at
  // most once an hour), and when it has recovered.
  async checkIndexer(failures) {
    const behind = this.indexer.behind();
    const bad = behind > (this.cfg.alerts.indexerBehindBlocks ?? 3000) || failures >= 10;
    const now = this.now();
    if (bad && (this.lagAlertAt === null || now - this.lagAlertAt >= 3_600_000)) {
      this.lagAlertAt = now;
      const error = this.lastIndexError ?? this.indexer.lastRangeError;
      await notifyAdmins(this.bot, [
        `⚠️ The indexer is ${behind} blocks behind the chain${failures ? ` and its last ${failures} ticks failed` : ''}.`,
        'Buy alerts, trending and on-chain launches are delayed until it catches up.',
        ...(error ? [`Last RPC error: ${esc(error)}`] : []),
      ].join('\n'));
    } else if (!bad && this.lagAlertAt !== null) {
      this.lagAlertAt = null;
      await notifyAdmins(this.bot, '✅ The indexer has caught up.');
    }
  }

  async maintenanceLoop() {
    while (this.running) {
      await this.maintain();
      if (!this.running) break;
      await this.sleep(this.cfg.maintenanceIntervalMs ?? 15_000);
    }
  }

  async maintain() {
    try {
      this.bot.sweep();
      await this.bot.processDeletions();
      await this.bot.reconcileTxs();
    } catch (err) {
      this.log.error('maintenance failed:', err);
    }
  }

  // Stops taking new work (no more dispatching, the long poll is aborted, new
  // Confirm taps are refused), waits for in-flight jobs including ones that
  // start meanwhile, saves state and exits. Transactions still confirming
  // after drainTimeoutMs are saved by hash and checked after the restart.
  shutdown(reason, code = 0) {
    if (this.stopping) return this.stopping;
    this.running = false;
    this.bot.stopping = true;
    this.pollAbort?.abort();
    this.log.log(`${reason}: finishing in-flight transactions and saving state...`);
    this.stopping = (async () => {
      const drained = await this.bot.drain({ timeoutMs: this.drainTimeoutMs });
      if (!drained) this.log.error('Some transactions were still confirming. They are saved and will be checked after the restart.');
      await this.store.flush().catch((err) => this.log.error('final save failed:', err));
      await this.store.unlock().catch(() => {});
      this.exit(code);
    })();
    return this.stopping;
  }
}
