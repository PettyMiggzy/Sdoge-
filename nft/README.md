# $SDOGE NFT Collection (planned, not started)

Concept notes, captured so this isn't lost before work actually starts.
Explicitly deferred — staking (see `../contracts/`) comes first.

## Concept

A Doge-collection: multiple Doge variants/memes (e.g. Doge 1 / "Space
Doge") and Elon Musk-themed pieces, given Elon's association with
Dogecoin/doge memes. Exact lineup/count not decided yet.

## How it'd connect to staking

From the original idea: holding an NFT would amplify a staker's rewards
(some kind of multiplier), and some portion of NFT sale proceeds would
feed into the staking reward pool alongside the early-withdrawal-penalty
mechanism already built.

## Open questions before this starts

- Art generation: no image-gen API key (e.g. Venice) is configured in
  this environment yet. Rough ballpark only (e.g. ~$0.05/image × 100
  images ≈ $5) — actual cost depends on the specific model/resolution
  used, not yet confirmed.
- Collection size, rarity tiers, and the exact staking-boost mechanic are
  all undecided.
- Mint mechanism (fixed price? bonding curve? which chain/marketplace on
  Arc, if any exists yet?) not researched.

## Reference art

`nft/reference/` holds 5 example character pieces (tracked in git, unlike
`nft/assets/` below - these are deliberate, curated art, not disposable
bulk output):

- `swat-doge.jpg` - grey/silver doge, SWAT helmet and vest
- `astronaut-doge.jpg` - orange/tan doge, space suit, USDC-branded patches
  (matches the earlier "Space Doge" mention)
- `bucket-hat-doge.jpg` - orange/tan doge, USDC-branded bucket hat and
  fanny pack
- `rich-doge.jpg` - grey/silver doge, gold chain, grillz, USDC medallion
- `hoodie-doge.jpg` - orange/tan doge, blue hoodie and cap, USDC branding

Two distinct base characters appear across these (a grey/silver husky-style
doge and an orange/tan shiba-style doge), each restyled per piece rather
than one base with swappable trait layers - suggests this collection is
shaping up as a roster of named/themed Doge characters (SWAT Doge, Space
Doge, etc.) rather than a generative trait-combination collection. Worth
confirming before deciding on a mint mechanism, since the two approaches
need very different tooling (a fixed small set of hand-finished pieces vs.
a generator combining trait layers into many unique combinations).

USDC branding appears in 4 of the 5 pieces - fits the project's whole
premise ($SDOGE paired with/backed by USDC) and gives the collection a
consistent visual identity tying back to the main token.

## Bulk-generated assets

If this becomes a generative collection later, that output goes under
`nft/assets/` - already `.gitignore`d so a full collection's worth of
images doesn't bloat the repo. Not used yet.
