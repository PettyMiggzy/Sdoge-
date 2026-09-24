# $SDOGE NFTs

Three things, all on Arc and all priced in native USDC (18 decimals):

1. **The Collection** (`SDOGECollectibles.sol`): 12 named Doge designs, each with its own
   capped supply.
2. **SDOGE Studio** (`SDOGEStudio.sol` + `SDOGEStudioCollection.sol`): mint your own NFTs.
   Individuals mint 1-of-1s; projects launch whole collections.
3. **The Marketplace** (`SDOGENFTMarketplace.sol`): escrowed resale of all of the above.
   Its fee goes to $SDOGE stakers and royalties go to creators.

The pages are `nft.html` (collection + marketplace) and `studio.html`. Neither is linked from
the home page yet. The contracts, deploy runbook and test counts are in
`../contracts/README.md`.

## The Collection: SDOGECollectibles

ERC-1155: each design is one token id that can be minted many times, up to its cap.

- **Setup.**
  - `createDesign(expectedId, name, maxSupply, priceWei, reserved)` must be called in id order,
    so a stray or repeated call can't shift the roster.
  - Every design starts **closed**; `setPublicMint(id, true)` opens it after it's been checked.
  - `scripts/setup-designs.js` builds both Safe batches from `nft/designs.json` and checks
    every on-chain design against it before writing the "open" batch.
- **Minting.**
  - `mint(id, amount)` takes exactly price x amount. A price-0 design can never be minted
    publicly, and prices must be at least 0.01 USDC, in whole micro-USDC.
  - `reserved` copies are for team and giveaway mints (`ownerMint`, `ownerMintBatch`, which
    skips recipients that can't take the NFT instead of failing). The reserve can only be
    released to the public, never grown.
- **Supply and metadata.**
  - A cap can be raised until `lockSupply(id)`. New designs can be added until
    `lockCollection()`.
  - `setURI` emits ERC-4906 so marketplaces refresh; `freezeMetadata()` makes it permanent.
- **Revenue.** `withdraw()` (anyone can call it) sends revenue to `treasury`.

## SDOGE Studio: mint your own

**Credits.** One credit mints one NFT. Credits are sold in packages. These are the launch
defaults in `nft/studio.json`; the owner can add or change packages at any time:

| Package | Mints | USDC | Per mint | Or burn SDOGE |
|---|---|---|---|---|
| Single | 1 | 5 | 5.00 | 1,000,000 |
| Starter | 10 | 20 | 2.00 | - |
| Creator | 100 | 50 | 0.50 | - |
| Project | 1,000 | 100 | 0.10 | - |

- **Buying.**
  - `buyCredits(id, expectedMints, to)` takes exactly the USDC price.
  - `buyCreditsWithSdoge(id, expectedMints, maxSdoge, to)` burns the SDOGE price to 0x…dEaD.
  - `expectedMints` and `maxSdoge` mean a package change landing first can't shortchange you.
  - Credits can be bought for any wallet. They can't be transferred or refunded; they only mint.
  - The owner can `grantCredits` (giveaways, partner projects).
- **Revenue.** `withdraw()` (anyone can call it) sends `poolShareBps` of the USDC to the
  staking reward pool (`contributeUSDC`) and the rest to the treasury. The launch config is 50%.

**Community Art (individuals).** `mintCommunity(uri)` spends one credit and mints a 1-of-1 into
the shared SDOGE Community Art collection.
- This replaces the old SDOGECommunityMint: its 1,000,000 SDOGE burn per mint lives on as the
  Single package's SDOGE price.
- Minting is fully open, with no review, filter or takedown.
- A token's URI is set once and never changes, and nobody (the team included) can move or
  change it.
- `studio.html` builds the metadata (name, description, image link) into an on-chain `data:`
  URI, so creators only have to host the image.

**Creator collections (projects).** `createCollection(name, symbol, maxSupply, royaltyReceiver,
royaltyBps, contractURI)` deploys the project's own ERC-721 (a minimal clone), owned by its
creator. Every token minted costs the owner one credit:

- **Owner mints.**
  - `mintBatch(to, n)`: up to 200 per call, using the base URI.
  - `mintWithURIs(to, uris)`: up to 100 per call, each token with its own permanent URI.
  - `airdrop(addresses)`: up to 200 per call.
  - Owner mints skip the receiver check, so one bad address can't block an airdrop.
- **Public drop.**
  - `setDrop(price, perWallet, start, end)`, then `setDropOpen(true)`. It needs a base URI.
  - Collectors call `publicMint(1-20)` and pay exactly the drop price, which goes to the
    creator's `payout` via `withdraw()`.
  - Each mint also uses one of the owner's credits, so a drop pauses when the creator runs out.
  - The creator keeps 100% of the sale.
- **Holder protections.**
  - The supply cap can be set once and then only lowered.
  - The base URI can change until `freezeMetadata()`.
  - Royalties are capped at 10% (ERC-2981, paid by the SDOGE marketplace).
- **Ownership** is two-step. After the new owner accepts, their credits pay for mints.
- **Verified badge.** The owner can mark real projects Verified (`setVerified`). The site labels
  everything else "unverified creator collection" and escapes the names, since anyone can create
  a collection called anything.

Gas on Arc: creating a collection costs about 450k gas, `mintBatch(200)` about 5.1M,
`mintWithURIs(100)` about 13.6M (of a 30M block) and `publicMint(20)` about 0.6M.

## The Marketplace

- **Escrow.** Listing moves the NFT into the marketplace, cancelling moves it back, and buying
  moves it to the buyer. A listing can never go stale, be duplicated, or promise copies the
  seller no longer has.
- **Accepted collections.**
  - ERC-1155: only SDOGECollectibles.
  - ERC-721: only collections the Studio's registry says it created (Community Art and every
    creator collection).
  - All of those are clones of one contract, so a listed NFT always really transfers.
