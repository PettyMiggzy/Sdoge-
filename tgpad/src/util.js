import { randomBytes } from 'node:crypto';
import { parseUnits } from 'ethers';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const randomId = (bytes = 8) => randomBytes(bytes).toString('base64url');

// Runs fn() for a given key strictly one at a time (e.g. one tx per wallet, so
// two quick taps can't race each other for the same nonce).
export class KeyedSerializer {
  #tails = new Map();

  run(key, fn) {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.#tails.set(key, tail);
    tail.then(() => { if (this.#tails.get(key) === tail) this.#tails.delete(key); });
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
}

// Strict decimal parser for user-typed amounts: no signs, no exponents, no
// more fractional digits than the unit supports. Returns null when invalid.
export function parseAmount(input, decimals) {
  const s = String(input ?? '').trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const frac = s.split('.')[1] ?? '';
  if (frac.length > decimals) return null;
  const v = parseUnits(s, decimals);
  return v > 0n ? v : null;
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
