# $SDOGE Buy Bot

Posts a Telegram alert every time someone buys $SDOGE. Runs as a GitHub
Actions cron job every 5 minutes — no server required.

## How it works

There's no long-lived process. Every 5 minutes, `.github/workflows/buy-bot.yml`
spins up a fresh runner that:

1. Reads `bot/state.json` for the last block it checked.
2. Asks Arc's RPC for any `Transfer` events that moved $SDOGE **out of the
   pool address** since then — that's the on-chain signature of a buy.
3. Posts one Telegram message per transfer (skipping any in
   `EXCLUDE_TO_ADDRESSES`, see below).
4. Commits the new "last block checked" back to `bot/state.json` so the next
   run picks up where this one left off.

This detects buys via plain ERC-20 `Transfer` events rather than decoding
Uniswap v4's pool-specific `Swap` event, because that requires knowing the
exact `PoolKey` (fee tier, tick spacing, hooks address) which doesn't exist
until the pool is actually deployed. It's simpler and DEX-version-agnostic,
at the cost of not showing a USD value per buy (only the SDOGE amount) —
that could be added later once the real pool + a USDC-on-Arc quote path is
known.

## Before it can go live

The bot already runs on every cron tick — right now it just logs "not
configured yet" and exits, because none of the following exist yet:

1. **A Telegram bot.** In Telegram, message **@BotFather** → `/newbot` →
   follow the prompts → it gives you a token like `123456:ABC-DEF...`.
2. **A chat to post into.** Add the new bot to your Telegram
   group/channel as an admin (needs permission to post messages). Then get
   the chat ID: the simplest way is to add
   [@userinfobot](https://t.me/userinfobot) or
   [@RawDataBot](https://t.me/RawDataBot) to the same chat momentarily and
   read the `chat.id` it reports (channels/groups have a negative ID like
   `-1001234567890`), then remove it again.
3. **The deployed $SDOGE token address and pool address.** Not available
   until launch — the site itself still shows the contract as "TBA."

## Configuring it

In the repo's **Settings → Secrets and variables → Actions**:

**Secrets** (encrypted, never shown again):
- `TELEGRAM_BOT_TOKEN` — from step 1 above.

**Variables** (plain config, fine to be visible to anyone with repo access):
- `SDOGE_TOKEN_ADDRESS` — the $SDOGE ERC-20 contract on Arc
- `POOL_ADDRESS` — the SDOGE/USDC pool address
- `TELEGRAM_CHAT_ID` — from step 2 above
- `ARC_RPC_URL` — optional, defaults to `https://rpc.mainnet.arc.io`
- `TOKEN_DECIMALS` — optional, defaults to `18`
- `MIN_BUY_TOKENS` — optional, skip alerts below this size
- `EXCLUDE_TO_ADDRESSES` — optional, comma-separated. **Set this to the
  Treasury/buyback-and-burn contract's address once known** — that contract
  also withdraws SDOGE from the pool when it executes a buyback, and without
  this exclusion the bot would misreport the protocol's own buyback as a
  user buy.
- `BUY_URL`, `CHART_URL` — optional links appended to each alert
- `BUY_TIER_1/2/3` — optional token-amount thresholds for the 🟢 emoji
  scaling (defaults: 100k / 1M / 5M)

Once `SDOGE_TOKEN_ADDRESS`, `POOL_ADDRESS`, `TELEGRAM_CHAT_ID`, and
`TELEGRAM_BOT_TOKEN` are all set, the very next scheduled run will start
watching from the current block (it does **not** backfill history — the
first run just sets a baseline so launch-day doesn't get flooded with old
transfers). Trigger it immediately via **Actions → SDOGE Buy Bot → Run
workflow** instead of waiting up to 5 minutes.

## Testing before launch

Set the Actions variable `DRY_RUN` to `true` (add it as an env var in the
workflow, or export it locally) to log the message instead of sending it —
useful for checking formatting without spamming the real channel. You can
also run it locally against any already-live token/pool on Arc to confirm
the RPC and decoding logic work end-to-end before your own pool exists:

```bash
cd bot
SDOGE_TOKEN_ADDRESS=0x... POOL_ADDRESS=0x... \
TELEGRAM_BOT_TOKEN=x TELEGRAM_CHAT_ID=x DRY_RUN=true \
node buy-bot.js
```

## Operational notes

- **Free, on a public repo.** GitHub Actions cron is unlimited/free for
  public repositories; this repo is public.
- **5-minute cadence**, not real-time. That's GitHub Actions' minimum cron
  interval. For tighter latency, this same script could run on Vercel Cron
  instead, but Vercel's free Hobby tier only allows once-a-day cron — you'd
  need a paid Pro plan for per-minute frequency.
- **Auto-disable after 60 days of repo inactivity.** GitHub disables
  scheduled workflows if the default branch gets no pushes for 60 days
  (you'll get a warning email first). Not a practical concern while this
  repo is under active development; worth remembering if things go quiet
  post-launch.
- State is committed as a real git commit on every run that finds new
  activity. That's intentional and normal for this pattern, not a sign of
  something wrong.
