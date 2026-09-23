# Site UI redesign - reference material

Not started yet - images (see `../nft/`) come first, per explicit
instruction. `ui-reference/` holds the target mockups for when this work
begins:

- `staking-page-mockup.jpg` - target design for the site's Staking page:
  hero with stat bar (Total Staked, Est. APR, Stakers, Rewards
  Distributed), a stake/unstake widget with quick-percent buttons, a
  "Your Staking Overview" panel, a 4-card "Why Stake" row, and an FAQ
  accordion.
- `nft-page-mockup.jpg` - target design for a new NFT page: hero, a
  4-icon feature row, a filterable collection grid (tabs: All/OG/Rare/
  Epic/Legendary) with numbered pieces and rarity tags, and a
  "Hold, Collect, Get Rewards" section.
- `nft-collection-poster.jpg` - a promotional poster-style graphic
  showing 8 collection pieces arranged around the wordmark - likely for
  social/marketing use rather than a page layout to replicate.

The mockups use rarity tiers (OG/Rare/Epic/Legendary) and numbered
editions (#001, #042, #420, etc.) that don't exist in the current
`SDOGECollectibles.sol` contract or `nft/metadata/` - that contract
prices/tiers by design (a named roster), not by individually-numbered
rarity-tagged mints. Reconciling those two models is unresolved and will
need a decision before this UI can be built as literally shown.
