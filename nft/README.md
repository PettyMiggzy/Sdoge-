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

## Assets

Generated art/metadata will go under `nft/assets/` once this starts -
that path is already `.gitignore`d so a full collection's worth of images
doesn't bloat the repo.
