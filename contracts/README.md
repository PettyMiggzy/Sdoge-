# $SDOGE contracts (Hardhat)

Everything here targets Arc mainnet (chain 5042), where the native currency is USDC with
18 decimals. The same balance also shows up as a 6-decimal ERC-20 at `0x3600…0000`. Nothing
is deployed yet.

| Contract | What it does |
|---|---|
| `SDOGEStaking.sol` | Stake $SDOGE in 5 lock tiers and earn native USDC. |
| `SDOGECollectibles.sol` | The 12 named Doge designs (ERC-1155), sold for USDC. See `../nft/README.md`. |
| `SDOGEStudio.sol` + `SDOGEStudioCollection.sol` | Mint your own NFTs. Credits come in packages (1 mint = 5 USDC, 1,000 = 100 USDC). Buyers use them for Community Art 1-of-1s, or for their own collections with drops and royalties. See `../nft/README.md`. |
| `SDOGENFTMarketplace.sol` | Escrowed resale of all of the above. The fee goes to staking and royalties go to creators. |

Every contract uses two-step ownership, can't be renounced, and is meant to be owned by the
team's Safe. The deploy scripts refuse a plain wallet as owner.

## Where the money goes

```
Studio credit sales (USDC) ──withdraw()──> poolShareBps ──> staking.contributeUSDC()
                                            └─ the rest ──> treasury
Marketplace fee (2%) ──────────────────────> staking.contributeUSDC()  (feeRecipient until set)
Creator royalty (≤10%) ─────────────────────> the collection's royalty receiver
Collectibles mint revenue ──withdraw()─────> treasury
Studio SDOGE payments ──────────────────────> burned (0x…dEaD)
Staking early-exit penalties (SDOGE) ──sweepTokens()──> tokenSink (treasury)
```

`contributeUSDC()` adds to staking's `unallocatedUsdc`. The owner (or the notifier) turns it
into a reward period with `notifyRewardAmount()`. Once a period has been over for 7 days,
anyone can do the same with `notifyUnallocated()`, so rewards never depend on the owner being
around.

## SDOGEStaking

| Tier | Lock | Multiplier |
|---|---|---|
| 0 | 7 days | 1.0x |
| 1 | 30 days | 1.2x |
| 2 | 90 days | 1.5x |
| 3 | 180 days | 2.0x |
| 4 | 365 days | 3.0x |

- **Each stake is its own position**, and its terms are fixed when it opens: lock length,
  multiplier, penalty rate, and the time it matures. Admin changes only apply to new stakes.
- **Terms are checked when you stake.** `stake(tier, amount, expectedDuration,
  expectedMultiplierBps)` reverts if the tier changed in the meantime.
- **Maturity is at 80% of the lock** by default, so a 30-day stake is penalty-free after
  24 days. From then on you can exit, or claim rewards and keep the stake running. A stake keeps
  earning at its multiplier after it matures, for as long as it stays open.
- **Leaving early** costs 15% of the principal you take out (capped at 30%) and forfeits
  all of that stake's unclaimed reward. Your other stakes are unaffected.
  - `exitStake(id, false)` reverts instead of exiting early, so an early exit always has to be
    asked for.
  - The forfeited USDC goes back into the pool. The SDOGE penalty is swept to `tokenSink`.
- **Rewards are native USDC.**
  - If a payout fails (a contract wallet or blocklisted address), it waits in
    `deferredRewards` for `claimDeferredRewards(to)`. It never blocks principal.
  - The contract tracks every USDC it owes (`rewardsOutstanding + unallocatedUsdc`) and never
    schedules more than it holds.
  - Rewards that stream while nobody is staked return to the pool.
  - USDC or SDOGE forced in outside the normal paths is picked up by `absorbSurplus()`.
- **`withdraw(id, amount, recipients, splitAmounts)`** pays principal to 1-4 wallets.
  `splitAmounts` must add up to the exact payout, which also guards against an unexpected
  early exit.
