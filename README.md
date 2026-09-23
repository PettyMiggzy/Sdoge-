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

- `index.html` — single-page site (hero, tokenomics, treasury, how-to-buy, chart, FAQ)
- `assets/css/style.css` — all styling
- `assets/js/main.js` — nav toggle, FAQ accordion, copy-address button
- `assets/img/` — logo + hero banner artwork

## Still placeholder — fill in before launch

- **Contract address** (`#contractAddress` in `index.html`) — currently "TBA",
  wired to refuse copying until replaced with the real deployed address.
- **Social links** (footer) — X/Telegram currently point at `#`.
- **Chart embed** (`#chart`) — placeholder panel; drop in a Dexscreener/Argus
  iframe once the pool is live.
- **Treasury dashboard** (`#treasury`) — UI is wired with empty (`—`) states;
  needs a data source (contract reads) once the Treasury contract is deployed.
- **Wallet connect / redeem button** — currently `disabled`; needs real wallet
  connect + contract call once the Treasury contract exists.

## Note on copy

Tokenomics language intentionally describes the Treasury as auto-compounding
NAV rather than "yield distribution," and avoids guaranteed-return claims
("can't go to zero" is flagged as a tagline, not a promise, in the FAQ) —
get this reviewed by a securities lawyer before real funds are solicited.
