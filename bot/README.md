# $SDOGE Buy Bot

Posts a Telegram alert every time someone buys $SDOGE. Runs 24/7 as a
long-lived process (pm2, on your own server) - see "Running it 24/7"
below. A GitHub Actions workflow also exists as a manual/emergency
fallback, but it is **not** the primary way this runs anymore (see why
in "Why not just GitHub Actions cron").

## How it works

By default (no `RUN_ONCE` env var set), `buy-bot.js` loops forever,
sleeping `POLL_INTERVAL_MS` (default 25s) between passes. Each pass:

1. Reads `bot/state.json` for the last block it checked.
2. Asks Arc's RPC for any `Transfer` events that moved $SDOGE **out of the
   PoolManager address** since then — that's the on-chain signature of a buy.
3. Posts one Telegram message (with the buy-alert video attached, see below)
   per transfer — skipping any recipient in `EXCLUDE_TO_ADDRESSES` or
   `UNIVERSAL_ROUTER_ADDRESS` (see below), paced ~1.2s apart with
   automatic retry on Telegram's own rate limit (see below).
4. Saves the new "last block checked" to `bot/state.json` so the next
   pass picks up where this one left off.

## Running it 24/7 on your own server (pm2)

```bash
cd bot
npm install -g pm2       # if you don't already have it
cp .env.example .env && $EDITOR .env   # fill in TELEGRAM_BOT_TOKEN at least
pm2 start ecosystem.config.js
pm2 save && pm2 startup  # keep it running across a server reboot
```

