import fs from 'node:fs/promises';
import path from 'node:path';

// Everything the bot remembers that isn't derivable. No secrets live here:
// wallet keys are re-derived from WALLET_MASTER_SECRET on demand.
const empty = () => ({
  version: 1,
  users: {},
  launches: {},
  reports: [],
  indexer: { lastBlock: null },
});

export class Store {
  #file;
  #saving = Promise.resolve();
  #dirty = false;
  #timer = null;

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

  user(tgId) {
    const id = String(tgId);
    this.data.users[id] ??= { createdAt: Date.now(), tosAt: null, banned: false, slippageBps: null, tokens: [] };
    return this.data.users[id];
  }

  launch(token) {
    return this.data.launches[String(token).toLowerCase()] ?? null;
  }

  putLaunch(record) {
    this.data.launches[record.token.toLowerCase()] = record;
    this.touch();
  }

  launchByKey(key) {
    return Object.values(this.data.launches).find((l) => l.key === key) ?? null;
  }

  launchByPoolId(poolId) {
    const id = String(poolId).toLowerCase();
    return Object.values(this.data.launches).find((l) => l.poolId.toLowerCase() === id) ?? null;
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
    const tmp = `${this.#file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 1) + '\n', { mode: 0o600 });
    try { await fs.copyFile(this.#file, `${this.#file}.bak`); } catch {}
    await fs.rename(tmp, this.#file);
  }
}
