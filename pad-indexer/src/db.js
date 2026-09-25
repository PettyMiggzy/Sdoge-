import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CFG } from './config.js';

mkdirSync(dirname(CFG.dbPath), { recursive: true });
export const db = new Database(CFG.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS pools (
  token TEXT PRIMARY KEY, creator TEXT, locker TEXT, splitter TEXT, pool_id TEXT UNIQUE,
  name TEXT, symbol TEXT, token_is_token0 INTEGER, buy_tax_bps INTEGER, sell_tax_bps INTEGER,
  created_at INTEGER, block INTEGER, tx_hash TEXT
);

CREATE TABLE IF NOT EXISTS swaps (
  tx_hash TEXT, log_index INTEGER, token TEXT, block INTEGER, ts INTEGER, is_buy INTEGER,
  token_amt REAL, quote_amt REAL, price REAL, sqrt_price TEXT, trader TEXT,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS swaps_token_ts ON swaps (token, ts);

CREATE TABLE IF NOT EXISTS balances (
  token TEXT, holder TEXT, balance TEXT NOT NULL, bal_f REAL NOT NULL,
  PRIMARY KEY (token, holder)
);
CREATE INDEX IF NOT EXISTS balances_token_f ON balances (token, bal_f DESC);

CREATE TABLE IF NOT EXISTS taxes (
  tx_hash TEXT, log_index INTEGER, pool_id TEXT, is_buy INTEGER, amount TEXT, block INTEGER, ts INTEGER,
  PRIMARY KEY (tx_hash, log_index)
);
`);

export const getMeta = (k, d) => db.prepare('SELECT v FROM meta WHERE k=?').get(k)?.v ?? d;
export const setMeta = (k, v) => db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));

export const q = {
  insertPool: db.prepare(`INSERT OR IGNORE INTO pools VALUES (@token,@creator,@locker,@splitter,@pool_id,@name,@symbol,@token_is_token0,@buy_tax_bps,@sell_tax_bps,@created_at,@block,@tx_hash)`),
  pools: db.prepare('SELECT * FROM pools ORDER BY created_at DESC'),
  poolByToken: db.prepare('SELECT * FROM pools WHERE token=?'),

  insertSwap: db.prepare(`INSERT OR IGNORE INTO swaps VALUES (@tx_hash,@log_index,@token,@block,@ts,@is_buy,@token_amt,@quote_amt,@price,@sqrt_price,@trader)`),
  lastSwap: db.prepare('SELECT * FROM swaps WHERE token=? ORDER BY block DESC, log_index DESC LIMIT 1'),
  swapAtOrBefore: db.prepare('SELECT price FROM swaps WHERE token=? AND ts<=? ORDER BY ts DESC LIMIT 1'),
  vol24: db.prepare('SELECT COALESCE(SUM(quote_amt),0) v, COUNT(*) n FROM swaps WHERE token=? AND ts>?'),
  netQuoteIn: db.prepare('SELECT COALESCE(SUM(CASE WHEN is_buy=1 THEN quote_amt ELSE -quote_amt END),0) v FROM swaps WHERE token=?'),
  trades: db.prepare('SELECT * FROM swaps WHERE token=? ORDER BY ts DESC, log_index DESC LIMIT ?'),
  swapsSince: db.prepare('SELECT ts, price, quote_amt FROM swaps WHERE token=? AND ts>=? ORDER BY block ASC, log_index ASC'),

  insertTax: db.prepare(`INSERT OR IGNORE INTO taxes VALUES (@tx_hash,@log_index,@pool_id,@is_buy,@amount,@block,@ts)`),

  getBal: db.prepare('SELECT balance FROM balances WHERE token=? AND holder=?'),
  setBal: db.prepare(`INSERT INTO balances VALUES (?,?,?,?) ON CONFLICT(token,holder) DO UPDATE SET balance=excluded.balance, bal_f=excluded.bal_f`),
  // Protocol addresses (PoolManager holding the locked position, the locker's
  // dust, the burn sink, the hook) aren't holders; the caller passes them.
  holderCount: db.prepare(`SELECT COUNT(*) n FROM balances WHERE token=? AND bal_f>0 AND holder NOT IN (SELECT value FROM json_each(?))`),
  topHolders: db.prepare(`SELECT holder, balance, bal_f FROM balances WHERE token=? AND bal_f>0 ORDER BY bal_f DESC LIMIT ?`),
};
