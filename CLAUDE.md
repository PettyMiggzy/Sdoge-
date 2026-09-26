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
- **One nav, every page, everything linked** (owner, 2026-09-26: "link all now"; this lifts the
  earlier hidden-pages rule). Home, About, Tokenomics, Staking, NFT, Studio, Pad, Roadmap,
  Community, the ARC badge and Buy SDOGE, identical on every page (`assets/css/nav.css`; only the
  `is-active` link differs). The pad's nav links the same products (Staking, NFT, Studio).
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
  Studio AI stays closed if they can't run. Adult content of adults is allowed, behind an "I'm 18
  or older" button (owner, 2026-09-26); the 18+ button never unlocks the two hard blocks. `VENICE_API_KEY` lives only in the `sdoge` Vercel
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
  (`nft/staking-boosts.json`: og/rare/epic/legendary +10/20/30/50%). The owner confirmed
  these boosts and the $20/$30/$40/$50 mint prices on 2026-09-26. The owner can change
  boosts until `lockBoosts()`, and a design's price while its sale is closed.
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
  data or "—". Its nav links the main site's Staking, NFT and Studio pages.
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
- **Still needed:** publishing `pad-sdk` to npm (needs the owner's account).
  Optional: host `pad-indexer` (volume, holders and candles on token pages show "—"
  until it runs). The three TEST tokens' creator roles stay unclaimed: the owner
  doesn't need them (2026-09-26), so don't remind them.
- **Domain:** the pad lives at https://pad.stabledoge.site (GoDaddy CNAME `pad` →
  `cname.vercel-dns.com`, added by the owner 2026-09-25; `stabledoge.site` itself is
  on Vercel with GoDaddy DNS). https://sdoge-launchpad.vercel.app serves the same
  site. The main site's links, the ticker (`PAD_URL`), the SDK's `apiUrl` and the
  pad's `NEXT_PUBLIC_SITE_URL` all use the `pad.` address.
- White-label factory: slot left open; its contracts are newer than the last audit.

## Other parts

- `contracts/` (Hardhat): staking, NFT collection, SDOGE Studio, marketplace.
  Runbook in `contracts/README.md`. **Deployed on Arc mainnet 2026-09-26**
  (record `contracts/deployments/arc.json`, the site reads them from
  `assets/js/arc.js`):
  - SDOGECollectibles `0x400A80B98CDF6999bE92A002799adBEE6807d9b5`
  - SDOGEStaking `0x320a128A7cf45804a8Af15FE786AAD9d1eA401f6`
  - SDOGEStudio `0x7A99AE8d0E808a850342a73303748E7326BA317c` (Community Art
    `0xd5092ffBfDc1Afd541fa72787B42A7E95BEb48Db`)
  - SDOGENFTMarketplace `0xC36154c5d7038A419CF3E8802Bf41B08B0e1BF6a`

  All 12 designs open for mint. Source verified on Sourcify (exact match, all 4 plus the
  Studio's collection template `0x9d56156689F7684D275Eb34F5604f8E05D193D95`;
  `scripts/verify-sourcify.js`). Tested on the live site with real transactions
  (stake, split unstake to 2 wallets, early exit, Studio 1-of-1, marketplace sale).
  `0x5899…5914` accepted all 4 on `owner.html` (2026-09-26): the deploy wallet has
  no power left, and its leftovers went back to `0x5899…5914`. Still up to the owner
  (owner.html walks it): the seed stake (365-day tier), then starting rewards,
  then routing Studio sales and marketplace fees to staking. Until then all of that
  revenue goes to `0x5899…5914`. 15,000 SDOGE of early-exit penalties from the
  launch test wait in the pool and stream to stakers once rewards start.
- **Phishing drain (2026-09-26):** a fake website got `0x5899…5914` to confirm a transfer of
  115.34 USDC (all but 0.031125) to the drainer Safe `0x9245635eBcAD64db53eC189B0ED984151a0a8247`
  (tx `0x1d224631…cdbd05`); the same kit drained two other wallets that morning. The owner
  confirmed it was a fake site, so the key is fine and the owner keeps the wallet. It had an old
  unlimited USDC approval to Permit2; `owner.html` now has a "Wallet safety" card that lists
  USDC/SDOGE approvals to swap apps with a Remove button. Never tell the owner to connect or
  sign anywhere but the project's own sites; DexScreener info is ordered from DexScreener itself.
- **Site wallet rule:** pages build their `BrowserProvider` on
  `arcWalletBridge(window.ethereum)` (`assets/js/arc.js`), never on `window.ethereum`
  directly: the wallet only signs and sends, and every read (block number, gas
  estimate, receipts) goes through the site's own paced, retried RPC with the backup
  relay. The owner's first stake failed with "could not coalesce error" when the
  wallet's own Arc RPC hiccuped (2026-09-26). Error alerts use `arcErrorText`, which
  shows what the wallet actually said. Unstaking never depends on the site: the
  staking FAQ links the contract's Write tab on the explorer.

  Treasury and fee recipient: `0x5899…5914`. There's no Safe, so the launch is
  supervised (owner said go live, 2026-09-26): a throwaway deploy wallet
  `0x91dD28FDCc337eEf15238d0Faa256e994b727D11` (funded by the owner; key only in
  that session's scratchpad) deployed with `ALLOW_DEPLOYER_OWNER=1`, sent the setup
  batches itself (`scripts/run-batch.js`), then offers all 4 contracts to
  `0x5899…5914` (`scripts/handover.js`). The owner accepts on `owner.html` (not in
  the nav, noindex), which also walks the seed stake → start rewards → route
  revenue steps in that order. Leftovers go back to `0x5899…5914`.
- `launchpad/` (Foundry): the earlier meme launchpad with the meme vault.
  `tgpad/`: the Telegram bot for it. The owner may later point the Telegram
  launchpad at SDOGE Pad instead.
- `bot/`: the Telegram buy-alert bot (live in the Stable Doge group).
- CI (`.github/workflows/ci.yml`) runs every suite on each push. Tests at last
  count: Hardhat 270, Studio AI server 16 (`npm test` at the root), launchpad Foundry 65, tgpad 141,
  SDOGE Pad 36 (+1 fork test).
