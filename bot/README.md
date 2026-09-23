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

## Configuring it

Non-secret config (token/pool addresses, exclude list, links) lives in
committed `bot/config.json` — these values are already public on-chain and
on the site, so there's no reason to make you click through the GitHub UI
for them. An environment variable of the same name always overrides the
config file, so `vars`/`secrets` in the workflow still work if you'd rather
manage things that way.

`bot/config.json` is already filled in post-launch:

- `SDOGE_TOKEN_ADDRESS`: `0xf8df98fda14cabb2e8b6efe920081ffcbb0bb405`
- `POOL_ADDRESS`: `0x8366a39cc670b4001a1121b8f6a443a643e40951` — derived by
  scanning on-chain Transfer events from the deployment block forward (no
  block explorer indexed the token yet): nearly the full 1B supply moved
  here in the deployment tx, and it's since sent tokens out to 19 different
  buyer addresses across 68 transfers — the standard signature of a pool.
  Also holds a multi-million native-USDC balance, consistent with an
  active SDOGE/USDC pool.
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
