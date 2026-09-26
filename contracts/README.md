# $SDOGE contracts (Hardhat)

Everything here targets Arc mainnet (chain 5042), where the native currency is USDC with
18 decimals. The same balance also shows up as a 6-decimal ERC-20 at `0x3600…0000`. Nothing
is deployed yet.

| Contract | What it does |
|---|---|
| `SDOGEStaking.sol` | Stake $SDOGE in 5 lock tiers and earn native USDC and $SDOGE. Staking a Collectible with a stake boosts it. |
| `SDOGECollectibles.sol` | The 12 named Doge designs (ERC-1155), sold for USDC. See `../nft/README.md`. |
| `SDOGEStudio.sol` + `SDOGEStudioCollection.sol` | Mint your own NFTs. Credits come in packages (1 mint = 5 USDC, 1,000 = 100 USDC). Buyers use them for Community Art 1-of-1s, or for their own collections with drops and royalties. See `../nft/README.md`. |
| `SDOGENFTMarketplace.sol` | Escrowed resale of all of the above. The fee goes to staking and royalties go to creators. |

Every contract uses two-step ownership, can't be renounced, and is meant to be owned by the
team's Safe. The deploy scripts refuse a plain wallet as owner.

## Where the money goes

```
Studio credit sales (USDC) ─ poolShareBps set aside at the sale (poolOwed) ─withdraw()─> staking.contributeUSDC()
                            └─ the rest ──────────────────────────────────withdraw()─> treasury
Marketplace fee (2%) ──────────────────────> staking.contributeUSDC()  (feeRecipient until set)
Creator royalty (≤10%) ─────────────────────> the collection's royalty receiver
Collectibles mint revenue ──withdraw()─────> treasury
Studio SDOGE payments ──────────────────────> burned (0x…dEaD)
Staking early-exit penalties (SDOGE) ───────> streamed to the stakers who stay
```

`contributeUSDC()` adds to staking's `unallocatedUsdc`. The owner (or the notifier) turns it
into a reward period with `notifyRewardAmount()`. The first period is always started by the
owner or notifier; after that, once a period has been over for 7 days, anyone can start the
next one with `notifyUnallocated()`, so rewards never depend on the owner being around. Studio's
`withdraw()` pays the pool and the treasury independently: if one can't take USDC, the other is
still paid.

## SDOGEStaking

| Tier | Lock | Multiplier |
|---|---|---|
| 0 | 7 days | 1.0x |
| 1 | 30 days | 1.2x |
| 2 | 90 days | 1.5x |
| 3 | 180 days | 2.0x |
| 4 | 365 days | 3.0x |

- **The terms are fixed in the code.** The five tiers above, the 15% penalty and maturity at
  80% of the lock are constants; there are no setters, so nobody (the owner included) can
  change them. Each stake is its own position with its own lock.
- **Terms are checked when you stake.** `stake(tier, amount, expectedDuration,
  expectedMultiplierBps)` reverts unless they match the tier, so a page showing the wrong terms
  can't stake on them.
- **Maturity is at 80% of the lock**, so a 30-day stake is penalty-free after 24 days. From
  then on you can exit, or claim rewards and keep the stake running. A stake keeps earning at
  its multiplier after it matures, for as long as it stays open.
- **Leaving early** costs 15% of the principal you take out and forfeits all of that stake's
  unclaimed rewards, USDC and SDOGE. Your other stakes are unaffected.
  - `exitStake(id, false)` and `withdraw(..., false)` revert instead of leaving early, so an
    early exit always has to be asked for with `allowEarly = true`.
  - **None of it leaves the pool.** The forfeited USDC goes back into the USDC pool. The SDOGE
    penalty and the forfeited SDOGE stream to the stakers who stay, over 7 days. There is no
    sweep: nobody, the owner included, can take them out.
- **Rewards come in two currencies**, both split by the same weights (amount x tier multiplier
  x NFT boost).
  - **USDC** (native) from the treasury, Studio and marketplace revenue. The owner or notifier
    schedules it with `notifyRewardAmount()`. If a payout fails (a contract wallet or
    blocklisted address), it waits in `deferredRewards` for `claimDeferredRewards(to)`. It never
    blocks principal.
  - **SDOGE** from early-exit penalties, forfeits, donations (`contributeTokens`) and the
    treasury (`notifySdogeRewards(amount)`). Once rewards have started, new SDOGE joins the
    stream on its own whenever someone stakes, exits or claims, unless that would slow a
    running period down; `notifyUnallocatedSdoge()` lets anyone push it in during a quiet spell.
  - The contract tracks everything it owes in each currency and never schedules more than it
    holds: the native balance covers `rewardsOutstanding + unallocatedUsdc`, and the SDOGE
    balance covers principal + `unallocatedSdoge + sdogeRewardsOutstanding`.
  - Rewards that stream while nobody is staked return to the pool.
  - USDC or SDOGE forced in outside the normal paths is picked up by `absorbSurplus()`.