- **Money.**
  - The fee is 2% (never more than the rate when listed; capped at 10%) and goes to the staking
    pool once `setRewardsPool` points there.
  - The creator royalty is also never more than the rate when listed.
  - Seller and royalty payments that fail wait in `proceeds` for withdrawal; a sale can't be
    blocked.
- **Pause** stops listing and buying; cancelling and withdrawing always work.
- **The page:**
  - Shows only SDOGE collections, and every row shows the seller and contract.
  - Re-reads a listing's price before buying.
  - Lets sellers cancel or reprice from the Mine tab.
  - Shows waiting proceeds with a Withdraw button.

## How it connects to staking

- **NFT profits fund the USDC side of staking: built.**
  - Marketplace fees and the Studio's `poolShareBps` go straight to `SDOGEStaking.contributeUSDC()`.
  - Collectibles revenue goes to the treasury, and the team can add it with `contributeUSDC()`.
- **Holding an NFT boosts staking rewards: not built,** and no longer claimed on the site. If
  it's ever built, it should only count NFTs escrowed in the staking contract, not a
  `balanceOf` snapshot, which one NFT passed between wallets could game.

## Reference art and metadata

`nft/reference/` holds all 12 finished character pieces (tracked in git,
unlike `nft/assets/` below); `nft/metadata/{1-12}.json` are their
ERC-1155 metadata files (standard `name`/`description`/`image`/
`attributes` shape), matching the design-ID order they're expected to be
created in:

