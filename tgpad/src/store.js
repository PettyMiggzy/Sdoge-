import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// Everything the bot remembers that isn't derivable. No secrets live here:
// wallet keys are re-derived from WALLET_MASTER_SECRET on demand.
const empty = () => ({
  version: 1,
  users: {},
  launches: {},
  reports: [],
  indexer: { lastBlock: null },
  // Confirmed actions still running: { uid, kind, chatId, messageId, sent }.
  // `sent` is saved together with the transaction record, before broadcast,
  // so after a crash the bot knows whether anything could have gone out.
  jobs: {},
  // Bot transactions signed but not yet known to have succeeded or failed,
  // by hash. Written before the broadcast, so a restart can still tell the
  // user what happened.
  txs: {},
  // Launch transactions in flight, by hash, with everything the bot needs to
  // record the launch as the user's (the indexer may see it first).
  pendingLaunches: {},
  // Lowercase wallet address -> Telegram user id, written before a launch
  // from that wallet is sent, so its Launched event is always attributed.
  botWallets: {},
  // Exported-key messages to delete: { chatId, messageId, at }.
  deletions: [],
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export class Store {
  #file;
  #saving = Promise.resolve();
  #dirty = false;
  #timer = null;
  #lockFile = null;
  #byPool = null;

  constructor(file, data) {
    this.#file = file;
    this.data = data;
  }

  static async open(file) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      return new Store(file, empty());
    }
    try {
      return new Store(file, { ...empty(), ...JSON.parse(raw) });
    } catch (e) {
      // A reset here would silently unhide banned users and rejected launches.
      throw new Error(`${file} is corrupt (${e.message}). Restore it from ${file}.bak before starting.`);
    }
  }

  // Only one process may own the store: a second one (e.g. `npm start` while
  // pm2 runs) would save its stale copy over the live one, undoing bans,
  // hides and reviews. The lock holds the owner's pid; a lock left by a
  // process that no longer exists is taken over.
  async lock() {
    const lockFile = `${this.#file}.lock`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fh = await fs.open(lockFile, 'wx', 0o600);
        try { await fh.writeFile(`${process.pid}\n`); } finally { await fh.close(); }
        this.#lockFile = lockFile;
        return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const pid = Number((await fs.readFile(lockFile, 'utf8').catch(() => '')).trim());
        if (pid && pid !== process.pid && isAlive(pid)) {
          throw new Error(`Another tgpad process (pid ${pid}) is using ${this.#file}. Only one instance may run: stop it first. If none is running, delete ${lockFile}.`);
        }
        await fs.unlink(lockFile).catch(() => {});
      }
    }
    throw new Error(`Could not take the lock ${lockFile}.`);
  }

  async unlock() {
    if (!this.#lockFile) return;
    const lockFile = this.#lockFile;
    this.#lockFile = null;
    const pid = Number((await fs.readFile(lockFile, 'utf8').catch(() => '')).trim());
    if (pid === process.pid) await fs.unlink(lockFile).catch(() => {});
  }

  user(tgId) {
    const id = String(tgId);
    this.data.users[id] ??= { createdAt: Date.now(), tosAt: null, banned: false, slippageBps: null, tokens: [] };
    return this.data.users[id];
  }

  // Telegram usernames get released and reused. Whoever writes to the bot
  // with a username now holds it; any older record claiming it is cleared, so
  // /ban @name can't hit an account that gave the name up long ago.
  claimUsername(tgId, username, now = Date.now()) {
    const id = String(tgId);
    const u = this.user(id);
    const name = username ? String(username) : null;
    let changed = false;
    if ((u.username ?? null) !== name) {
      u.username = name;
      changed = true;
      if (name) {
        const lower = name.toLowerCase();
        for (const [otherId, other] of Object.entries(this.data.users)) {
          if (otherId !== id && other.username?.toLowerCase() === lower) other.username = null;
        }
      }
    }
    if (!u.lastSeenAt || now - u.lastSeenAt > 600_000) {
      u.lastSeenAt = now;
      changed = true;
    }
    if (changed) this.touch();
  }

  launch(token) {
    return this.data.launches[String(token).toLowerCase()] ?? null;
  }

  putLaunch(record) {
    const key = record.token.toLowerCase();
    this.data.launches[key] = record;
    if (this.#byPool && record.poolId) this.#byPool.set(record.poolId.toLowerCase(), key);
    this.touch();
  }

  launchByKey(key) {
    return Object.values(this.data.launches).find((l) => l.key === key) ?? null;
  }

  // Indexed: the indexer resolves every Swap log through this.
  launchByPoolId(poolId) {
    const id = String(poolId).toLowerCase();
    const build = () => {
      this.#byPool = new Map();
      for (const [k, l] of Object.entries(this.data.launches)) if (l.poolId) this.#byPool.set(String(l.poolId).toLowerCase(), k);
    };
    if (!this.#byPool) build();
    let key = this.#byPool.get(id);
    if (!key && this.#byPool.size !== Object.keys(this.data.launches).length) {
      build();
      key = this.#byPool.get(id);
    }
    return key ? this.data.launches[key] ?? null : null;
  }

  // Coalesces bursts of changes into one write.
  touch() {
    this.#dirty = true;
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.save().catch((e) => console.error('store save failed:', e.message));
    }, 250);
  }

  save() {
    this.#saving = this.#saving.then(() => this.#write(), () => this.#write());
    return this.#saving;
  }

  async flush() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#dirty) await this.save();
    else await this.#saving;
  }

  async #write() {
    this.#dirty = false;
    // A unique temp name: two writers can never interleave inside one file.
    const tmp = `${this.#file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 1) + '\n', { mode: 0o600 });
      try { await fs.copyFile(this.#file, `${this.#file}.bak`); } catch {}
      await fs.rename(tmp, this.#file);
    } catch (e) {
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
  }
}
