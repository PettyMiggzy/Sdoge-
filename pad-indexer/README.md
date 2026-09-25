# SDOGE Pad indexer

Small Node + SQLite service that reads SDOGE Pad's on-chain events
(`LaunchCreated`, `Swap`, `Transfer`, `TaxCollected`) into a local database and
serves them over HTTP, so `pad-web` can show real 24h volume, trades, holders and
candles. Without it the site still works; those fields just show "—".

Backfills from `START_BLOCK` in `CHUNK_BLOCKS`-sized ranges, then polls for new blocks
every `POLL_MS`. The API starts immediately and serves whatever's in the database so
far; it doesn't wait for the backfill to finish.

## Setup

```bash
cd pad-indexer
npm ci
cp .env.example .env   # fill in PORTAL, HOOK and START_BLOCK from the deploy
npm start
```

`npm run backfill` runs the backfill once and exits (no API server, no tail loop),
which is handy for a first full sync before switching to `npm start`.

## Endpoints

- `GET /launches`: all launches, newest first.
- `GET /stats/:token`: price, market cap, 24h volume/change, holder count, liquidity (approx).
- `GET /trades/:token?n=30`: most recent trades.
- `GET /holders/:token?n=20`: top holders by balance.
- `GET /candles/:token?n=96`: 15-minute OHLCV buckets.

Point `pad-web`'s `NEXT_PUBLIC_INDEXER_URL` at wherever this is deployed and the site
switches over automatically; no code changes on that side.

## A decimals fact that matters if you touch `chain.js`

Quote (USDC) amounts inside `Swap` events are 6-decimal, because that's the ERC-20
the pool actually moves, even though a wallet's native balance for the same USDC is
18-decimal on Arc. `QUOTE_DECIMALS=6` in `.env` is for the event math here.

## Event signatures

`src/chain.js`'s `EV` object matches the audited contracts in `../pad/src`. `getLogs`
filters by an event's topic hash, so a stale signature doesn't error; it silently
matches zero logs. If a contract change ever adds or removes an event field, update
`EV` here and `pad-web/lib/abi.ts` together.

## Running it as a service

Any always-on host works: a `systemd` unit with an `EnvironmentFile` pointing at this
directory's `.env`, running `npm start`, with `DB_PATH` on persistent disk. Put it
behind HTTPS, because the site calls it from visitors' browsers.
