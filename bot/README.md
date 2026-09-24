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
2. Asks Arc's RPC for the PoolManager's `Swap` events on the SDOGE pool
   (`POOL_ID`) since then — one log per swap, carrying the exact USDC
   paid and SDOGE received for that swap, however the buyer paid (native
   value, ERC-20/Permit2, an aggregator, a contract). An earlier version
   read the triggering transaction's native `value` field instead, which
   is $0 (and so silently skipped as dust) for any buy that didn't pay in
   native value — see "Why Swap events, not tx.value" below.
3. Queues one alert per buying transaction into a persisted outbox in
   `state.json`, netting out the 1% tax leg (`EXCLUDE_TO_ADDRESSES`) from
   the reported amount.
4. Drains the outbox, posting to Telegram (with the buy-alert video
   attached, see below) paced ~1.2s apart with automatic retry on rate
   limits. An item only leaves the outbox once Telegram has actually
   accepted it — a failed post is retried next pass, not lost.
5. Saves the new "last block checked" to `bot/state.json` so the next
   pass picks up where this one left off.

## Running it 24/7 on your own server (pm2)

```bash
cd bot
npm install -g pm2       # if you don't already have it
cp .env.example .env && $EDITOR .env   # fill in TELEGRAM_BOT_TOKEN at least
pm2 start ecosystem.config.cjs
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

### Why Swap events, not tx.value

The very first version detected buys from plain ERC-20 `Transfer` events
moving SDOGE out of the pool, and read the USD amount from the
triggering transaction's native `value` field — Arc's native currency
*is* USDC, so that was a reasonable-looking shortcut, and it's genuinely
correct for a buy paid directly in native value.

It's wrong for everything else: a buy routed through the ERC-20 view of
USDC (`0x3600...`), Permit2, an aggregator, or any contract-initiated
swap has `tx.value == 0` — computed as a $0 buy and silently skipped as
"below $1 minimum." Only native-value buys were ever actually announced;
a real production run confirmed this wasn't rare (a single ~7,500-block
window went from 3 detected buys under the old method to 24 under the
new one, several of them $50-$300 — not dust that was correctly
filtered, buys that were invisibly dropped).

The fix: the PoolManager's own `Swap` event
(`Swap(bytes32 id, address sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)`)
carries the pool's exact accounting for every swap, regardless of payment
path — `amount0`/`amount1` are the swapper's deltas (negative = paid,
positive = received), ordered by currency address per v4 convention
(`usdcIsCurrency0` = `USDC_VIEW_ADDRESS < SDOGE_TOKEN_ADDRESS`). Filtered
to `POOL_ID` (this pool only) via `topics: [SWAP_TOPIC, POOL_ID]` — both
values verified against a real buy tx's actual on-chain log before
shipping, not assumed: `SWAP_TOPIC` matched the real log's `topics[0]`,
`POOL_ID` matched `topics[1]`, and the decoded amounts lined up with that
same buy's already-confirmed USD/token figures. If Argus ever lists a
second SDOGE/USDC pool at a different fee tier, `POOL_ID` needs updating
to match — that's a config change, not a code change.

`MIN_BUY_USD` (default `1`) still skips alerting below that, checked
against the Swap log's own amount before any per-tx RPC call is made —
dust doesn't cost an `eth_getTransactionReceipt` just to be discarded.

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
- `POOL_ID`: `0xbb2cff1ea59daa260919f3f579c32cc261eebeb69126ec2a5b3ea77018f3e8e2`
  — identifies the SDOGE/USDC pool among every pool the shared PoolManager
  hosts. See "Why Swap events, not tx.value" below for how this was found
  and verified.
- `USDC_VIEW_ADDRESS`: `0x3600000000000000000000000000000000000000` — the
  ERC-20 view of Arc's native USDC. Only used to work out currency
  ordering (`usdcIsCurrency0`); not called as a contract.
- `USDC_POOL_DECIMALS`: `6` — the pool accounts USDC-side amounts in
  6-decimal units (matching `USDC_VIEW_ADDRESS`'s own decimals), separate
  from `TOKEN_DECIMALS` (SDOGE's 18).
- `CONFIRMATIONS`: `2` — blocks held back from the chain head before
  scanning, so a swap isn't picked up from a block that then gets
  reorged away.
- `UNIVERSAL_ROUTER_ADDRESS`: `0x8702463e73f74d0b6765aBceb314Ef07aCb92650` —
  Arc's Uniswap v4 UniversalRouter. Folded into the exclude list at
  runtime alongside `EXCLUDE_TO_ADDRESSES`.
- `EXCLUDE_TO_ADDRESSES`: `0xb021be536808f551b31789422fd28a6c9c6e97da,0xddab9022421c30391e9ec5ae6d0887c8adb88980`
  — the first received the initial mint and got tokens back from the pool
  3 times after that, which reads as the deployer/bonding-curve contract
  doing protocol-level operations rather than a user buying. **Worth
  double-checking this is right** — if it turns out to be a real user or
  something else entirely, just remove it from the list.

  The second is the 1% buy-tax address: every buy actually produces
  **two** Transfer events out of the pool in the same transaction, the
  tax split and the remaining 99% to the actual buyer. Detection itself
  (which transactions count as a buy) now comes from `Swap` events and
  doesn't depend on this list at all — getting an address here wrong can
  no longer cause a double-post. It's only used to net the tax leg back
  out of the reported "Got:" figure, so the buyer sees what they actually
  received, not the pool's gross swap output.
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

Since a failed scan never advances `bot/state.json`'s block cursor, none
of this loses history — the next pass that actually succeeds sweeps
every block back to the last good checkpoint and queues everything it
missed. And since v2, that guarantee extends past the RPC side: an alert
that's already been queued survives a Telegram outage too (see "How it
works" and the outbox note below), not just an RPC one.

A few smaller hardening fixes landed alongside the Swap-event change,
worth knowing about rather than discovering by surprise:

- **`state.json` writes are now atomic** (write to a temp file, then
  rename) with a `.bak` copy kept alongside. A crash mid-write used to
  risk a truncated, unparseable file; the bot now refuses to start on a
  corrupt `state.json` rather than silently resetting to "start from
  now" (which would have skipped everything since the last good save
  with no error at all).
- **`eth_getLogs` chunk size adapts** instead of using a fixed 2000-block
  window: it halves on a failure (a range too large for the RPC's result
  cap after a long outage, previously an unrecoverable stuck state) and
  grows back once chunks start succeeding again.
- **Every RPC call now has an explicit 15s timeout.** Previously a hung
  connection could stall a pass indefinitely with no fallback ever
  triggered — `rpcWithFallback` only helps if a call actually fails
  rather than hanging.

## The buy-alert video

If `bot/assets/buy-alert.mp4` exists, every alert is posted as a video
(Telegram `sendVideo`) with the usual message as the caption and the same
Tx/Buy/Chart buttons attached below it. If the file is ever missing,
alerts silently fall back to the old plain-text `sendMessage` — nothing
breaks either way, and the fallback needs no configuration.

Only the *first* alert actually uploads the file (a ~1.5MB multipart
`sendVideo`); Telegram hands back a `file_id` for it, which every
alert after that reuses (a small JSON `sendVideo` call, no re-upload).
This also helps with the flood-limit incident below — a big multipart
upload per alert took meaningfully longer per post than a JSON one,
which mattered when sweeping a backlog fast. If Telegram ever rejects a
stored `file_id` (e.g. it expired), the bot notices, clears it, and
falls back to a fresh upload automatically.

## Testing before launch

Set the Actions variable `DRY_RUN` to `true` (add it as an env var in the
workflow, or export it locally) to log the message instead of sending it —
useful for checking formatting without spamming the real channel; the log
line also notes whether a video would've been attached. You can also run it
locally against any already-live token/pool on Arc to confirm the RPC and
decoding logic work end-to-end before your own pool exists:

```bash
cd bot
SDOGE_TOKEN_ADDRESS=0x... POOL_ADDRESS=0x... POOL_ID=0x... \
TELEGRAM_BOT_TOKEN=x TELEGRAM_CHAT_ID=x DRY_RUN=true RUN_ONCE=true \
node buy-bot.js
```

Watch the log line each pass prints: `Blocks A-B: N swap(s) -> X buy
alert(s) queued, Y sell/other, Z below $MIN_BUY_USD`. If it shows swaps
but every single one lands in `sell/other`, `POOL_ID` or the
`usdcIsCurrency0` assumption (`USDC_VIEW_ADDRESS` vs
`SDOGE_TOKEN_ADDRESS`) is wrong for your config — double check both
against a real buy tx's logs on the explorer before going further.

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
