# $SDOGE NFT Collection

A small roster of named/themed Doge characters, each with its own limited
mintable supply, minted with native USDC. Contract and metadata are built;
the collection isn't deployed or fully art-complete yet (6 of an intended
10 designs have finished art).

## Contract: `contracts/contracts/SDOGECollectibles.sol`

**ERC-1155**, not ERC-721 - each design (SWAT Doge, Space Doge, etc.) is
one token ID that can be minted many times up to its own cap, not a
one-of-a-kind piece. This is the right fit for a small named roster;
ERC-721 would be if every mint were meant to be unique.

- `createDesign(name, maxSupply, priceWei)` (owner) - registers a design
  with a fixed cap. **Supply can only be raised later, never lowered** - a
  cap that could shrink after the fact isn't a trustworthy cap.
- `mint(designId, amount)` (payable, anyone) - mints at the design's set
  price in native USDC (Arc's gas token, same as the staking contract's
  reward asset).
- `ownerMint(designId, to, amount)` - free team/giveaway mints, still
  bounded by the cap.
- `increaseSupply`, `setPrice`, `setURI`, `withdraw` - owner admin.
- `uri(id)` resolves to `<baseURI><id>.json` (e.g. `.../metadata/3.json`)
  - a plain decimal-ID scheme rather than EIP-1155's `{id}` hex-padding
    convention, simpler for a small hand-curated set like this one.

18 tests cover design creation, minting (payment validation, supply caps,
owner-mint), supply/price management, URI resolution, withdrawals, and
standard ERC-1155 transfer/interface behavior.

**Deploying this required a real toolchain fix**, not just NFT-specific
code: OpenZeppelin 5.x's `ERC1155` pulls in `Arrays.sol`, which uses the
`MCOPY` opcode (introduced in the Cancun hardfork) - this simply didn't
compile against `hardhat.config.js`'s previous implicit "paris" target.
Fixed by setting `evmVersion: "cancun"` explicitly, after confirming (not
assuming) that Arc's actual baseline is Osaka - newer than Cancun, and
Arc's own docs say pinning to paris is an obsolete workaround. This also
means `SDOGEStaking.sol` has compiled against Cancun since this change,
though nothing in it needed the newer opcodes.

## Deploying and setting up designs

```bash
COLLECTIBLES_OWNER_ADDRESS=0x... COLLECTIBLES_BASE_URI=https://.../metadata/ \
ARC_RPC_URL=https://rpc.mainnet.arc.io DEPLOYER_PRIVATE_KEY=0x... \
npx hardhat run scripts/deploy-collectibles.js --network arc
```

Then, once deployed, the owner calls `createDesign()` once per finished
design (see `nft/metadata/` below for the 6 defined so far) - nothing is
mintable until that's done.

## Reference art and metadata

`nft/reference/` holds the 6 finished character pieces (tracked in git,
unlike `nft/assets/` below); `nft/metadata/{1-6}.json` are their ERC-1155
metadata files (standard `name`/`description`/`image`/`attributes`
shape), matching the design-ID order they're expected to be created in:

| ID | File | Character | Outfit | Background | USDC branding |
|---|---|---|---|---|---|
| 1 | `swat-doge.jpg` | Husky | SWAT gear | Orange | No |
| 2 | `astronaut-doge.jpg` | Shiba | Space suit | Blue | Yes |
| 3 | `bucket-hat-doge.jpg` | Shiba | Hoodie & fanny pack | Purple | Yes |
| 4 | `rich-doge.jpg` | Husky | Gold chain, grillz | Orange | Yes |
| 5 | `hoodie-doge.jpg` | Shiba | Blue hoodie | Grey | Yes |
| 6 | `cap-doge.jpg` | Shiba | None (plain) | Blue | Yes |

The `image` field in each metadata file is a placeholder
(`ipfs://REPLACE_ME/...`) - these haven't been pinned to permanent
storage yet. Do that (nft.storage, Pinata, or similar) and update all 6
files before deploying for real; a metadata `image` pointing at nothing
is a broken collection the moment someone opens it in a wallet.

