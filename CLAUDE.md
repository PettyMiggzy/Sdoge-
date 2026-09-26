# Project memory: $SDOGE (The Stable Doge) on Arc

The owner's standing decisions and the project's current state. Read this first,
follow it, and update it whenever the owner decides something new. The owner asked
for decisions to live in the repo so nothing depends on chat memory.

## The project

- $SDOGE is a fixed-supply meme token on Arc mainnet (chain 5042, USDC is the gas
  token). Token: `0xf8df98fda14cabb2e8b6efe920081ffcbb0bb405`. Site:
  https://stabledoge.site. Socials: https://x.com/stabledoge1,
  https://t.me/stabledoge1.
- Owner's wallet: `0x5899a0576A94327a6316E01190f951edf7645914`. It created $SDOGE (it is
  the `creator` in SDOGE's fee splitter `0xddab…8980`) and owns SDOGE Pad.
- Work happens on the branch `claude/stable-doge-arc-launch-zlx78f`, the repo's only
  and default branch. Every commit ends with the Co-Authored-By / Claude-Session
  footer lines. No AI model names in commits, PRs or code.

## Owner decisions (don't change without asking the owner)

- **SDOGE's own brand only.** Code, comments, docs, images and commit messages name
  only SDOGE's own projects, contracts, wallets, domains and socials (above). Don't
  bring in names, addresses, links or wording from anywhere else.
- **Hidden pages.** `staking.html`, `nft.html` and `studio.html` stay unlinked from
  `index.html` until the owner says they're ready ("I don't want people peeking").
- **Tokenomics are fixed.** Staking tiers 7/30/90/180/365 days, multipliers
  1.0/1.2/1.5/2.0/3.0x, 15% early-exit penalty, 80% maturity point, per-stake
  forfeiture. They are constants in `SDOGEStaking.sol`. Don't edit the tokenomics
  copy in `index.html` without the owner.
- **Staking rewards:** the SDOGE side comes from the owner's dev fees, the USDC side
  from NFT profits. Staking is for $SDOGE only.
- **The early-exit penalty stays in the pool** ("it stays in there"): the 15% and any
  forfeited rewards stream to the stakers who stay. There is no sweep.
- **Studio AI** ("Create with AI" on `studio.html`, `api/ai/*`, see `api/README.md`): buyers
  pay USDC on Arc straight to the owner's wallet (0x5899…5914) for credits (0.25 USDC each, 10
  for 2, 50 for 8); every image costs at least 2.5x what Venice charges ("I need profit off
  it"). Uncensored except no sexual content with minors and no sexual images of real people.
  Those two blocks are enforced by three checks (word lists, two Venice text models on every
  prompt, two vision models on every adult image); they are a hard line, not a setting, and
  Studio AI stays closed if they can't run. `VENICE_API_KEY` lives only in the `sdoge` Vercel
  project's env (sensitive; set 2026-09-26 at the owner's request); images go to the public Blob
  store `sdoge-studio-ai`.