| ID | File | Character | Outfit | Background | USDC branding |
|---|---|---|---|---|---|
| 1 | `swat-doge.jpg` | Husky | SWAT gear | Orange | No |
| 2 | `astronaut-doge.jpg` | Shiba | Space suit | Blue | Yes |
| 3 | `bucket-hat-doge.jpg` | Shiba | Hoodie & fanny pack | Purple | Yes |
| 4 | `rich-doge.jpg` | Husky | Gold chain, grillz | Orange | Yes |
| 5 | `hoodie-doge.jpg` | Shiba | Blue hoodie | Grey | Yes |
| 6 | `cap-doge.jpg` | Shiba | None (plain) | Blue | Yes |
| 7 | `blazed-doge.jpg` | Shiba | None (plain) | Orange | Yes |
| 8 | `degen-doge.jpg` | Shiba | Gold chain (DEGEN + USDC pendants) | Orange | Yes |
| 9 | `samurai-doge.png` | Shiba | Samurai armor | Red | Yes |
| 10 | `viking-doge.png` | Husky | Fur cloak & horned helmet | Icy Blue | Yes |
| 11 | `cyberpunk-doge.png` | Shiba | Neon-trimmed jacket | Black (neon glow) | Yes |
| 12 | `champion-doge.png` | Shiba | Boxing gloves & belt | Gold | Yes |

`blazed-doge` reuses `cap-doge`'s cap/outfit/character but adds bloodshot
eyes and a dazed open mouth - the classic "stoned" meme expression - as
its distinguishing trait, tracked as its own `Expression` attribute rather
than folded into `Outfit`. `degen-doge` is the shiba counterpart to
`rich-doge`'s husky (same gold-chain-and-grillz idea), distinguished by a
cigar, black sunglasses instead of pink, and an added "DEGEN" pendant
alongside the USDC one.

The `image` field in each metadata file is a placeholder
(`ipfs://REPLACE_ME/...`) - these haven't been pinned to permanent
storage yet. Do that (nft.storage, Pinata, or similar) and update all 12
files before deploying for real; a metadata `image` pointing at nothing
is a broken collection the moment someone opens it in a wallet.

Two base characters run through the full-outfit designs (a grey/silver
husky, an orange/tan shiba); `cap-doge` and `blazed-doge` are noticeably
plainer than the rest, which could hint at a rarity structure (plain =
common, full costume = rare) - not confirmed, just noted as a real
possibility.

## Designs 9-12: generated with Venice's API

Designs 1-8 came from elsewhere; 9-12 (Samurai, Viking, Cyberpunk,
Champion) were generated directly with Venice's image API
(`api.venice.ai/api/v1/image/generate`, `gpt-image-2` model) once an API
key was provided, using the style guide below distilled from the first 8.
The key itself was kept out of the git repo entirely (a session-local
scratchpad file, never committed) - it needs to go into a real secret
store (GitHub Actions secrets, most likely) if this needs to run
automatically later rather than by hand.

One quirk worth recording: `gpt-image-2` returned 1024x768 regardless of
the `width`/`height: 1024` requested in the API call (that model appears
to ignore those fields in favor of its own default aspect ratio) - fixed
by center-cropping to a 768x768 square with Pillow after the fact, to
match the square format of designs 1-8. Worth re-checking against
Venice's docs for a model/parameter that produces square output natively
if more designs get generated later, rather than continuing to crop.

**Style guide**, reverse-engineered from designs 1-8 and reused for 9-12:
flat cel-shaded/vector cartoon illustration, thick black outlines,
head-and-shoulders bust portrait, chibi-proportioned doge face with a
smug/confident half-smile (often one raised eyebrow) and pink blush marks
on the cheeks, solid single-color background (no gradient, no scene
detail), a Circle USDC "($)" logo worked into the outfit as a
patch/badge/print. Alternates between the orange/tan shiba base and the
grey/silver husky base.

## Open questions

- Final mint price and supply per design (`nft/designs.json` holds the $20-$50 placeholders).
- Where the art and metadata get pinned (IPFS is assumed by the deploy script's checks).
- The Studio's SDOGE prices beyond the Single package, and the final `poolShareBps`.

## Bulk-generated assets

If this becomes a generative trait-combination collection later (as
opposed to this fixed 12-design roster), that output goes under
`nft/assets/` - already `.gitignore`d so a full collection's worth of
images doesn't bloat the repo. Not used yet, and not the current plan.
