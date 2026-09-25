# SDOGE Telegram Launchpad (tgpad)

A no-UI meme-token launchpad that lives entirely in Telegram. People DM the bot, and it gives them a wallet. From there they can:

- launch a token (name, ticker, photo) in one tap;
- buy and sell it;
- claim their creator fees;
- redeem tokens against the token's **meme vault**: real USDC, fed by 0.5% of every buy, shared equally by every token. That gives each token a floor price that only goes up.

The on-chain side lives in `../launchpad/` (Uniswap v4 hook, factory, `MemeVault`).

**Status: the bot is built and tested (`npm test`); the contracts are rebuilt and tested but not deployed yet.**
- The launchpad contracts, including the swap router behind `/buy` and `/sell`, were rebuilt after the audit and are waiting on a re-audit (see `../launchpad/README.md`).
- Until `FACTORY_ADDRESS`, `HOOK_ADDRESS` and `ROUTER_ADDRESS` are set, the bot still runs. It shows a clear "opens once the contracts are live" message for launching and trading, while wallets, deposits and withdrawals already work.

## What users can do

| Command | What it does |
|---|---|
| `/launch` | 4-step wizard: name, ticker, photo, description. The launch is screened, then previewed with its exact cost. One tap launches it from the user's own wallet, so they are the on-chain creator. |
| `/buy $TICKER 10` | Quote, then confirm, then buy with max slippage (default **1%**, `/slippage` to change). Deep links from the channel (`Buy in bot`) land here too. |
| `/sell $TICKER 50%` | An amount, a percentage, or `all`. |
| `/claim` | Creator fees: 0.5% of every buy of tokens you launched. |
| `/vault $TICKER` | The vault's USDC backing, the floor price and the market price. |
| `/redeem $TICKER 25%` | Burn tokens for their share of the vault. The previewed payout is the on-chain minimum, and it warns you if selling would pay more. |
| `/wallet` `/deposit` `/withdraw 10 0x…` `/export` | Your wallet. `/export` sends your key as a spoiler that can't be forwarded and deletes itself after 60 seconds (also across a restart). |
| `/token` `/trending` `/mylaunches` `/report $TICKER reason` | Info and reporting. |

Amounts use a dot for decimals (`2.5`). A comma only groups thousands (`1,000.5`); `2,50` is refused with a hint rather than read as 250.

Tickers aren't unique, so every preview, confirmation and buy alert names the token and shows its contract address (`Cap Doge ($CAPD) · 0x7700…0001`). When several tokens share a ticker, holders' commands (`/sell`, `/redeem`, `/vault`, `/token`, `/report`) pick the one you hold, then the listed one; otherwise the bot lists them all with name, age, volume and address.

## Confirmations and outcomes

Every action that moves funds shows a preview and waits for a **Confirm** tap. A confirmation:
- expires after 2 minutes;
- works once: a second tap, or a Cancel after Confirm, only gets a short notice ("Already confirmed", "Too late to cancel") and never overwrites the result;
- only works for the user who created it.

Confirmed actions run in the background, one at a time per wallet (so two transactions never race for a nonce), while the user can keep using the bot.

**Every transaction is recorded by its hash before it is broadcast**, and the bot follows it to its receipt itself. The result message always says exactly what is known:

| Outcome | What the user sees |
|---|---|
| Confirmed | ✅ the result, with a link to the transaction. |
| Reverted on-chain | ❌ the reason when it can be recovered (price moved past your slippage, deadline passed, ran out of gas...), and that only the gas fee was spent, with the link. |
| Not sent, or refused by the network | ❌ the reason (e.g. "the launch fee changed from 2 to 100 USDC") and that nothing was sent and nothing was spent. |
| Not confirmed yet (RPC errors, timeouts) | ⏳ "Sent, but not confirmed yet. **Don't retry** until this shows as failed", with the link. The bot keeps checking and updates the message once the receipt appears (also after a restart); after 24 hours without one it says it was most likely dropped. A new preview of the same kind warns that an earlier one isn't confirmed yet. |

"Nothing was spent" is only ever said when it is certain. A launch whose outcome isn't known yet is still recorded as the user's the moment it's seen on-chain, and counts toward the daily limit.

**Prices are quoted again at Confirm.** The on-chain minimum is the previewed minimum or the fresh quote minus 1%, whichever is higher, so a price move in your favour isn't left for someone else to take. If the price moved against you by more than your slippage since the preview, nothing is sent. A preview warns when a trade moves the price by 2% or more, which is where sandwiching starts to pay.

**Launches send exactly the fee shown in the preview.** The factory requires the exact fee, so if it changed in between, the launch fails (nothing is spent) and the user is told the new fee.

## Wallets (custodial)

Each Telegram user's key is `HMAC-SHA256(WALLET_MASTER_SECRET, "sdoge-tgpad/wallet/v1/<telegram id>/0")`.