- **NFT boosts.** Send one SDOGE Collectible with a new stake and the stake's share of both
  streams is multiplied by 1 + that design's boost (at most +50%, from
  `../nft/staking-boosts.json` by tier).
  - The page does it in one transaction, `collectibles.safeTransferFrom(you, staking, designId,
    1, abi.encode(tier, amount, duration, multiplier, boost))`, after an exact SDOGE approval.
    No blanket NFT approval is ever asked for.
  - A stake keeps the boost it opened with. The NFT comes back when the stake closes, early or
    not; it's never penalized. If the wallet refuses it, it waits in `deferredNfts` for
    `claimDeferredNft(designId, to)`, and the exit still goes through.
  - Only the recorded Collectibles count, one NFT per stake, the staker's own, and only designs
    with a boost; anything else sent to the contract is refused.
- **`withdraw(id, amount, recipients, splitAmounts, allowEarly)`** pays principal to 1-4
  wallets. `splitAmounts` must add up to the exact payout.
- **Roles.**
  - The owner (the Safe) schedules rewards, sets the notifier, the USDC reward period length
    (1-90 days, between periods) and the design boosts until `lockBoosts()`. It can't touch the
    terms, anyone's stake, or the pool's SDOGE.
  - The optional `notifier` can only call `notifyRewardAmount()` and `notifySdogeRewards()`.
  - `recoverERC20` can never touch SDOGE or the `0x3600` USDC view.
- **The first reward period.** A dust stake opened while nobody else is staked would take
  that period's whole stream, so the team's Safe opens a permanent seed stake before any
  revenue is routed to staking or any period is started (see the runbook). Nothing streams
  until the owner or notifier starts rewards, penalties included.

The USDC pool is not self-funding. Without treasury, Studio or marketplace USDC, USDC rewards are
close to zero. Say so wherever staking is promoted.

## Development

```bash
npm install
npx hardhat test   # 262 tests:
                   #  54 staking         (fixed terms, terms guard, penalty streamed to stakers,
                   #                      USDC + SDOGE rewards and forfeiture, maturity, allowEarly,
                   #                      splits, NFT boosts and returns, deferred payouts and NFTs,
                   #                      first period, exact two-currency accounting fuzz)
                   #  22 collectibles    (closed-by-default designs, expected ids, reserve, changes
                   #                      only while closed, supply lock, URI rules, freeze,
                   #                      airdrop gas budget)
                   #  35 studio          (packages, USDC + SDOGE-burn credits, Community Art,
                   #                      collection factory, pool share set aside at sale,
                   #                      non-blocking withdraw, Verified badge)
                   #  24 studio collection (batch/URI/airdrop mints and their gas, drops,
                   #                      ownership handover, cap, royalties)
                   #  39 marketplace     (escrow, per-seller/per-collection indexes, fee and
                   #                      royalty limits, cancel paths, proceeds, pause)
                   #  31 deploy scripts  (run for real on the local chain with a mock Safe,
                   #                      verify-deployment, sync-frontend)
                   #  46 front end       (the site's real assets/js files against these contracts)
                   #   4 studio AI       (studio-ai.js against the api/ai handlers on this chain)
```

`test/helpers/fe-harness.js` loads the site's scripts the way a browser page does, with an
injected wallet wired to Hardhat's chain. The front-end tests exercise the same code visitors
run. With `rpc: "limited"`, a page reads through its own provider and a local relay that
behaves like Arc's public RPC under load (about 20 calls a second, -32005 inside batches,
HTTP 429 otherwise).

Arc caps a transaction at 16,777,216 gas (Hardhat enforces the same cap). The biggest calls
stay well under it: `airdrop(200)` to new wallets about 9.6M, `mintWithURIs` at its limit about
9.5M, the Studio deploy about 6.7M. Hardhat's own gas estimator overshoots big transactions, so
tests measure them with an explicit gas limit.

## Deployment runbook

Every script checks all of its inputs before it sends anything:
- **Chain:** Arc mainnet (5042) only.
- **Record:** a contract already in `deployments/arc.json` is refused. `FORCE_REDEPLOY=1`
  deploys a new one and keeps the old entry under `replaced`.
