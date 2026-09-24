# SDOGE Telegram Launchpad (tgpad)

A no-UI meme-token launchpad that lives entirely in Telegram. People DM the bot, and it gives them a wallet. From there they can:

- launch a token (name, ticker, photo) in one tap;
- buy and sell it;
- claim their creator fees;
- redeem tokens against the token's **meme vault**, a pool of real USDC fed by 0.5% of every buy that acts as a redeemable price floor.

The on-chain side lives in `../launchpad/` (Uniswap v4 hook, factory, `MemeVault`).

**Status: the bot is built and tested (`npm test`); the contracts are not deployed yet.**
- The launchpad contracts are being fixed and re-audited (see `../launchpad/README.md`).
- The swap router that `/buy` and `/sell` call is part of that fix round.
- Until `FACTORY_ADDRESS`, `HOOK_ADDRESS` and `ROUTER_ADDRESS` are set, the bot still runs. It shows a clear "opens once the contracts are live" message for launching and trading, while wallets, deposits and withdrawals already work.

## What users can do

| Command | What it does |
|---|---|
| `/launch` | 4-step wizard: name, ticker, photo, description. The launch is screened, then previewed with its exact cost. One tap launches it from the user's own wallet, so they are the on-chain creator. |
| `/buy $TICKER 10` | Quote, then confirm, then buy with max slippage (default 5%, `/slippage` to change). Deep links from the channel (`Buy in bot`) land here too. |
| `/sell $TICKER 50%` | An amount, a percentage, or `all`. |
| `/claim` | Creator fees: 0.5% of every buy of tokens you launched. |
| `/vault $TICKER` | The vault's USDC backing, the circulating supply, the floor price and the market price. |
| `/redeem $TICKER 25%` | Burn tokens for their share of the vault. Warns you if selling would pay more. |
| `/wallet` `/deposit` `/withdraw 10 0x…` `/export` | Your wallet. `/export` sends your key as a spoiler that can't be forwarded and deletes itself after 60 seconds. |
| `/token` `/trending` `/mylaunches` `/report $TICKER reason` | Info and reporting. |

Every action that moves funds shows a preview and waits for a **Confirm** tap. A confirmation:
- expires after 2 minutes;
- works once;
- only works for the user who created it.

## Wallets (custodial)

Each Telegram user's key is `HMAC-SHA256(WALLET_MASTER_SECRET, "sdoge-tgpad/wallet/v1/<telegram id>/0")`.

- **No per-user keys are stored anywhere.** A lost or corrupted `data/store.json` never loses anyone's funds.
- **The master secret is everything.** Whoever has it controls every user's wallet, and losing it loses access to all of them. Back it up offline, in two places. A test pins the derivation, because changing it would silently move every user to an empty new wallet.
- **Approvals are exact.** Buys, sells and redeems approve exactly the amount being traded, never an unlimited allowance.
- **Transactions are queued per wallet.** One wallet's transactions go out one at a time, so double-taps can't race for a nonce.

## Keeping Telegram happy (moderation and anti-abuse)

Telegram takes bots down for publishing illegal or sexual content, for scams and for spam. The bot is built around not doing any of that.

**1. Screening happens before anything goes on-chain.** Nothing reaches the chain through the bot unless it passes both layers.
- **Local rules** (instant, free; `src/moderation.js` and `moderation/blocklist.json`):
  - names are ASCII only;
  - no links, @handles, emails or phone numbers;
  - no hidden or bidi characters;
  - a blocklist (slurs, extremism, sexual/CSAM terms, scam bait) that sees through leetspeak (`n1gger`) and elongation, without false positives such as "Niger" or "Scunthorpe";
  - reserved names and tickers (USDC, Circle, Tether, SDOGE, ETH…) can't be impersonated.
- **Venice vision model** (`qwen-3-8-27b` by default) looks at the name, ticker, description and **image** together.
  - It lets ordinary meme content through (cartoon dogs, cigars, crude jokes) and blocks clear violations.
  - Any outage or unreadable answer counts as **review**, never "allow".
  - Tested live: a harmless doge passes, and a fake "official Circle reward" token is blocked as impersonation.
  - Cost: about $0.0014 per check.

