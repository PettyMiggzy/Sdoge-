# $SDOGE — The Stable Doge

Marketing site for $SDOGE, a fixed-supply meme token on Arc with a USDC-backed
treasury (60% of the 1% trade tax → Treasury reserve, 40% → buyback into the
same Treasury). No yield strategy right now — the Treasury just holds plain
USDC. A yield-bearing upgrade (e.g. Circle's USYC) is framed as a possible
future roadmap item, not a current feature.

**Launched.** Contract: `0xf8df98fda14cabb2e8b6efe920081ffcbb0bb405` (Arc).

How the tax actually flows today: the launch platform's fee splitter
(`0xddab…8980`, a contract) pays the creator wallet 90% and the platform 10%.
The 60/40 Treasury/buyback split is how the team handles its share by hand.
Nothing on-chain enforces it yet, and there is no Treasury or burn-to-redeem
contract yet. `index.html` describes both as if they were live or coming, so
review that copy before promoting it.

## Run locally

Static site, no build step:

```bash
python3 -m http.server 8811
# open http://localhost:8811
```

## Structure

- `index.html` — single-page site (hero, highlights, about, community, tokenomics/treasury/contract, roadmap, how-to-buy, FAQ)
- `staking.html`, `nft.html`, `studio.html` — staking, the NFT collection and
  marketplace, and SDOGE Studio (mint your own). Built, but deliberately not
  linked from `index.html` yet; they show a preview until the contracts are
  deployed.
- `assets/css/style.css` — all styling
- `assets/js/main.js` — nav toggle, FAQ accordion, copy-address button
- `assets/js/arc.js` — Arc chain helpers, and `SDOGE_CONTRACTS`, the one
  place the deployed addresses live (filled in by
  `contracts/scripts/sync-frontend.js`)
- `assets/js/wallet.js`, `staking.js`, `nft.js`, `marketplace.js`,
  `studio.js` — the app pages' logic (tested against the real contracts in
  `contracts/test/frontend.test.js`)
- `contracts/` — staking, the NFT collection, SDOGE Studio and the
  marketplace (Hardhat; see `contracts/README.md` for the deploy runbook)
- `nft/` — the 12 designs' art, metadata and manifests (`designs.json`,
  `studio.json`); see `nft/README.md`
- `launchpad/` — the Uniswap v4 meme launchpad with the meme vault (Foundry)
- `tgpad/` — the Telegram bot for the launchpad
- `assets/img/` — logo, hero/community/CTA artwork, social share image,
  card/chart icons. `hero-space.jpg`, `moon-buggy.jpg`, `signpost-pool.jpg`,
  and the four `icon-*.jpg` badges were AI-generated via the Venice API
  using the existing art as a style reference, to match the character
  design consistently; `logo.jpg` and `social-share.jpg` were supplied
  directly. No stock emoji are used anywhere on the page.
- `bot/` + `.github/workflows/buy-bot.yml` — Telegram buy-alert bot, runs on
  a GitHub Actions cron (no server needed). Token/pool addresses are
  configured; only the Telegram bot token + chat ID are still needed to go
  live. See `bot/README.md`.
- `.github/workflows/ci.yml` — runs the contract, launchpad and tgpad test
  suites on every push and pull request.

## Still placeholder

- **Social links** (footer + community section) — Discord points at `#`;
  X (`x.com/stabledoge1`) and Telegram (`t.me/stabledoge1`) are live.
- **Chart embed** (`#chart`, inside How to Buy) — placeholder panel; drop in
  a Dexscreener/Argus iframe once the pool is live.
- **Treasury panel** (`#tokenomics`) — wired with empty (`—`) states; needs a
  data source (contract reads) once the Treasury contract is deployed.
- **og:image / twitter:image** — currently a relative path; must become an
  absolute production URL before the link preview will render on
  Telegram/X/Discord.

## Note on copy

Tokenomics language is deliberately plain: a USDC reserve that grows from
trade tax and shrinking supply, no yield claims, no "NAV" or investment-fund
language, and no guaranteed-return claims ("can't go to zero" is flagged as
a tagline, not a promise, in the FAQ). Still worth a securities-lawyer
read before real funds are solicited, but this framing is meaningfully
simpler than a yield-bearing-treasury story would be.
