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
  - `reserved` copies are for team and giveaway mints (`ownerMint`, `ownerMintBatch`). The
    reserve can only be released to the public, never grown, so set each design's reserve
    before the create batch (all 12 are 0 in `nft/designs.json` today).
  - `ownerMintBatch` gives each recipient a fixed 150,000-gas budget and skips one that can't
    take the NFT (no receiver hook, or a hook that needs more gas). The owner's own mistakes (a
    missing design, a zero amount or address, more than the reserve, too little gas for the
    next recipient) revert the whole batch instead of passing as skips.
- **Changing a design.** Its price, cap and reserve only change while its sale is closed, so a
  queued change can't land in front of buyers.
- **Supply and metadata.**
  - A cap can be raised until `lockSupply(id)`. New designs can be added until
    `lockCollection()`.
  - `setURI` only takes a folder URI (printable ASCII, no spaces, ending in "/") and emits
    ERC-4906 so marketplaces refresh. `freezeMetadata()` makes it permanent, and needs
    `lockCollection()` first so no design can be added after its folder is fixed.
  - The page shows whether each design's cap is locked.
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
- **Revenue.** Each USDC credit sale sets `poolShareBps` of its price aside for the staking
  reward pool at the moment of sale (`poolOwed`), so a later change of share or pool never
  touches it. `withdraw()` (anyone can call it) pays what's owed to the pool (`contributeUSDC`)
  and the rest to the treasury; if one of them can't take USDC, the other is still paid and the
  failed share waits for the next call. The launch config is 50%. The Studio also takes plain
  USDC transfers (for example Community Art's own `withdraw()`), which go to the treasury.

**Community Art (individuals).** `mintCommunity(uri)` spends one credit and mints a 1-of-1 into
the shared SDOGE Community Art collection.
- This replaces the old SDOGECommunityMint: its 1,000,000 SDOGE burn per mint lives on as the
  Single package's SDOGE price.
- Minting is fully open, with no review, filter or takedown.
- A token's URI is set once and never changes, and nobody (the team included) can move or
  change it. The Studio owner can only set the collection-level metadata
  (`setCommunityContractURI`), never a token's.
- `studio.html` builds the metadata (name, description, image link) into an on-chain `data:`
  URI, so creators only have to host the image.

**Creator collections (projects).** `createCollection(name, symbol, maxSupply, royaltyReceiver,
royaltyBps, contractURI)` deploys the project's own ERC-721 (a minimal clone), owned by its
creator. Every token minted costs the owner one credit:

- **Owner mints.**
  - `mintBatch(to, n)`: up to 200 per call, using the base URI.
  - `mintWithURIs(to, uris)`: up to 50 per call and 6,000 URI characters in all, each token
    with its own permanent URI.
  - `airdrop(addresses)`: up to 200 per call.
  - Owner mints skip the receiver check, so one bad address can't block an airdrop. The page
    refuses SDOGE's own contracts as recipients and asks before sending to any contract.
- **Public drop.**
  - `setDrop(price, perWallet, start, end)` saves the terms, then `setDropOpen(true)` opens it.
    Opening needs a base URI and saved terms, and a free drop needs a supply cap (an open paid
    drop without one can't be made free either).
  - Collectors call `publicMint(1-20)` and pay exactly the drop price, which goes to the
    creator's `payout` via `withdraw()`. The creator keeps 100% of the sale.
  - Each mint also uses one of the owner's credits, shared by all the owner's collections.
    Running out isn't a pause: anyone can add credits to the owner's wallet and minting goes on.
    Close the drop to stop it.
  - The per-wallet limit counts every public mint from the collection, across drops.
  - The page shows the saved terms (schedule included) in the form, asks before a save removes
    a start or end time or prices a mint below a credit, and opening confirms the saved terms.
- **Holder protections.**
  - The supply cap can be set once and then only lowered.
  - The base URI can change until `freezeMetadata()`, which needs a base URI first.
  - Royalties are capped at 10% (ERC-2981, paid by the SDOGE marketplace), and can't point at
    the collection itself or the Studio.
  - The drop page shows the owner, where sales go, and whether there's a cap and the metadata
    is frozen.
- **Ownership** is two-step. When the new owner accepts, the drop closes, and a payout or
  royalty that pointed at the old owner moves to the new one; from then on their credits pay.
  A collection you were handed can be managed from the Studio page by its address.
- **Verified badge.** The owner can mark real projects Verified (`setVerified`). The badge
  belongs to the collection's owner at that moment and lapses by itself if the collection
  changes hands. The site labels everything else "unverified creator collection" and escapes
  the names, since anyone can create a collection called anything.
- **Only the Studio can set up a collection.** A clone of the collection code made anywhere
  else can't be initialized.

Gas on Arc, where a transaction can use at most 16,777,216 gas: creating a collection costs
about 450k, `mintBatch(200)` about 5.2M, `airdrop(200)` to new wallets about 9.6M,
`mintWithURIs` at its 50-URI, 6,000-character limit about 8.6-9.5M, and `publicMint(20)` about
0.6M.

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
  - The fee is 2% (capped at 10%) and goes to the staking pool once `setRewardsPool` points
    there.
  - A listing records the fee and the creator royalty in force when it's listed or repriced,
    and a buy never pays more than those. The seller passes the highest fee and royalty they
    accept (`maxFeeBps`, `maxRoyaltyBps`), so a rate raised just before the listing lands
    makes it revert instead.
  - Seller and royalty payments that fail wait in `proceeds`; a sale can't be blocked. The
    owner of the proceeds withdraws them to any address, and anyone can push them to the
    account itself with all the gas it needs (`withdrawProceedsFor`), for receivers such as
    royalty splitters.
- **Every listing stays reachable.** Besides the full list, the contract keeps each seller's and
  each collection's active listings (`getActiveListingsBySeller`,
  `getActiveListingsByCollection`), so no amount of other listings can push one out of view.
- **Cancelling** returns an ERC-721 with a plain transfer, so a seller contract without the
  receiver hook still gets it back; `cancelListingTo` sends it elsewhere.
- **Pause** stops listing and buying; cancelling and withdrawing always work.
- **The page:**
  - Shows only SDOGE collections, and every row shows the seller, contract, fee and royalty.
  - Mine, Community Art and Collectibles read the indexes; every tab pages to the end with
    "Load more", and `nft.html?collection=0x...` shows one collection.
  - Quotes the live fee and royalty with the net amount before listing or repricing, and warns
    before a big price cut.
  - Re-reads a listing's price before buying.
  - Shows waiting proceeds with a Withdraw button, and asks for another address if the wallet
    can't take USDC.

## How it connects to staking

- **NFT profits fund the USDC side of staking: built.**
  - Marketplace fees and the Studio's `poolShareBps` go straight to `SDOGEStaking.contributeUSDC()`
    once each contract's `setRewardsPool` points at staking. The pages read where fees go and
    say so.
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

The metadata and art are served from the site itself (owner's call for the
2026-09-26 launch, no pinning service yet): the collection's base URI is
`https://www.stabledoge.site/nft/metadata/`, each `image` is the design's
file under `https://www.stabledoge.site/nft/reference/`, and the 8
animated designs add an `animation_url` to their mp4. The `www` address,
because the bare domain answers with a redirect. The owner can move them
to IPFS later with `setURI` (until `freezeMetadata()`); until then,
never rename or delete these files: every wallet reads them.

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
