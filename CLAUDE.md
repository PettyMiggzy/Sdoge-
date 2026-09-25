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
  from NFT profits.
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
- **Switch-on:** waiting on `0x5899…5914`, which calls `bootstrapMainPortal(portal)` on
  the hook (the site's unlinked `/admin` page, the explorer's Write tab, or `cast send`).
- **Deploy wallet:** the owner was driving, so an agent-made throwaway wallet
  `0xfA8CaC2eDb8d25508F65C7bF2e81674be210aE40` (funded by the owner; key only in that
  session's scratchpad) ran `DeploySdogePad.s.sol` with `TREASURY_OWNER` =
  `PAD_ADMIN` = `0x5899…5914`. It keeps no power; leftover gas USDC goes back to
  `0x5899…5914` once the test token is out.
- **Test token:** "Stable Doge", ticker `TEST` (owner's request, 2026-09-25), so the
  community can see the pad being tested. Launch it right after the switch-on, hand
  the creator role to `0x5899…5914` (`transferCreator`, then `acceptCreator` from
  that wallet), and verify it with `script/verify.sh` (`LAUNCH_TOKEN=`).
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
- **Phone wallets:** plain phone browsers need a WalletConnect (Reown) project ID
  in `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (Vercel), with the pad's domains on
  its allowlist. It must be SDOGE's own project: an ID is public in the site's
  code, so never reuse another project's. Without it, only the wallet built into
  the browser (e.g. MetaMask's own browser) can connect.
- **Main site:** the nav has a **Pad** link (the word "Pad", not "Launchpad") to
  the pad site, and a live market bar across the top shows pad launches
  (`assets/js/pad-ticker.js`, fed by `/api/v1/market`). The pad home shows the
  dev wallet's and the treasury's balances so anyone can see what's in them.
- **Still needed:** the switch-on, the test token, SDOGE's WalletConnect project ID,
  publishing `pad-sdk` to npm (needs the owner's account). Optional: host
  `pad-indexer`.
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
  count: Hardhat 232, launchpad Foundry 65, tgpad 141, SDOGE Pad 36 (+1 fork test).
