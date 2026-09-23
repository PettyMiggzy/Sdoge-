# $SDOGE — The Stable Doge

Marketing site for $SDOGE, a fixed-supply meme token on Arc with a USYC-backed
treasury (60% of the 1% trade tax → Treasury reserve, 40% → buyback & burn).

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
- `assets/img/` — logo, hero/community/CTA artwork, social share image
  (`moon-buggy.jpg` and `signpost-pool.jpg` were AI-generated via the Venice
  API using the existing art as a style reference, to match the character
  design consistently; everything else was supplied directly)

## Still placeholder — fill in before launch

- **Contract address** (`#contractAddress` in `index.html`) — currently "TBA",
  wired to refuse copying until replaced with the real deployed address.
- **Social links** (footer + community section) — X/Discord point at `#`;
  Telegram is live (`t.me/stabledoge1`).
- **Chart embed** (`#chart`, inside How to Buy) — placeholder panel; drop in
  a Dexscreener/Argus iframe once the pool is live.
- **Treasury panel** (`#tokenomics`) — wired with empty (`—`) states; needs a
  data source (contract reads) once the Treasury contract is deployed.
- **og:image / twitter:image** — currently a relative path; must become an
  absolute production URL before the link preview will render on
  Telegram/X/Discord.

## Note on copy

Tokenomics language intentionally describes the Treasury as auto-compounding
NAV rather than "yield distribution," and avoids guaranteed-return claims
("can't go to zero" is flagged as a tagline, not a promise, in the FAQ) —
get this reviewed by a securities lawyer before real funds are solicited.
