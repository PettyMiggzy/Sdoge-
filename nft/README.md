# $SDOGE NFT Collection

A small roster of named/themed Doge characters, each with its own limited
mintable supply, minted with native USDC. Contract and metadata are built;
all 12 designs now have finished art (the original target was 10 - the
4 AI-generated additions all turned out well, so all 4 were kept rather
than trimmed back down). Not deployed yet.

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

## User-uploaded NFTs: burn $SDOGE to mint your own

`contracts/contracts/SDOGECommunityMint.sol` - a second, separate contract
from the curated collection above. Anyone can mint their *own* 1-of-1
NFT from art they host themselves, paid for by burning $SDOGE instead of
USDC:

- **ERC-721, not ERC-1155** - every mint is a unique token pointing at a
  caller-supplied `tokenURI`, not a copy of a shared design.
- **`mint(uri)` is fully permissionless** - no admin approval step, no
  automated content filter, no design roster to register against first.
  This was an explicit choice between three options (open, an owner
  approval queue, or an automated moderation filter) - **open was chosen
  deliberately**, not the default by omission. Worth knowing plainly: a
  smart contract can't inspect what a URI actually points to, so nothing
  on-chain stops someone from minting something illegal, infringing, or
  offensive under this collection's name. If that turns out to matter in
  practice, the fix is upstream of this contract (whatever mints the
  metadata/uploads it), not a rewrite of `mint()` itself.
- **Costs `burnAmount` (default 1,000,000) $SDOGE**, owner-tunable via
  `setBurnAmount` if the token's price moves enough to matter. Sent to
  the standard dead address (`0x000...dEaD`), not some token-specific
  burn call - checked the deployed $SDOGE token's actual bytecode first
  (it's an EIP-1167 minimal-proxy clone; checked the real implementation
  contract, not the proxy stub) and confirmed it exposes only standard
  ERC-20 functions, no `burn`/`burnFrom`/`redeem` of any kind. The dead-
  address transfer is the correct fallback for a token with no native
  burn - not a guess.
- Callers need to `approve()` this contract for `burnAmount` first, same
  pattern as any ERC-20 spend.

12 tests cover minting/burning accounting, sequential token IDs across
different minters, insufficient-allowance/balance reverts, tuning
`burnAmount` (and that already-minted NFTs aren't affected by a later
change), and a live reentrancy-attack scenario proving the guard actually
blocks a reentrant `mint()` from an ERC-721 receive hook, not just
trusting the modifier untested.

Deploy with `COMMUNITY_MINT_OWNER_ADDRESS=0x... npx hardhat run
scripts/deploy-community-mint.js --network arc` - live immediately, no
setup step needed afterward (unlike the curated collection, there's no
design to register first).

## Deploying and setting up designs

```bash
COLLECTIBLES_OWNER_ADDRESS=0x... COLLECTIBLES_BASE_URI=https://.../metadata/ \
ARC_RPC_URL=https://rpc.mainnet.arc.io DEPLOYER_PRIVATE_KEY=0x... \
npx hardhat run scripts/deploy-collectibles.js --network arc
```

Then, once deployed, the owner calls `createDesign()` once per finished
design (see `nft/metadata/` below for all 12) - nothing is mintable
until that's done.

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

## Resale: `SDOGENFTMarketplace.sol`

A third contract, separate from both mint paths above: peer-to-peer resale
for whatever's already been minted, since holders reselling on OpenSea
doesn't feed anything back into this project. One marketplace handles both
NFT contracts:

- **`listERC721(nftContract, tokenId, pricePerUnit)`** - list a single
  `SDOGECommunityMint` token (a unique upload). Always exactly 1 unit,
  all-or-nothing. Requires `approve(marketplace, tokenId)` first.
- **`listERC1155(nftContract, tokenId, amount, pricePerUnit)`** - list
  `amount` copies of an `SDOGECollectibles` design ("list supply for
  sale" - a holder of 5 copies can list 3 and keep 2). Supports partial
  fills: a buyer can buy any amount up to what's left, and the listing
  just shrinks rather than closing. Requires
  `setApprovalForAll(marketplace, true)` first (ERC-1155 has no per-token
  approve).
- **`buy(listingId, amount)`** (payable) - pay exactly
  `amount * pricePerUnit` native USDC. Non-escrow: the seller keeps
  custody until the moment of sale, so a listing can go stale if the
  seller sells/transfers/de-approves elsewhere first - `buy()` simply
  reverts in that case (the payment reverts with it, so the buyer loses
  nothing).
- **`cancelListing`** / **`updatePrice`** - seller-only.
- A **2% fee** (`feeBps`, owner-tunable up to a 10% cap - same 2% rate as
  the launchpad hook, for a consistent house cut across every SDOGE
  trading surface) comes off each sale and routes to `rewardsPool` via its
  `contributeUSDC()` - see the next section. Falls back to paying the
  owner directly if `rewardsPool` isn't set.

27 tests cover both listing types, partial ERC-1155 fills, stale listings
(seller transfers away / revokes approval after listing), fee routing both
with and without a `rewardsPool` set, admin controls, and a live
reentrancy-attack test (a malicious seller contract tries to re-enter
`buy()` on a second listing from the `receive()` hook that pays it out).

Deploy with `MARKETPLACE_OWNER_ADDRESS=0x... [STAKING_REWARDS_POOL_ADDRESS=0x...]
npx hardhat run scripts/deploy-marketplace.js --network arc` - live
immediately for both NFT contracts, no setup step needed beyond sellers
approving it.

## How it connects to staking

Two separate ideas from the original plan, one now built and one not:

- **"NFT sale profits fund the USDC side of staking"** - **built**, via
  `SDOGENFTMarketplace` above. Point `setRewardsPool()` at
  `SDOGEStaking`'s address and every resale fee lands in stakers' reward
  pool automatically through `contributeUSDC()` - no manual step. Primary
  mint proceeds (`SDOGECollectibles.mint()`'s USDC, `SDOGECommunityMint`'s
  burned $SDOGE) aren't wired into this automatically - the owner can
  still route them in by hand (`withdraw()` the USDC and call
  `contributeUSDC()`, or `contributeTokens()` the $SDOGE side) - see
  `../contracts/README.md`'s "How a penalty becomes a reward".
- **Holding an NFT amplifies a staker's reward (a multiplier)** - **not
  built**. `SDOGEStaking.sol`'s design predates this collection and
  doesn't reference it yet. A clean integration point would be a boost
  multiplier in its weighted-share calculation, keyed on
  `SDOGECollectibles.balanceOf(staker, designId) > 0` - not attempted here
  since the mechanic (which designs boost, by how much) isn't decided.

## Open questions

- Mint price per design - `priceWei` defaults to whatever `createDesign`
  is called with; no numbers decided yet.
- Whether all 12 designs get the same max supply or different ones per
  design (e.g. rarer designs capped lower).
- The NFT-boosts-staking mechanic mentioned above.
- Where metadata/images actually get hosted (IPFS vs. the site itself).

## Bulk-generated assets

If this becomes a generative trait-combination collection later (as
opposed to this fixed 12-design roster), that output goes under
`nft/assets/` - already `.gitignore`d so a full collection's worth of
images doesn't bloat the repo. Not used yet, and not the current plan.
