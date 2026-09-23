# $SDOGE — The Stable Doge

Marketing site for $SDOGE, a fixed-supply meme token on Arc with a USDC-backed
treasury (60% of the 1% trade tax → Treasury reserve, 40% → buyback into the
same Treasury). No yield strategy right now — the Treasury just holds plain
USDC. A yield-bearing upgrade (e.g. Circle's USYC) is framed as a possible
future roadmap item, not a current feature.

**Launched.** Contract: `0xf8df98fda14cabb2e8b6efe920081ffcbb0bb405` (Arc).

## Run locally

Static site, no build step:

```bash
python3 -m http.server 8811
# open http://localhost:8811
```

## Structure

- `index.html` — single-page site (hero, highlights, about, community, tokenomics/treasury/contract, roadmap, how-to-buy, FAQ)
- `assets/css/style.css` — all styling
- `assets/js/main.js` — nav toggle, FAQ accordion, copy-address button
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