- **Backup RPC:** `ARC_RPC_FALLBACK_URL` (the owner's Alchemy URL, key included) is set in both
  Vercel projects (sensitive) and used only when `rpc.mainnet.arc.io` fails. Never in the repo
  and never sent to a browser: pages reach it through each site's read-only `/api/rpc` relay
  (`api/rpc.mjs`, `pad-web/app/api/rpc/route.ts`). The buy bot and treasury script read the same
  name from GitHub Actions secrets, which the owner sets.
- **Vercel plan: Pro** (checked 2026-09-26). Every push rebuilds the pad (build minutes cost real
  money), so batch pushes.
- **Unstaking can pay up to 4 wallets** (owner, 2026-09-26): the staking page's "Send to other
  wallets" splits what's unstaked by percentage (the contract's `withdraw` with 1-4 recipients);
  rewards and the NFT always go back to the staker.
- **Staking an NFT boosts the stake**, by the Collectible design's tier
  (`nft/staking-boosts.json`: og/rare/epic/legendary +10/20/30/50%, placeholders until
  the owner decides). The owner can change them until `lockBoosts()`.
- **SDOGE Studio minting is fully open, no review** (only encoding checks).
- **Images are made with Venice, not Adobe.** The Venice API key never goes in the
  repo.
- **Secrets never go in the repo:** private keys, `WALLET_MASTER_SECRET`, storage
  tokens, real `.env` files. `tgpad/data/` is private (gitignored). Sign deploys with
  keystores, never a plaintext key in `.env`.
- **Audits:** "repeat till a clean pass". Multi-agent audit rounds until no confirmed
  critical/high/medium finding remains. Rounds 1 and 2 are fixed; round 3 was
  running on 2026-09-25 (37 findings so far, all low/info). Confirmed findings get
  fixed and tested before the next round. SDOGE Pad (`pad/`, `pad-web/`) joins the
  next round.

## SDOGE Pad (`pad/`, `pad-web/`, `pad-indexer/`)

The SDOGE token launchpad: every launch is a real Uniswap v4 pool, 1B supply,
creator-set tax 0–10% per side.

- **Every launch pairs with USDC.** That's how the contracts work; not up for debate.
- **Platform cut:** 10% of each launch's revenue (creator keeps 90%) goes to
  `SdogePadTreasury`, owned by `0x5899…5914` (owner's choice, 2026-09-25).
- **Pad admin** (the hook's permanent bootstrapper, which switches the pad on and
  decides the white-label slot) is the same wallet.
- **Build setting:** `pad/foundry.toml` keeps the metadata hash on
  (`bytecode_hash = "ipfs"`), so Sourcify and the explorer match this repo's exact
  sources and contract names. Don't switch it back to `none`.
- **Look:** the owner's mockup `pad-web/design/mockup-home.jpg` is the design spec
  (sent 2026-09-25): near-black navy, electric USDC blue, doge gold, violet Arc
  glow, and the "SDOGE LAUNCHPAD" name on the site. The art was redrawn from it
  with Venice (`pad-web/design/generate-art.py`). Keep numbers on the site real:
  where the mockup shows sample data, the site shows chain/DexScreener/indexer
  data or "—". "Staking" in its nav shows "soon" until the owner opens staking.
- **Deployed 2026-09-25 on Arc mainnet** (source verified on Sourcify, exact
  match): treasury `0x5B2A7f99b3Bd79211b2154dC997f2F8c3CAaF3Aa`, hook
  `0x10dE365Cc583bA953a9e6C36658A138082d9e8cc`, portal
  `0x7F80b1198e6DAa56b0019Cb45020382358E385Fd` (block 22720736, which is also the
  site's, the indexer's and the SDK's `portalGenesisBlock`). Record:
  `pad/deployments/arc-mainnet.json`.
- **Switched on** 2026-09-25 by `0x5899…5914` (block 22740029). The pad is live.
- **Deploy wallet:** the owner was driving, so an agent-made throwaway wallet
  `0xfA8CaC2eDb8d25508F65C7bF2e81674be210aE40` (funded by the owner; key only in that
  session's scratchpad) ran `DeploySdogePad.s.sol` with `TREASURY_OWNER` =
  `PAD_ADMIN` = `0x5899…5914`. It keeps no power; its leftover USDC went back to
  `0x5899…5914`.
- **Test token:** "Stable Doge", ticker `TEST` (owner's request, 2026-09-25), so the
  community can see the pad being tested: `0x35fdf2d0c42BDd435e2669DB4407351ee332E4C0`
  (block 22740076, 3%/3% tax, $1,000 opening cap, source verified on Sourcify). A
  0.25 USDC buy and sell-back went through on mainnet. A second test, "Stable Doge
  Pad" (`TEST`, `0xB480fADcdf58464951B98EE81F0566135Ab5da8E`), opened at a $1B market
  cap (owner's request): DexScreener showed $1.01B market cap and $1.01B liquidity,
  and GoPlus flagged nothing on its first scan. A third, "SDOGE Pad" (`TEST`,
  `0x18Dd0394eaf530B4C7D65eD3Bce68E1186e54ED4`), also opened at $1B. For all three, the creator role is
  offered to `0x5899…5914`, which accepts it with the "Accept the creator role"
  button on the token's page.
- **Liquidity is the starting market cap** (owner asked, 2026-09-25): the whole
  supply starts in the pool, so the liquidity DexScreener and the token page show
  equals the opening market cap, like pump.fun's virtual reserves. A separate,
  lower liquidity figure would need most of the supply outside the pool (a
  creator bag), which is the rug pattern scanners flag, so the pad doesn't offer it.
  The create page offers a starting market cap (= starting liquidity) from $100 to
  $1M (owner, 2026-09-25); the contract itself accepts up to $1T.
- **Scanners read source from the explorer.** Arc's explorer only shows a contract's
  verified source after someone asks for it, and Quick Intel flagged a TEST token
  ("suspicious functions") that it scanned before that. Every launch token has the
  same code as a Sourcify-verified one, so visitors' browsers ask the explorer for
  each token the sites show, once per visit: right after a launch, on token pages,
  on the pad's home and explore lists, and in stabledoge.site's market bar
  (`pad-web/lib/explorerSource.ts`, `assets/js/pad-ticker.js`). The explorer's API
  turns servers away (Cloudflare), and faking a browser to get past that is off
  limits, so it can't run from the pad's server.
  One splitter and one locker are verified on Sourcify too; other launches' splitters
  and lockers carry different built-in addresses, so each needs its own verification.
- **No fake volume** (2026-09-25): don't run wash trades to pump a token's volume.
  Small, disclosed test trades from the deploy wallet are fine.
- **Hosting:** Vercel project `sdoge-launchpad` (root `pad-web`) deploys from this
  branch. Its only storage is its own private Vercel Blob store (token info,
  images, a snapshot of the launch list); everything is served through the
  site's routes. **Don't put SDOGE in the owner's shared Neon project**: other
  projects use it (owner, 2026-09-25).
- **Traders and bots welcome** (owner, 2026-09-25): no sniper protection, no max
  buy, no cooldowns, ever. The public JSON API (`/api/v1/*`, CORS open, no key)
  and the TypeScript SDK (`pad-sdk/`) exist for bots; keep both working and
  documented on the site's Docs page.
- **Wallet warnings** (owner, 2026-09-25): trades approve the exact amount they
  spend, never unlimited, and the router's Permit2 allowance expires after a day
  (the SDK does the same by default; `approvals: 'unlimited'` is opt-in for bots).
  Every trade, flush, harvest, claim, launch and the switch-on is first simulated
  against Arc, so a call that would fail never reaches the wallet. GoPlus's free
  transaction-simulation API only covers Ethereum, BSC and Base (checked
  2026-09-25), not Arc, so the pad does that check itself.
  Token pages show GoPlus's free token scan (`/api/goplus`, cached 5 min). GoPlus
  marks every token on an Arc v4 hook pool as a honeypot, $SDOGE included; the
  panel says so. Report that false positive to GoPlus once a launch has real sells.
- **Phone wallets:** `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (Vercel only, not in
  the repo) holds the owner's Reown project ID (owner's choice, 2026-09-25). That
  turns on RainbowKit's full list (MetaMask, Coinbase, Rainbow, Trust, OKX,
  WalletConnect) with deep links into phone wallet apps. The project's allowlist
  in the Reown dashboard must include the pad's domains. Without an ID, only the
  wallet built into the browser can connect, and phone browsers get an "open in
  your wallet app" list instead.
- **Main site:** the nav has a **Pad** link (the word "Pad", not "Launchpad") to
  the pad site, and a live market bar across the top shows pad launches
  (`assets/js/pad-ticker.js`, fed by `/api/v1/market`). The pad home shows the
  dev wallet's and the treasury's balances so anyone can see what's in them.
- **Still needed:** `0x5899…5914` accepting the three TEST creator roles; publishing
  `pad-sdk` to npm (needs the owner's account). Optional: host `pad-indexer`
  (volume, holders and candles on token pages show "—" until it runs).
- **Domain:** the pad lives at https://pad.stabledoge.site (GoDaddy CNAME `pad` →
  `cname.vercel-dns.com`, added by the owner 2026-09-25; `stabledoge.site` itself is
  on Vercel with GoDaddy DNS). https://sdoge-launchpad.vercel.app serves the same
  site. The main site's links, the ticker (`PAD_URL`), the SDK's `apiUrl` and the
  pad's `NEXT_PUBLIC_SITE_URL` all use the `pad.` address.
- White-label factory: slot left open; its contracts are newer than the last audit.

## Other parts

- `contracts/` (Hardhat): staking, NFT collection, SDOGE Studio, marketplace.
  Not deployed yet; runbook in `contracts/README.md`.
- `launchpad/` (Foundry): the earlier meme launchpad with the meme vault.
  `tgpad/`: the Telegram bot for it. The owner may later point the Telegram
  launchpad at SDOGE Pad instead.
- `bot/`: the Telegram buy-alert bot (live in the Stable Doge group).
- CI (`.github/workflows/ci.yml`) runs every suite on each push. Tests at last
  count: Hardhat 262, Studio AI server 16 (`npm test` at the root), launchpad Foundry 65, tgpad 141,
  SDOGE Pad 36 (+1 fork test).