- **Owners** must be a Safe on Arc with at least 2 signers, never the deployer key or an
  EIP-7702 delegated wallet (`ALLOW_EOA_OWNER=1`, `ALLOW_LOW_THRESHOLD=1` and
  `ALLOW_NON_SAFE_OWNER=1` override this).
- **Recipients:** the treasury and fee recipient must accept a plain native USDC transfer
  (the fee splitter at `0xddab…8980` doesn't), and no recipient may be a burn, zero or system
  address.
- **Rehearsals:** on `--network arc` with `ARC_RPC_URL` pointing anywhere but
  `https://rpc.mainnet.arc.io` (an anvil fork of Arc also reports chain 5042), the run is
  recorded in `deployments/arc-rehearsal*.json`. Set `ARC_RECORD_MAINNET=1` only for a private
  mainnet RPC.

Owner-only follow-ups are never sent by the deployer; they're written as Safe Transaction
Builder batches in `deployments/`.

```bash
export ARC_RPC_URL=https://rpc.mainnet.arc.io DEPLOYER_PRIVATE_KEY=0x...   # gas only, owns nothing
SAFE=0x...        # the team's Safe on Arc (2+ signers)
TREASURY=0x...    # where USDC revenue goes; must accept a plain USDC transfer (the Safe does)

# 1. The 12 designs. Pin the art and metadata first: the script fetches all 12 files from the
#    base URI and checks them against nft/designs.json.
COLLECTIBLES_OWNER_ADDRESS=$SAFE TREASURY_ADDRESS=$TREASURY COLLECTIBLES_BASE_URI=ipfs://<CID>/ \
  npx hardhat run scripts/deploy-collectibles.js --network arc
npx hardhat run scripts/setup-designs.js --network arc   # batch: createDesign x12, all closed
#    Check the printed reserves before signing: a reserve can never be raised later. Execute
#    the batch in the Safe, then re-run: it checks every design against the manifest.

# 2. Staking, tied for good to the recorded Collectibles (their NFTs boost stakes)
STAKING_OWNER_ADDRESS=$SAFE npx hardhat run scripts/deploy-staking.js --network arc
#    Then, from the Safe, BEFORE any revenue is routed to staking:
#    a. execute the staking-setup batch (the design boosts from nft/staking-boosts.json);
#    b. open a seed stake it never exits (e.g. the 365-day tier), so no dust stake can ever
#       be alone in the pool;
#    c. start rewards: notifyRewardAmount() with USDC and notifySdogeRewards(amount) with SDOGE
#       (only the owner or notifier can start them; after that, penalties stream on their own
#       and anyone can restart an idle pool);
#    d. once the boosts are final, lockBoosts().

# 3. SDOGE Studio (packages from nft/studio.json, which also needs a pinned
#    communityContractURI, or ALLOW_EMPTY_CONTRACT_URI=1 and setCommunityContractURI later)
STUDIO_OWNER_ADDRESS=$SAFE TREASURY_ADDRESS=$TREASURY npx hardhat run scripts/deploy-studio.js --network arc

# 4. Marketplace (bound to the recorded Studio and Collectibles)
MARKETPLACE_OWNER_ADDRESS=$SAFE FEE_RECIPIENT_ADDRESS=$TREASURY \
  npx hardhat run scripts/deploy-marketplace.js --network arc

# 5. In the Safe, only after step 2's seed stake and first period: the studio-setup and
#    marketplace-setup batches that route revenue to staking.

# 6. Check everything on Arc (read-only, through the public RPC), then point the site at it.
#    sync-frontend runs the same checks and won't touch assets/js/arc.js unless they pass.
SAFE_ADDRESS=$SAFE node scripts/verify-deployment.js
SAFE_ADDRESS=$SAFE node scripts/sync-frontend.js

# 7. Only once the site is live and the sale is announced: open the designs.
OPEN=1 npx hardhat run scripts/setup-designs.js --network arc
#    Optional and one-way: LOCK=1 writes lockSupply x12, lockCollection and freezeMetadata.

# 8. Verify the source on explorer.arc.io (Blockscout)
npx hardhat verify --network arc <address> <constructor args...>
```

Before launch:
- Replace the `ipfs://REPLACE_ME` images in `nft/metadata`.
- Settle the design prices and reserves in `nft/designs.json` and the boosts in
  `nft/staking-boosts.json` (placeholders today).
- Check the packages, `poolShareBps` and `communityContractURI` in `nft/studio.json`.
- Get an independent audit before real money flows through these contracts.
