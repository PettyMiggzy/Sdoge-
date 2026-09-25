import express from 'express';
import cors from 'cors';
import { CFG } from './config.js';
import { q } from './db.js';

const NOW = () => Math.floor(Date.now() / 1000);
/** Integer query param clamped to [min, max]; junk falls back to `dflt`. (Unclamped, a negative n would reach SQLite as LIMIT -1 = no limit.) */
const intParam = (v, dflt, min, max) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const BUCKET_SEC = 900; // 15 min, the same default interval as pad-web's getCandles

function poolRow(p) {
  return {
    token: p.token, creator: p.creator, locker: p.locker, splitter: p.splitter, poolId: p.pool_id,
    name: p.name, symbol: p.symbol, blockNumber: p.block, txHash: p.tx_hash, createdAt: p.created_at,
  };
}

const DEAD = '0x000000000000000000000000000000000000dead';
function protocolAddrs(token) {
  const pool = q.poolByToken.get(token);
  return [CFG.poolManager.toLowerCase(), CFG.hook.toLowerCase(), DEAD, pool?.locker].filter(Boolean);
}

function computeStats(token) {
  const last = q.lastSwap.get(token);
  const priceUsd = last?.price ?? 0;
  const marketCapUsd = priceUsd * CFG.totalSupply;
  const cutoff = NOW() - 86400;
  const { v: volume24hUsd, n: txns24h } = q.vol24.get(token, cutoff);
  const prior = q.swapAtOrBefore.get(token, cutoff)?.price;
  const change24hPct = prior && prior > 0 ? ((priceUsd - prior) / prior) * 100 : 0;
  const holders = q.holderCount.get(token, JSON.stringify(protocolAddrs(token))).n;
  // Net quote flow into the pool since launch — an approximation of quote-side
  // liquidity, not a real tick-range valuation. Good enough for a board
  // ranking; a precise number would need to read the pool's actual
  // liquidity + tick range on-chain (which the frontend's own fetchSpot
  // already does for price, just not for a $ liquidity figure).
  const liquidityUsd = Math.max(0, q.netQuoteIn.get(token).v);
  return { priceUsd, marketCapUsd, volume24hUsd, change24hPct, holders, txns24h, liquidityUsd };
}

function computeCandles(token, n, bucketSec = BUCKET_SEC) {
  const cutoff = NOW() - n * bucketSec;
  const rows = q.swapsSince.all(token, cutoff);
  if (!rows.length) return [];
  const buckets = new Map();
  for (const r of rows) {
    const bt = Math.floor(r.ts / bucketSec) * bucketSec;
    const b = buckets.get(bt);
    if (!b) buckets.set(bt, { t: bt, o: r.price, h: r.price, l: r.price, c: r.price, v: r.quote_amt });
    else { b.h = Math.max(b.h, r.price); b.l = Math.min(b.l, r.price); b.c = r.price; b.v += r.quote_amt; }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t).slice(-n);
}

export function startApi() {
  const app = express();
  app.use(cors());

  app.get('/launches', (_req, res) => res.json(q.pools.all().map(poolRow)));

  // No /metadata endpoints: token-page metadata lives in pad-web's
  // /api/metadata, where writes must be signed by the token's creator. This
  // service is read-only over HTTP.

  app.get('/stats/:token', (req, res) => res.json(computeStats(req.params.token.toLowerCase())));

  app.get('/trades/:token', (req, res) => {
    const n = intParam(req.query.n, 30, 1, 200);
    const rows = q.trades.all(req.params.token.toLowerCase(), n);
    res.json(rows.map((r) => ({ hash: r.tx_hash, ts: r.ts, isBuy: !!r.is_buy, usd: r.quote_amt, tokens: r.token_amt, trader: r.trader })));
  });

  app.get('/holders/:token', (req, res) => {
    const n = intParam(req.query.n, 20, 1, 100);
    const token = req.params.token.toLowerCase();
    const pm = CFG.poolManager.toLowerCase();
    const rows = q.topHolders.all(token, n);
    res.json(rows.map((r) => ({
      address: r.holder, balance: r.bal_f, pct: (r.bal_f / CFG.totalSupply) * 100,
      ...(r.holder === pm ? { tag: 'Pool liquidity, locked' } : r.holder === DEAD ? { tag: 'Burned' } : {}),
    })));
  });

  app.get('/candles/:token', (req, res) => {
    const n = intParam(req.query.n, 96, 1, 500);
    const interval = intParam(req.query.interval, BUCKET_SEC, 60, 86400);
    res.json(computeCandles(req.params.token.toLowerCase(), n, interval));
  });

  app.listen(CFG.port, () => console.log(`[api] listening on :${CFG.port}`));
}
