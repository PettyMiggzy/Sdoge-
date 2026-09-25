# Site design

`ui-reference/` holds the owner's mockups, the design spec for the main site's pages:

- `staking-page-mockup.jpg`: the Staking page (`staking.html`). Built: hero with the 3D
  "SDOGE STAKING" logo, a stat bar (Total Staked, Est. APR, Stakers, Rewards Distributed), the
  stake/unstake card with quick-percent buttons, "Your Staking Overview", a 4-card "Why stake"
  row, and the FAQ over the "Stake Earn Chill" scene.
- `nft-page-mockup.jpg`: a new NFT page. Not built yet. It uses rarity tiers (OG/Rare/Epic/
  Legendary), which `nft/designs.json` now has, and numbered editions (#001, #042...), which
  `SDOGECollectibles.sol` doesn't: it sells a named roster of designs.
- `nft-collection-poster.jpg`: a poster for social posts, not a page layout.

## Art

The page art in `../assets/img/` is made from the mockups with Venice (not Adobe): each art region
is cropped out of a mockup and redrawn clean at 2K by Venice's image-edit API, same style, without
the mockup's text and buttons. `generate-art.py` does that and converts the results to the web
files; run it again to redo any piece:

```
VENICE_API_KEY=... python3 design/generate-art.py staking-hero
```

The key comes from the environment only and never goes in the repo. Raw outputs land in
`design/out/` (gitignored).

| File | Where it's used |
|---|---|
| `staking/hero.webp` | Staking hero background |
| `staking/logo-staking.webp` | The "SDOGE STAKING" title |
| `staking/chill.webp` | The scene behind the staking FAQ |
| `staking/social-share.jpg` | Staking link previews |
| `wordmark.webp` | The SDOGE wordmark in the staking nav (the logo's top line) |
| `arc-mark.png` | The Arc arch next to "ARC" in the nav |

Where the mockup shows made-up numbers, the page shows real ones from the staking contract, and
the $SDOGE price from DexScreener for the USDC part of the APR, or "—" before launch. The mockup's
"Flexible" lock and "Flexible staking" card became the real lock picker (7 to 365 days) and the
page's actual features: SDOGE and USDC rewards, penalties that stay with stakers, NFT boosts.