- **Roles.**
  - The owner (the Safe) has every admin setting.
  - The optional `notifier` can only call `notifyRewardAmount()` and `sweepTokens()`.
  - `sweepTokens()` can only send to `tokenSink`, which the owner sets.
  - `recoverERC20` can never touch SDOGE or the `0x3600` USDC view.

The pool is not self-funding. Without treasury, Studio or marketplace USDC, rewards are close to
zero. Say so wherever staking is promoted.

## Development

```bash
npm install
npx hardhat test   # 172 tests:
                   #  41 staking         (tiers, terms guard, penalty + forfeiture, maturity,
                   #                      splits, deferred payouts, exact USDC accounting fuzz)
                   #  19 collectibles    (closed-by-default designs, expected ids, reserve,
                   #                      supply lock, metadata freeze, airdrop skip)
                   #  28 studio          (packages, USDC + SDOGE-burn credits, Community Art,
                   #                      collection factory, revenue split)
                   #  20 studio collection (batch/URI/airdrop mints, drops, cap, royalties)
                   #  31 marketplace     (escrow, Studio collections, royalties, fees, pause)
                   #  10 deploy scripts  (run for real on the local chain with a mock Safe)
                   #  23 front end       (the site's real assets/js files against these contracts)
```

`test/helpers/fe-harness.js` loads the site's scripts the way a browser page does, with an
injected wallet wired to Hardhat's chain. The front-end tests exercise the same code visitors
run.

## Deployment runbook

Every script refuses to run on anything but chain 5042, and requires the owner to be a Safe on
Arc with at least 2 signers (`ALLOW_EOA_OWNER=1` / `ALLOW_LOW_THRESHOLD=1` override). Every
address goes into `deployments/arc.json`. Owner-only follow-ups are never sent by the
deployer; they're written as Safe Transaction Builder batches in `deployments/`.

```bash
export ARC_RPC_URL=https://rpc.mainnet.arc.io DEPLOYER_PRIVATE_KEY=0x...   # gas only, owns nothing
SAFE=0x...        # the team's Safe on Arc
TREASURY=0x...    # where USDC revenue goes (can be the Safe)

# 1. Staking
STAKING_OWNER_ADDRESS=$SAFE npx hardhat run scripts/deploy-staking.js --network arc

# 2. The 12 designs. Pin the art and metadata first: the script fetches all 12 files from the
#    base URI and checks them against nft/designs.json.
COLLECTIBLES_OWNER_ADDRESS=$SAFE TREASURY_ADDRESS=$TREASURY COLLECTIBLES_BASE_URI=ipfs://<CID>/ \
  npx hardhat run scripts/deploy-collectibles.js --network arc
npx hardhat run scripts/setup-designs.js --network arc          # batch: createDesign x12 (closed)
#    ...execute that batch in the Safe, then re-run: it checks every design against the manifest
OPEN=1 npx hardhat run scripts/setup-designs.js --network arc   # batch: open them for sale

# 3. SDOGE Studio (packages from nft/studio.json); writes the batch that routes poolShareBps
#    of revenue to staking
STUDIO_OWNER_ADDRESS=$SAFE TREASURY_ADDRESS=$TREASURY npx hardhat run scripts/deploy-studio.js --network arc

# 4. Marketplace (bound to the Studio and the Collectibles); writes the batch that sends fees to staking
MARKETPLACE_OWNER_ADDRESS=$SAFE FEE_RECIPIENT_ADDRESS=$TREASURY \
  npx hardhat run scripts/deploy-marketplace.js --network arc

# 5. Execute the *.safe.json batches in the Safe, then point the site at the contracts
node scripts/sync-frontend.js     # writes the addresses into assets/js/arc.js (SDOGE_CONTRACTS)

# 6. Verify the source on explorer.arc.io (Blockscout)
npx hardhat verify --network arc <address> <constructor args...>
```

Before launch:
- Replace the `ipfs://REPLACE_ME` images in `nft/metadata`.
- Settle the design prices in `nft/designs.json` (placeholders today).
- Check the packages and `poolShareBps` in `nft/studio.json`.
- Get an independent audit before real money flows through these contracts.
