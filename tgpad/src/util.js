import { randomBytes } from 'node:crypto';
import { parseUnits } from 'ethers';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const randomId = (bytes = 8) => randomBytes(bytes).toString('base64url');

// Runs fn() for a given key strictly one at a time (e.g. one tx per wallet, so
// two quick taps can't race each other for the same nonce).
export class KeyedSerializer {
  #tails = new Map();
  #depth = new Map();

  // Jobs queued or running for `key`.
  depth(key) {
    return this.#depth.get(key) ?? 0;
  }

  run(key, fn) {
    this.#depth.set(key, this.depth(key) + 1);
    const prev = this.#tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.#tails.set(key, tail);
    tail.then(() => {
      const d = this.depth(key) - 1;
      if (d > 0) this.#depth.set(key, d);
      else this.#depth.delete(key);
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return next;
  }
}

// In-memory sliding window: at most `limit` hits per key per `windowMs`.
export class SlidingWindow {
  #hits = new Map();

  constructor(limit, windowMs, now = () => Date.now()) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  hit(key) {
    const t = this.now();
    const recent = (this.#hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.limit) {
      this.#hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.#hits.set(key, recent);
    return true;
  }

  // Forget keys with no hit inside the window, so the map doesn't grow forever.
  prune() {
    const t = this.now();
    for (const [k, v] of this.#hits) if (!v.length || t - v[v.length - 1] >= this.windowMs) this.#hits.delete(k);
  }

  get size() {
    return this.#hits.size;
  }
}

// At most `max` calls of run() in flight at once; the rest wait in order.
export class Limiter {
  #active = 0;
  #queue = [];

  constructor(max) {
    this.max = max;
  }

  async run(fn) {
    if (this.#active < this.max) this.#active++;
    else await new Promise((r) => this.#queue.push(r)); // the finishing call hands its slot over
    try {
      return await fn();
    } finally {
      const next = this.#queue.shift();
      if (next) next();
      else this.#active--;
    }
  }
}

// A comma is only ever a thousands separator ("1,000.5"); "2,50" or "0,5" is a
// decimal comma and is refused rather than silently read as 250 or 5.
const GROUPED = /^[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/;

// Strict decimal parser for user-typed amounts: no signs, no exponents, no
// more fractional digits than the unit supports. Returns null when invalid.
export function parseAmount(input, decimals) {
  let s = String(input ?? '').trim();
  if (s.includes(',')) {
    if (!GROUPED.test(s)) return null;
    s = s.replace(/,/g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const frac = s.split('.')[1] ?? '';
  if (frac.length > decimals) return null;
  const v = parseUnits(s, decimals);
  return v > 0n ? v : null;
}

// Why parseAmount refused an input, when there's something specific to say.
export function amountHint(input) {
  const s = String(input ?? '').trim();
  if (s.includes(',') && !GROUPED.test(s)) return 'Use a dot for decimals, e.g. 2.5 (a comma only groups thousands, like 1,000).';
  return null;
}

// "50%" -> 5000 bps, "all"/"max" -> 10000. Null when not a percentage.
export function parsePercentBps(input) {
  const s = String(input ?? '').trim().toLowerCase();
  if (s === 'all' || s === 'max') return 10000;
  const m = s.match(/^(\d{1,3}(?:\.\d{1,2})?)%$/);
  if (!m) return null;
  const bps = Math.round(Number(m[1]) * 100);
  return bps > 0 && bps <= 10000 ? bps : null;
}

export const hoursAgo = (now, h) => now - h * 3600_000;
