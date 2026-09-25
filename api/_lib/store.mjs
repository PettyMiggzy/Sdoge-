// Studio AI's records, in this site's public Vercel Blob store:
//   ai/payments/<payer>/<tx>.<credits>.json   a verified payment and what it's worth
//   ai/credits/<tx>/<n>.json                  credit n of that payment, spent (one file per credit)
//   ai/images/<sha256>.webp                   the images (public, ready to mint)
//   ai/history/<payer>/<ms>-<sha256>.json     who made which image
//   ai/daily/<yyyy-mm-dd>/<ms>-<rand>.json    one per image, for the daily limit
// Spending a credit creates its file without overwriting, which the store refuses if it already
// exists: two requests can never spend the same credit.
import { del, list, put } from '@vercel/blob';
import { createHash, randomBytes } from 'node:crypto';
import { blobToken } from './config.mjs';

const exists = (err) => /already exists/i.test(String(err?.message ?? err));

// The real store.
function blobStore() {
  const token = blobToken();
  return {
    async put(pathname, body, { contentType, overwrite = false, cacheSeconds } = {}) {
      const r = await put(pathname, body, {
        access: 'public',
        token,
        contentType,
        addRandomSuffix: false,
        allowOverwrite: overwrite,
        ...(cacheSeconds ? { cacheControlMaxAge: cacheSeconds } : {}),
      });
      return { url: r.url, pathname: r.pathname };
    },
    async list(prefix, { limit = 1000 } = {}) {
      const out = [];
      let cursor;
      do {
        const page = await list({ prefix, token, cursor, limit: Math.min(1000, limit - out.length) });
        out.push(...page.blobs.map((b) => ({ url: b.url, pathname: b.pathname, uploadedAt: new Date(b.uploadedAt).getTime() })));
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor && out.length < limit);
      return out;
    },
    async remove(urls) {
      if (urls.length) await del(urls, { token });
    },
  };
}

// An in-memory store with the same behavior, for tests (AI_STORE=memory).
export function memoryStore() {
  const files = new Map();
  let clock = 0;
  return {
    files,
    async put(pathname, body, { contentType, overwrite = false } = {}) {
      if (!overwrite && files.has(pathname)) throw new Error('Vercel Blob: This blob already exists');
      const url = `https://store.test/${pathname}`;
      files.set(pathname, { url, pathname, body, contentType, uploadedAt: ++clock });
      return { url, pathname };
    },
    async list(prefix, { limit = 1000 } = {}) {
      return [...files.values()].filter((f) => f.pathname.startsWith(prefix)).slice(0, limit);
    },
    async remove(urls) {
      for (const [k, f] of files) if (urls.includes(f.url)) files.delete(k);
    },
  };
}

let shared = null;
export function getStore() {
  if (!shared) shared = process.env.AI_STORE === 'memory' ? memoryStore() : blobStore();
  return shared;
}
export function setStore(store) {
  shared = store;
}

// ---------- payments and credits ----------

const PAYMENT_RE = /^ai\/payments\/(0x[0-9a-f]{40})\/(0x[0-9a-f]{64})\.(\d+)\.json$/;

export async function recordPayment(store, p) {
  const body = JSON.stringify({ hash: p.hash, payer: p.payer, credits: p.credits, valueWei: p.valueWei, block: p.block });
  await store.put(`ai/payments/${p.payer}/${p.hash}.${p.credits}.json`, body, { contentType: 'application/json', overwrite: true });
}

/** The wallet's recorded payments, oldest first: [{ hash, credits, at }]. */
export async function listPayments(store, payer) {
  const files = await store.list(`ai/payments/${payer.toLowerCase()}/`);
  return files
    .map((f) => {
      const m = PAYMENT_RE.exec(f.pathname);
      return m ? { hash: m[2], credits: Number(m[3]), at: f.uploadedAt } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at);
}

export async function spentCredits(store, hash) {
  return (await store.list(`ai/credits/${hash}/`)).length;
}

/** Credits left per payment: [{ hash, credits, remaining }]. */
export async function balances(store, payer) {
  const out = [];
  for (const p of await listPayments(store, payer)) {
    out.push({ hash: p.hash, credits: p.credits, remaining: Math.max(0, p.credits - (await spentCredits(store, p.hash))) });
  }
  return out;
}

const slotPath = (hash, n) => `ai/credits/${hash}/${String(n).padStart(5, '0')}.json`;

/**
 * Spends `n` credits of one payment: the claimed files, or null if it hasn't `n` left. Each
 * credit is its own file, created without overwriting, so a race can't double-spend one.
 */
export async function claimCredits(store, hash, total, n, note) {
  const taken = new Set((await store.list(`ai/credits/${hash}/`)).map((f) => f.pathname));
  const claimed = [];
  for (let i = 0; i < total && claimed.length < n; i++) {
    const path = slotPath(hash, i);
    if (taken.has(path)) continue;
    try {
      claimed.push(await store.put(path, JSON.stringify({ ...note, at: Date.now() }), { contentType: 'application/json' }));
    } catch (err) {
      if (exists(err)) continue; // another request got it first
      await releaseCredits(store, claimed);
      throw err;
    }
  }
  if (claimed.length < n) {
    await releaseCredits(store, claimed);
    return null;
  }
  return claimed;
}

/** Gives claimed credits back (the image failed). */
export async function releaseCredits(store, claimed) {
  if (claimed?.length) await store.remove(claimed.map((c) => c.url));
}

// ---------- images, history and the daily count ----------

export const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export async function imagesToday(store, limit) {
  return (await store.list(`ai/daily/${today()}/`, { limit })).length;
}

export async function saveImage(store, payer, bytes, note) {
  const sha = createHash('sha256').update(bytes).digest('hex');
  const image = await store.put(`ai/images/${sha}.webp`, bytes, { contentType: 'image/webp', overwrite: true, cacheSeconds: 31536000 });
  const now = Date.now();
  await Promise.allSettled([
    store.put(`ai/history/${payer}/${now}-${sha}.json`, JSON.stringify({ ...note, image: image.url }), { contentType: 'application/json', overwrite: true }),
    store.put(`ai/daily/${today(now)}/${now}-${randomBytes(4).toString('hex')}.json`, '{}', { contentType: 'application/json', overwrite: true }),
  ]);
  return image.url;
}

/** The wallet's images, newest first: [{ url, at }]. */
export async function history(store, payer, limit = 24) {
  const files = await store.list(`ai/history/${payer.toLowerCase()}/`);
  return files
    .map((f) => {
      const m = /\/(\d+)-([0-9a-f]{64})\.json$/.exec(f.pathname);
      return m ? { url: f.url.replace(/ai\/history\/.+$/, `ai/images/${m[2]}.webp`), at: Number(m[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}