Useful commands: `pm2 logs sdoge-buy-bot`, `pm2 restart sdoge-buy-bot`,
`pm2 stop sdoge-buy-bot`. Everything non-secret still comes from the
committed `bot/config.json`, same as before - `.env` only needs to carry
`TELEGRAM_BOT_TOKEN` (and `ARC_RPC_FALLBACK_URL`, if you're using one).

`ecosystem.config.cjs` passes Node `--env-file=.env` so it reads that file
natively (Node 20.6+, no `dotenv` dependency needed) and sets
`autorestart: true` so pm2 brings the process back if it ever crashes.

### Why not just GitHub Actions cron

That's how this ran initially, and it mostly worked, but it isn't
reliable enough to be the only thing announcing real buys: checked
against this repo's actual run history, only **2 of 18** runs were ever
a genuine `schedule` event — every other run happened because someone
manually triggered it (e.g. while developing). Real gaps of 30-60+
minutes opened up between runs with the bot not running *at all* during
them — any buy in that window just sat unannounced until the next run
happened to fire, which reads exactly like "missing" buys even though
the block-cursor design means nothing is ever permanently lost, just
delayed. A process that never exits doesn't have that gap.

`.github/workflows/buy-bot.yml` is kept as a manual (`workflow_dispatch`
only, no `schedule:` trigger) fallback — e.g. to sweep up alerts by hand
if your pm2 process is down for some reason. **Never run both at the same
time against the same Telegram chat** — they'd each independently detect
and announce the same buys, double-posting everything.

This detects buys via plain ERC-20 `Transfer` events rather than decoding
Uniswap v4's pool-specific `Swap` event, because that requires knowing the
exact `PoolKey` (fee tier, tick spacing, hooks address) which doesn't exist
until the pool is actually deployed. It's simpler and DEX-version-agnostic.

USD value per buy comes from the triggering transaction's native `value`
field — Arc's native currency *is* USDC, confirmed empirically (a real
buy's tx.value of 25 matched a real ~$25 purchase), so no separate USDC
contract or price feed is needed. `MIN_BUY_USD` (default `1`) skips
alerting on anything below that — dust buys under $1 get logged as
skipped rather than posted.

Each alert also shows price and market cap, derived from that same buy
rather than a separate price feed: price = USD spent ÷ tokens received,
market cap = that price × total supply (read fresh via `totalSupply()`
on-chain each time there's a buy to announce, rather than hardcoded —
the separate holder-initiated burn-to-redeem feature can shrink supply
over time, so a hardcoded number would slowly drift wrong). The tier
indicator (repeated 🐕, scaled by `BUY_TIER_1/2/3`) replaced an earlier
run of green circles that didn't read as on-brand.

**Real incident, now fixed:** sweeping a large backlog (237 transfers,
52 of them real qualifying buys) fired alerts at Telegram back-to-back
with no pacing. Telegram's per-chat flood limit kicked in partway
through and rejected 26 of them — and since `bot/state.json`'s cursor
advances after the batch regardless of individual post failures, those
26 real buys would have been gone for good. Every post is now paced
~1.2s apart, and if Telegram still returns a 429, the response's own
`retry_after` tells us exactly how long to wait before retrying (up to
5 attempts) instead of just giving up on that alert.

Each alert also names the pool (`POOL_LABEL`, default `Uniswap v4 (Argus)`
— just descriptive text, not looked up per-buy) and, if `TELEGRAM_URL`/
`X_URL` are set, adds a second button row linking out to those alongside
the existing Tx/Buy/Chart row.

## Configuring it

Non-secret config (token/pool addresses, exclude list, links) lives in
committed `bot/config.json` — these values are already public on-chain and
on the site, so there's no reason to make you click through the GitHub UI
for them. An environment variable of the same name always overrides the
config file, so `vars`/`secrets` in the workflow still work if you'd rather
manage things that way.

`bot/config.json` is already filled in post-launch:

- `SDOGE_TOKEN_ADDRESS`: `0xf8df98fda14cabb2e8b6efe920081ffcbb0bb405`
- `POOL_ADDRESS`: `0x8366a39cc670b4001a1121b8f6a443a643e40951` — originally
  found by scanning on-chain Transfer events from the deployment block
  forward (no block explorer indexed the token yet): nearly the full 1B
  supply moved here in the deployment tx, and it's since sent tokens out to
  19 different buyer addresses across 68 transfers — the standard signature
  of a pool. It's since been confirmed as Arc's Uniswap v4 **PoolManager** —
  a single singleton contract shared by *every* pool on the chain (v4
  doesn't deploy a separate contract per pool the way v2/v3 do), which is
  also why it holds a multi-million native-USDC balance covering all of
  Arc's pools, not just SDOGE's. Doesn't change how the bot uses it: every
  pool's tokens still move through this one address, so watching Transfers
  out of it for the SDOGE contract specifically still isolates SDOGE buys.
- `UNIVERSAL_ROUTER_ADDRESS`: `0x8702463e73f74d0b6765aBceb314Ef07aCb92650` —
  Arc's Uniswap v4 UniversalRouter, the contract swaps normally get routed
  through. Automatically folded into the exclude list at runtime (on top of
  whatever's in `EXCLUDE_TO_ADDRESSES`) so it's never misreported as a
  "buyer" if it ever shows up as an intermediate recipient.
- `EXCLUDE_TO_ADDRESSES`: `0xb021be536808f551b31789422fd28a6c9c6e97da,0xddab9022421c30391e9ec5ae6d0887c8adb88980`
  — the first received the initial mint and got tokens back from the pool
  3 times after that, which reads as the deployer/bonding-curve contract
  doing protocol-level operations rather than a user buying. **Worth
  double-checking this is right** — if it turns out to be a real user or
  something else entirely, just remove it from the list.

  The second is a real bug fix, found live: every buy actually produces
  **two** Transfer events out of the pool in the same transaction — the
  1% buy tax to this address, and the remaining 99% to the actual buyer.
  Confirmed by the ratio: across dozens of real buys, this address's
  share was consistently ~1.00% of the pair's total, to 4+ significant
  figures. Without excluding it, each buy was being announced *twice* —
  once correctly, and once for the tax split, with a wildly wrong price/
  market cap (the full tx's USD value divided by only that ~1% of the
  tokens produces a price ~100x too high). Excluding it fixes both: no
  more double-announcing, and no more nonsense market caps.
- `TELEGRAM_CHAT_ID`: `-1004414453950` — the "Stable Doge" group. Not
  sensitive on its own (it's just an ID for a chat people can already join),
  so it's fine here rather than in GitHub's secrets UI.
- `TELEGRAM_URL` / `X_URL`: `https://t.me/stabledoge1` / `https://x.com/stabledoge1`
  — the community links, shown as a second row of buttons on every alert.

**`TELEGRAM_BOT_TOKEN`** is the one piece that can't live in `config.json`
— a bot token is a real secret. Already created (`@Stabledogebbot`,
confirmed live via `getMe`, confirmed it's an admin in the "Stable Doge"
group via `getChatMember`) and **already live and posting real alerts**
to the group. Where it needs to go depends on how you're running the bot:

- **pm2 (primary)**: paste it into `bot/.env` (see "Running it 24/7"
  above) — that's the only config that path reads from a non-committed
  source.
- **GitHub Actions (manual fallback)**: already set as a repo secret at
  **https://github.com/PettyMiggzy/Sdoge-/settings/secrets/actions** —
  nothing to do here unless it needs rotating.

## RPC reliability (surviving rate limits)

Real incident: Arc's public RPC (`rpc.mainnet.arc.io`, the default) returned
a `429` mid-run, which briefly took the whole bot down and let a batch of
real buys go unannounced. Two fixes:

1. **Every chain read now tries up to three endpoints in order** before
   giving up: `ARC_RPC_URL` (default `https://rpc.mainnet.arc.io`) → a free
   backup on a *different* provider, `ARC_RPC_WSS_URL` (default
   `wss://rpc.blockdaemon.mainnet.arc.io/websocket`, no API key needed) →
   `ARC_RPC_FALLBACK_URL`, a paid RPC (e.g. Alchemy) if you set one. The
   free tiers are tried first specifically so a paid provider's usage/cost
   is only ever touched when both free options are actually down.
2. The polling loop no longer lets one bad iteration kill the whole
   ~4-minute window (see the workflow's `|| true`-style handling) — it just
   retries 25s later like it was always supposed to.

`ARC_RPC_FALLBACK_URL` is optional but, unlike everything else in this
list, **it's a credential** (a paid provider's URL has your API key baked
into it) — never put it in `config.json`. For pm2, put it in `bot/.env`
alongside `TELEGRAM_BOT_TOKEN`. For the GitHub Actions fallback, it goes
in as a repo secret:
**https://github.com/PettyMiggzy/Sdoge-/settings/secrets/actions/new**
— name `ARC_RPC_FALLBACK_URL`, paste the full URL (key included), save.
The code never logs the URL itself (only a label like `primary`/`free-wss`/
`paid-fallback`), and GitHub also auto-redacts secret values from Actions
logs as a second layer.

Since a failed run never advances `bot/state.json`, none of this loses
history — the next run that actually succeeds sweeps every block back to
the last good checkpoint in one pass and announces everything it missed,
exactly as if nothing had gone wrong (just later than it should have).

## The buy-alert video

If `bot/assets/buy-alert.mp4` exists, every alert is posted as a video
(Telegram `sendVideo`, multipart upload) with the usual message as the
caption and the same Tx/Buy/Chart buttons attached below it. If the file is
ever missing, alerts silently fall back to the old plain-text `sendMessage`
— nothing breaks either way, and the fallback needs no configuration.

## Testing before launch

Set the Actions variable `DRY_RUN` to `true` (add it as an env var in the
workflow, or export it locally) to log the message instead of sending it —
useful for checking formatting without spamming the real channel; the log
line also notes whether a video would've been attached. You can also run it
locally against any already-live token/pool on Arc to confirm the RPC and
decoding logic work end-to-end before your own pool exists:

```bash
cd bot
SDOGE_TOKEN_ADDRESS=0x... POOL_ADDRESS=0x... \
TELEGRAM_BOT_TOKEN=x TELEGRAM_CHAT_ID=x DRY_RUN=true RUN_ONCE=true \
node buy-bot.js
```

(`RUN_ONCE=true` there so it checks once and exits instead of looping —
drop it to test the actual persistent-loop behavior.)

## Operational notes

- **~25-second effective cadence** by default (`POLL_INTERVAL_MS`) for
  the pm2 daemon — tight enough that alerts feel close to real-time
  without hammering Arc's public RPC.
- **`bot/state.json` is plain local disk state** for the pm2 path — no
  git commit involved, since the process is long-lived and never loses
  its filesystem between passes the way a GitHub Actions runner does.
  The `workflow_dispatch`-only fallback workflow still commits it to git
  after each manual run, same as before, since that path *is* a fresh
  ephemeral runner every time.
- If you ever go back to running this on GitHub Actions as the primary
  path instead of pm2: cron can't fire more often than every 5 minutes
  there, and (see "Why not just GitHub Actions cron" above) even that
  wasn't firing reliably in practice.