- **No per-user keys are stored anywhere.** A lost or corrupted `data/store.json` never loses anyone's funds.
- **The master secret is everything.** Whoever has it controls every user's wallet, and losing it loses access to all of them. Back it up offline, in two places. A test pins the derivation, because changing it would silently move every user to an empty new wallet.
- **Approvals are exact.** Buys are paid with native USDC and need no approval. Sells and redeems approve exactly the amount being traded, never an unlimited allowance.
- **Transactions are queued per wallet,** with fresh nonces (no request cache) that never go below one already mined.
- **Gas limits carry a margin** (estimate × 1.2 + 30,000). Anyone can change the state an estimate was made on (e.g. a `claimPlatform()` landing first costs a buy 17,100 more gas); only gas actually used is charged.

## Keeping Telegram happy (moderation and anti-abuse)

Telegram takes bots down for publishing illegal or sexual content, for scams and for spam. The bot is built around not doing any of that.

**1. Screening happens before anything goes on-chain.** Nothing reaches the chain through the bot unless it passes the local rules and, when a model is configured, the model too.
- **Local rules** (instant, free; `src/moderation.js` and `moderation/blocklist.json`):
  - names, tickers and descriptions are printable ASCII only, with no hidden, control or default-ignorable characters (so no homoglyphs, zero-width or filler tricks);
  - no links, domains, @handles, emails or phone numbers: the filter is a superset of what Telegram turns into links (every TLD Telegram links, `tg://`, `ton://` and other schemes, bare IPv4, lookalike domains). Ordinary prose such as "e.g.", "v2.0" or "Dr. Doge" still passes. Wizard input that Telegram itself marks as a link is refused too;
  - a blocklist (slurs, extremism, sexual/CSAM terms, scam bait) that sees through leetspeak both ways (`n1gger`, `N!gger`, `Ni99er`, `Circ1e`), elongation, words run together (`LoliDoge`, `HitlerCoin`) and spaced-out letters (`L O L I`, `K.I.K.E`), with an allowlist against false positives such as "Niger", "Scunthorpe", "Pedometer" or "Fire Retardant";
  - reserved names and tickers (USDC, Circle, Tether, SDOGE, ETH…) can't be impersonated, also with a `$`, trailing digits or leetspeak (`$USDC`, `USDC2`, `Circ1e`), and brand words can't appear anywhere in a name or ticker (`Circle USDC`, `USDC Rewards`, `Tether Gold`).
- **Venice vision model** (`qwen-3-8-27b` by default) looks at the name, ticker, description and **image** together.
  - It lets ordinary meme content through (cartoon dogs, cigars, crude jokes) and blocks clear violations, including any link or contact detail however it's written.
  - Any outage or unreadable answer counts as **review**, never "allow".
  - Tested live: a harmless doge passes, and a fake "official Circle reward" token is blocked as impersonation.
  - Cost: about $0.0014 per check. Only wallets that can pay the launch fee reach it, each user gets 10 checks a day, and an identical draft is only screened once.
- **Without a model** (`VENICE_API_KEY` unset), nothing is auto-approved: every launch goes live on-chain but waits for an admin before anything is posted.