**2. Nothing unreviewed is posted publicly.**
- **Blocked:** the launch never happens.
- **Review:** the token launches, but its channel announcement waits until an admin taps Approve on the card they receive by DM.
- **Launched directly on-chain** (bypassing the bot): the launch is screened the same way and is **never** auto-announced.

**3. Behaviour that keeps the bot off spam lists.**
- It only works in DMs, never messages anyone who hasn't started it, and **leaves any group** it's added to unless that group is in `allowedGroups`.
- Outgoing messages are paced under Telegram's limits (about 1 per second per user, 1 every 3 seconds in the channel, with a global cap).
- Buy alerts: only buys of 25 USDC or more, at most one per token per minute, and at most 15 per minute in the channel.
- Per-user rate limits: 3 launches a day, 20 commands a minute and 5 reports a day. There is also a global cap of 60 launches an hour.
- Users must accept terms (the rules, the risks and the fee split) before doing anything.

**4. Admin tools.** Set `ADMIN_TELEGRAM_IDS`; admin commands are invisible to everyone else.
- `/review`: re-send pending review cards.
- `/hide $TICKER reason`: takes the token out of listings, disables buying through the bot, and deletes its channel post. Holders can still sell and redeem.
- `/unhide`.
- `/ban @user reason`: stops launching, buying and reporting. **Sell, claim, redeem, withdraw and export always keep working**, because a ban never traps funds.
- `/unban`, `/reports`, `/stats`.

## Setup (on the same DigitalOcean box as the buy bot)

1. **Create the bot.** In @BotFather, `/newbot` makes a **new** bot, separate from the SDOGE buy bot, so a problem with one never takes down the other.
   - Keep privacy mode on.
   - Set a description (e.g. "Launch and trade meme tokens on Arc. DM only.").
2. **Create the launch channel.** Add the bot as an admin that can post and delete messages, and note its ID (e.g. `-100…`).
3. **Install and configure:**
   ```bash
   cd ~/tr-bot-sdoge/Sdoge-/tgpad
   npm install --omit=dev
   cp .env.example .env && chmod 600 .env
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste as WALLET_MASTER_SECRET
   nano .env   # TELEGRAM_BOT_TOKEN, WALLET_MASTER_SECRET, ADMIN_TELEGRAM_IDS, VENICE_API_KEY, LAUNCHES_CHANNEL_ID
   ```
4. **Start it:** `pm2 start ecosystem.config.cjs && pm2 save`, then check the startup summary with `pm2 logs sdoge-tgpad`.
5. **Once the contracts are deployed,** put the addresses in `.env` (`FACTORY_ADDRESS`, `HOOK_ADDRESS`, `ROUTER_ADDRESS`) and run `pm2 restart sdoge-tgpad`.

## Operations and security

- **Server.** The server holds the master secret, which makes it the crown jewel. Use SSH keys only, a firewall with nothing inbound except SSH, unattended upgrades, and a separate non-root user for pm2 if possible. Keep `.env` at `chmod 600` and never commit it; it is gitignored.
- **Backups.** The master secret goes offline. `data/store.json` holds bans, launches, reviews and the indexer cursor, but **no keys**. Back it up daily (a `.bak` is kept automatically on every write).
- **Only one instance may poll a bot token.** A second one gets `409` errors; stop it.
- **Wallet balances.** Tell users to keep only what they're actively trading in bot wallets. They can `/export` anytime and import the key into Rabby or MetaMask on Arc (chain 5042).

## Development

```bash
npm test     # 59 tests: moderation, wallet derivation (pinned), every command and button path
             # against a fake Telegram and a fake chain, the indexer, pacing, and error handling
```

`src/chain.js` is the only module that talks to the chain, and `src/abi.js` holds every contract signature the bot relies on. If the launchpad contracts change, those two files are where the bot changes.

## Known gaps

- **Token images aren't pinned to IPFS.** The `uri` passed to `launch()` is empty. Images live as Telegram file IDs, so they show up in the bot and the channel but not in explorers or other UIs.
- **Exported keys can outlive the 60-second window.** The deletion timer doesn't survive a restart, so if the bot restarts inside that window, the key message stays until the user deletes it.
- **Buy alerts understate the buy slightly.** They show the pool-side USDC amount, which for exact-input buys is net of the 2% hook fee.
