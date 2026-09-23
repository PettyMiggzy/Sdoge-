# $SDOGE Buy Bot

Posts a Telegram alert every time someone buys $SDOGE. Runs as a GitHub
Actions cron job every 5 minutes — no server required.

## How it works

There's no long-lived process. Every 5 minutes, `.github/workflows/buy-bot.yml`
spins up a fresh runner that:

1. Reads `bot/state.json` for the last block it checked.
2. Asks Arc's RPC for any `Transfer` events that moved $SDOGE **out of the
   PoolManager address** since then — that's the on-chain signature of a buy.
3. Posts one Telegram message (with the buy-alert video attached, see below)
   per transfer — skipping any recipient in `EXCLUDE_TO_ADDRESSES` or
   `UNIVERSAL_ROUTER_ADDRESS` (see below).
4. Commits the new "last block checked" back to `bot/state.json` so the next
   run picks up where this one left off.

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
- `EXCLUDE_TO_ADDRESSES`: `0xb021be536808f551b31789422fd28a6c9c6e97da` —
  this address received the initial mint and got tokens back from the pool
  3 times after that, which reads as the deployer/bonding-curve contract
  doing protocol-level operations rather than a user buying. Excluded so
  it doesn't get announced as a buy. **Worth double-checking this is right**
  — if it turns out to be a real user or something else entirely, just
  remove it from the list.
- `TELEGRAM_CHAT_ID`: `-1004414453950` — the "Stable Doge" group. Not
  sensitive on its own (it's just an ID for a chat people can already join),
  so it's fine here rather than in GitHub's secrets UI.

**One thing left, and it has to go through the GitHub web UI** — a bot
token is a real secret and must never be committed to a public repo, so
this is the one piece that can't just live in `config.json`:

`TELEGRAM_BOT_TOKEN` — already created (`@Stabledogebbot`, confirmed live
via `getMe`, confirmed it's an admin in the "Stable Doge" group via
`getChatMember`) — just needs to go in as a **secret**, not committed
anywhere. Add it at:
**https://github.com/PettyMiggzy/Sdoge-/settings/secrets/actions/new**
— name `TELEGRAM_BOT_TOKEN`, paste the token value, save.

That's the only remaining gap. The moment it's set, the very next
scheduled run goes live (it does **not** backfill the 68+ buys that
already happened — first activation starts fresh from the current block
so it doesn't flood the channel with old history). Trigger it immediately
via **Actions → SDOGE Buy Bot → Run workflow** instead of waiting up to
5 minutes.

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
into it) — it must go in as a GitHub **secret**, never in `config.json`:
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
TELEGRAM_BOT_TOKEN=x TELEGRAM_CHAT_ID=x DRY_RUN=true \
node buy-bot.js
```

## Operational notes

- **Free, on a public repo.** GitHub Actions cron is unlimited/free for
  public repositories; this repo is public.
- **~25-second effective cadence**, not the raw 5-minute cron interval.
  GitHub Actions can't schedule cron more often than every 5 minutes, so
  each tick instead loops internally (re-checking every ~25s for ~4m10s)
  before exiting with a buffer ahead of the next tick. Vercel Pro
  (~$20/mo) would give true per-minute cron instead of this workaround,
  but this gets most of the benefit for free — Vercel's free Hobby tier
  only allows once-a-day cron, which would be worse, not better.
- **Auto-disable after 60 days of repo inactivity.** GitHub disables
  scheduled workflows if the default branch gets no pushes for 60 days
  (you'll get a warning email first). Not a practical concern while this
  repo is under active development; worth remembering if things go quiet
  post-launch.
- State is committed as a real git commit on every run that finds new
  activity. That's intentional and normal for this pattern, not a sign of
  something wrong.