**2. Nothing unreviewed is posted publicly.**
- **Blocked:** the launch never happens.
- **Review:** the token launches, but its channel announcement waits until an admin taps Approve on the card they receive by DM.
- **Same ticker or name as a listed token:** always review, whatever the model said (it can't know the ticker is taken).
- **Launched directly on-chain** (bypassing the bot): the launch is screened the same way and is **never** auto-announced or promoted: it gets no buy alerts until an admin approves it.
- Buy alerts go only to tokens that passed the bot's screening or an admin, and are re-checked right before sending, so nothing hidden meanwhile is posted.

**3. Behaviour that keeps the bot off spam lists.**
- It only works in DMs, never messages anyone who hasn't started it, and **leaves any group** it's added to unless that group is in `allowedGroups`.
- Outgoing messages and edits are paced under Telegram's limits (about 1 per second per user, 1 every 3 seconds in the channel, with a global cap). Each chat waits for its own gap only; one busy chat never holds up the others.
- Buy alerts: only buys of 25 USDC or more, at most one per token per minute, at most 15 per minute in the channel, and never for buys older than about a minute (after downtime, the backlog updates volume without being posted as news).
- Per-user rate limits: 3 launches a day, 20 commands or button taps a minute, 5 reports a day and 10 model checks a day. There is also a global cap of 60 launches an hour, and a cap on RPC requests in flight.
- Users must accept terms (the rules, the risks and the fee split) before doing anything.

**4. Admin tools.** Set `ADMIN_TELEGRAM_IDS`; admin commands are invisible to everyone else.
- `/review`: re-send pending review cards.
- `/hide $TICKER reason`: takes the token out of listings, disables buying through the bot, and removes its channel post and buy alerts. Telegram doesn't let bots delete channel posts older than 48 hours: those are replaced with a "Removed by the moderators" notice. The admin is told exactly what was removed, with a link to anything that couldn't be. Holders can still sell and redeem.
- `/unhide`.
- `/ban <id> reason` bans at once. `/ban @user reason` shows which account holds that username now (usernames get reused; stale claims are cleared) and asks for a confirming tap. A ban stops launching, buying and reporting. **Sell, claim, redeem, withdraw and export always keep working**, because a ban never traps funds.
- `/unban`, `/reports`, `/stats`.
- Admins get a DM when the indexer falls more than 3,000 blocks behind or keeps failing (with the RPC's own error), and when it has caught up.

## Setup (on the same DigitalOcean box as the buy bot)

1. **Create the bot.** In @BotFather, `/newbot` makes a **new** bot, separate from the SDOGE buy bot, so a problem with one never takes down the other.
   - Keep privacy mode on.
   - Set a description (e.g. "Launch and trade meme tokens on Arc. DM only.").
2. **Create the launch channel.** Add the bot as an admin that can **post, edit and delete** messages (editing is how posts older than 48 hours are taken down), and note its ID (e.g. `-100…`).
3. **Install and configure:**
   ```bash
   cd ~/Sdoge-/tgpad   # wherever this repo is cloned on the box
   npm install --omit=dev
   cp .env.example .env && chmod 600 .env
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste as WALLET_MASTER_SECRET
   nano .env   # TELEGRAM_BOT_TOKEN, WALLET_MASTER_SECRET, ADMIN_TELEGRAM_IDS, VENICE_API_KEY, LAUNCHES_CHANNEL_ID
   ```
4. **Start it:** `pm2 start ecosystem.config.cjs && pm2 save`, then check the startup summary with `pm2 logs sdoge-tgpad`.
5. **Once the contracts are deployed,** put the addresses in `.env` (`FACTORY_ADDRESS`, `HOOK_ADDRESS`, `ROUTER_ADDRESS`) and run `pm2 restart sdoge-tgpad`.

## Operations and security

- **Server.** The server holds the master secret, which makes it the crown jewel. Use SSH keys only, a firewall with nothing inbound except SSH, unattended upgrades, and a separate non-root user for pm2 if possible. Keep `.env` at `chmod 600` and never commit it; it is gitignored.
- **Backups.** The master secret goes offline. `data/store.json` holds bans, launches, reviews, the indexer cursor and transactions awaiting confirmation, but **no keys**. Back it up daily (a `.bak` is kept automatically on every write).
- **Only one instance may run.** The bot takes a lock (`data/store.json.lock`, holding its pid) at startup and refuses to start while another process holds it; a lock left by a process that died is taken over. An instance that keeps getting `409` from Telegram (another poller on the same token, e.g. on another machine) stops itself.
- **Restarts and shutdown.** On SIGINT/SIGTERM the bot stops taking new work (the long poll is aborted, new Confirm taps are refused), waits for transactions already sent, saves and exits. pm2's `kill_timeout` is 150 s so it isn't killed mid-wait. Anything still unconfirmed is saved by hash and checked after the restart; users whose action was interrupted before anything was sent are told so. An unhandled promise rejection is logged and the bot keeps running (it no longer depends on pm2 for that); an uncaught exception shuts it down gracefully and pm2 restarts it.
- **The indexer** reads only the launchpad's own pools, never every swap on Arc's shared PoolManager. A window the RPC refuses as too large (its 20,000-result or 10,000-block cap) is halved until it fits, then grows back, so a burst of swaps can't stall it.
- **Wallet balances.** Tell users to keep only what they're actively trading in bot wallets. They can `/export` anytime and import the key into Rabby or MetaMask on Arc (chain 5042).

## Development

```bash
npm test     # 141 tests: moderation (every TLD Telegram links, the auditors' bypass strings),
             # wallet derivation (pinned), every command and button path against a fake Telegram
             # and a fake chain, the real Chain + ethers provider against a mock JSON-RPC node with
             # injected faults (lost responses, 5xx, dropped sockets, refusals, reverts, never-mined
             # transactions), the indexer against Arc's getLogs limits, pacing, the store lock and
             # graceful shutdown
```

`src/chain.js` is the only module that talks to the chain, and `src/abi.js` holds every contract signature (and custom error) the bot relies on. If the launchpad contracts change, those two files are where the bot changes. `src/app.js` runs the polling, indexing and maintenance loops; `src/index.js` only wires them up.

## Known gaps

- **Token images aren't pinned to IPFS.** The `uri` passed to `launch()` is empty. Images live as Telegram file IDs, so they show up in the bot and the channel but not in explorers or other UIs.
- **Buy alerts understate the buy slightly.** They show the pool-side USDC amount, which for exact-input buys is net of the 2% hook fee.
- **No atomic creator buy.** The launch and the creator's first buy are separate transactions, so a bot watching `Launched` can buy first (audit R2-LAUNCH-05; needs a contract change).
- **The "Creator" in a channel post is the launcher.** After an on-chain creator handover (`transferCreator`), the fee recipient differs (audit R2-LAUNCH-06).