Two base characters run through the full-outfit designs (a grey/silver
husky, an orange/tan shiba); `cap-doge` is noticeably plainer than the
rest, which could hint at a rarity structure (plain = common, full
costume = rare) - not confirmed, just noted as a real possibility.

## The remaining 4 designs - no image generation available here

This environment's image tools are editing-only (crop, color, expand,
vectorize) - there is no working text-to-image generation available (the
one tool that could plausibly do it explicitly states generative content
creation isn't currently enabled here). The 4 remaining designs need to be
generated elsewhere, using whatever tool produced the original 6.

**Style guide**, reverse-engineered from the 6 existing pieces, for
consistency: flat cel-shaded/vector cartoon illustration, thick black
outlines, head-and-shoulders bust portrait, chibi-proportioned doge face
with a smug/confident half-smile (often one raised eyebrow) and pink
blush marks on the cheeks, solid single-color background (no gradient, no
scene detail), a Circle USDC "($)" logo worked into the outfit as a
patch/badge/print. Alternate between the orange/tan shiba base and the
grey/silver husky base.

Four prompts to reach 10, picked to be distinct from the existing 6 and
from each other (no overlap with SWAT/space/streetwear/plain):

1. **Samurai Doge** - "A [shiba/husky] dog character wearing traditional
   samurai armor with a katana sheathed at its side, a Circle USDC ($)
   logo emblazoned on the chest armor, dramatic red solid background.
   Flat cel-shaded cartoon style, thick black outlines, smug half-smile
   with one raised eyebrow, pink blush cheeks, head-and-shoulders bust
   portrait, chibi proportions."
2. **Viking Doge** - "A [shiba/husky] dog character wearing a fur-lined
   cloak and a horned helmet, gripping a battle axe, a Circle USDC ($)
   logo etched into a round shield, icy pale-blue solid background. Flat
   cel-shaded cartoon style, thick black outlines, smug half-smile with
   one raised eyebrow, pink blush cheeks, head-and-shoulders bust
   portrait, chibi proportions."
3. **Cyberpunk Doge** - "A [shiba/husky] dog character wearing a
   neon-trimmed jacket and a holographic visor, a glowing Circle USDC ($)
   logo on the jacket's shoulder patch, dark near-black solid background
   with neon glow accents. Flat cel-shaded cartoon style, thick black
   outlines, smug half-smile with one raised eyebrow, pink blush cheeks,
   head-and-shoulders bust portrait, chibi proportions."
4. **Champion Doge** - "A [shiba/husky] dog character wearing red boxing
   gloves and a championship belt with a large Circle USDC ($) logo
   buckle, gold solid background. Flat cel-shaded cartoon style, thick
   black outlines, smug half-smile with one raised eyebrow, pink blush
   cheeks, head-and-shoulders bust portrait, chibi proportions."

Whichever generator made the first 6 will match this style far more
reliably than a fresh model would - use that one if at all possible.
Drop the 4 results into `nft/reference/` and say so; I'll write their
`metadata/7-10.json` files and they're ready for `createDesign()`.

## How it'd connect to staking

From the original idea: holding an NFT would amplify a staker's rewards
(some kind of multiplier), and some portion of NFT sale proceeds would
feed into the staking reward pool alongside the early-withdrawal-penalty
mechanism already built (see `../contracts/README.md`). Not built - the
staking contract's design predates this collection's contract and doesn't
reference it yet. A clean integration point would be a boost multiplier
in `SDOGEStaking.sol`'s weighted-share calculation, keyed on
`SDOGECollectibles.balanceOf(staker, designId) > 0` - not attempted here
since the mechanic (which designs boost, by how much) isn't decided.

## Open questions

- Mint price per design - `priceWei` defaults to whatever `createDesign`
  is called with; no numbers decided yet.
- Whether all 10 designs get the same max supply or different ones per
  design (e.g. rarer designs capped lower).
- The NFT-boosts-staking mechanic mentioned above.
- Where metadata/images actually get hosted (IPFS vs. the site itself).

## Bulk-generated assets

If this becomes a generative trait-combination collection later (as
opposed to this fixed 10-design roster), that output goes under
`nft/assets/` - already `.gitignore`d so a full collection's worth of
images doesn't bloat the repo. Not used yet, and not the current plan.
