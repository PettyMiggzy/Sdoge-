# Design

`mockup-home.jpg` is the owner's mockup of the home page (2026-09-25) and the
design spec for the site: layout, colors (near-black navy, electric USDC blue,
doge gold, violet Arc glow), the art and the copy.

The site's art in `../public/brand/` was made from it with Venice (not Adobe):
each art region of the mockup was redrawn clean at 2K by Venice's image-edit
API, same style, without the mockup's text and buttons. `generate-art.py`
does that and converts the results to the web files; run it again to redo
any piece:

```
VENICE_API_KEY=... python3 design/generate-art.py hero
```

| File | Where it's used |
|---|---|
| `hero.webp` | Home hero background |
| `logo-launchpad.webp` | The "SDOGE LAUNCHPAD" title in the hero |
| `launch-rocket.webp` | "Launch your project on Arc" card |
| `relax.webp` | "How it works" |
| `footer-banner.webp` | "Good projects. Stronger together." banner |
| `social-share.jpg` | Link previews (hero art plus logo) |
| `arc-mark.png` | The Arc arch, recolored for dark backgrounds |
| `logo.jpg` | The SDOGE logo (nav, $SDOGE card, favicon source) |

Where the mockup shows made-up numbers, the site shows real ones: launch
counts and prices from the chain, $SDOGE from DexScreener, and volume or
holders only when the indexer is running ("—" otherwise). Launches have no
"upcoming" or "ended" state on-chain, so cards show Live or New, and empty
slots invite a launch instead of showing sample tokens. "Staking" in the nav
shows "soon" until the owner opens the staking page.
