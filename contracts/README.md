# $SDOGE Staking

This directory also holds `contracts/SDOGECollectibles.sol`, the $SDOGE
NFT collection contract - see `../nft/README.md` for that one; everything
below is about staking specifically.

Stake $SDOGE into one of 5 fixed lock tiers, earn native USDC. Longer
locks earn faster, not just longer. The primary funding source costs the
project and Treasury nothing: an **early-withdrawal penalty** where
leaving before your tier matures forfeits your principal penalty AND all
of that stake's accrued reward - impatient stakers fund patient ones.

| Tier | Lock | Reward multiplier |
|---|---|---|
| 0 | 7 days | 1.0x |
| 1 | 30 days | 1.2x |
| 2 | 90 days | 1.5x |
| 3 | 180 days | 2.0x |
| 4 | 365 days | 3.0x |

Both columns are owner-tunable (`setTierDuration`, `setTierMultiplier`)
without affecting stakes already open - proposed starting numbers, not
fixed forever.

## The early-withdrawal penalty - read this before deploying

Withdraw from a stake before its tier matures and two things happen at
once:

1. `earlyWithdrawPenaltyBps` (default 15%, capped at 30%) of the principal
   you're withdrawing is kept instead of paid out.
2. **All** of that stake's currently-accrued, unclaimed reward is
   forfeited - not a pro-rated slice of it. Touching a locked stake at all
   forfeits its reward; a partial early withdrawal can't be used to
   cherry-pick around that.

This was specified exactly this way, not derived by us - worth flagging
plainly rather than softening quietly: combining full reward forfeiture
with a principal penalty is harsher than most staking contracts do either
individually. Someone who locks 365 days, waits 300, then needs liquidity
loses close to a year of accrued rewards *and* 15% of principal in one
move. That's a deliberate deterrent for a reason (it's what makes the
whole reward pool self-funded, with no tax revenue or Treasury money
involved) but it is also the single most likely source of "I got rugged"
complaints if it isn't communicated very clearly on the site before
launch. Both knobs (`earlyWithdrawPenaltyBps` via `setEarlyWithdrawPenalty`,
and the tier durations themselves) are tunable later if real usage says
this is too harsh - nothing here locks the number in permanently.

Forfeited principal and forfeited reward both stay in the contract
(`unallocatedTokens` and `unallocatedUsdc` respectively) to fund
everyone else's rewards - see "How a penalty becomes a reward" below.

## Why not tax revenue or Treasury yield

Two other funding paths were considered and set aside - worth recording
why, so this doesn't get re-litigated from scratch later:

- **A slice of the existing 1% trade tax** (e.g. Treasury 50% / Buyback
  30% / Staking 20%) was built and then reverted. It technically works,
  but it's still the project's money - just moved from one bucket to
  another - not the "don't use our own money" outcome that was actually
  asked for.
- **Treasury yield** (depositing tax-USDC into Aave or Morpho on Arc) was
  checked directly against live data the week Arc launched (mainnet went
  live 2026-09-16): Aave's Arc market held ~$76-125M in supplied USDC with
  **0.00% supply APY** because almost nothing was being borrowed yet, and
  Morpho's Arc-native Steakhouse Prime USDC vault (allocating into
  cirBTC-collateralized borrowing) showed **0.00% net APY** with well under
  $100k deposited. Circle's USYC was also checked and ruled out separately:
  $100k minimum investment, non-U.S.-persons only, institutional KYC/
  allow-listing required - not realistically usable here. In short: on a
  one-week-old chain, these markets haven't bootstrapped real borrowing
  demand yet, so "real yield" would currently mean real numbers close to
  zero. Worth rechecking as Arc matures, but it isn't funding anything
  today.

## Why native USDC, not an ERC-20 reward

Arc's native currency **is** USDC (like ETH on mainnet) - not an ERC-20.
That's the one detail that shapes everything here: $SDOGE (the staked
asset) is a normal ERC-20, but rewards are paid as native value
(`payable` / `call{value:}`), not `IERC20.transfer()`. Mixing those up is
the easiest way to ship a staking contract that silently can't pay out.

## How the reward math works

One global accumulator tracks reward per **weighted share**
(`amount * tierMultiplierBps / 10000`) instead of per raw token - the
standard Synthetix `StakingRewards` shape (per-second `rewardRate`, an
accumulator, O(1) per action regardless of staker count), extended so a
higher-tier token counts for more without needing a separate pool per
tier. A 365-day stake earns 3x faster, per token, than a 7-day stake -
not just for 52x longer.

Each stake is tracked as its own numbered position (`stakeId`), not
merged into one balance per user - a user can hold several simultaneous
stakes, even multiple in the same tier started at different times, each
with its own unlock time and reward checkpoint.

## How a penalty becomes a reward

1. Forfeited principal accumulates in `unallocatedTokens` (SDOGE),
   forfeited reward in `unallocatedUsdc` (native USDC) - both bounded so
   neither can ever reach into a staker's actual principal or another
   stake's legitimate reward (covered by an accounting-invariant test).
2. Anyone can also add to either pool directly: `contributeUSDC()`
   (payable) or `contributeTokens(amount)` - permissionless by design, so
   the community (or the project) can top up rewards without needing
   owner access. These are intentionally **not** wired into
   `notifyRewardAmount()`'s own access control - letting anyone reset the
   reward rate/period on demand would let a griefer manipulate payout
   timing by spamming tiny contributions.
3. `sweepTokens(address to)` (owner or notifier) moves accumulated
   `unallocatedTokens` out to be swapped for USDC - manual for now, same
   reasoning as before: volume will be small and unpredictable at first,
   not worth automating before there's a sense of how often it's worth
   running.
4. `notifyRewardAmount()` automatically folds in `unallocatedUsdc`
   alongside whatever new `msg.value` is sent - forfeited rewards don't
   need a separate step to become future rewards.

## Withdrawing into up to 4 wallets

`withdraw(stakeId, amount, recipients, splitAmounts)` pays the SDOGE
principal (net of any early-withdrawal penalty) split across 1-4
recipient addresses in caller-chosen proportions (`splitAmounts` must sum
exactly to the actual payout, so the caller needs to know that payout in
advance). Any accrued native-USDC reward on that stake is always paid to
`msg.sender` directly, never split - only the fungible SDOGE principal
supports multi-wallet payout.

`exitStake(stakeId)` is the single-wallet convenience version: full exit
to `msg.sender`, same penalty/forfeiture rules, no need to pre-compute the
payout yourself.

`claimReward(stakeId)` collects a **matured** stake's reward without
touching principal, so a staker can keep compounding past maturity and
collect periodically. It reverts on a still-locked stake, on purpose -
see the penalty section above for why reward stays "at risk" until
maturity or a deliberate early exit.

## NFT staking - not built yet

The original vision includes staking an NFT alongside $SDOGE for a
reward boost, funded partly by NFT sale proceeds. None of that is in this
contract: the collection itself doesn't exist yet (no art, no ERC-721,
no defined boost mechanic), and guessing at that design now would very
likely mean rebuilding it once the collection is actually designed. What
*is* true: this contract's shape (a weighted-share accumulator, per-stake
positions) doesn't block adding a second reward stream or a boost
multiplier later - it just isn't attempted here. See `../nft/README.md`
for the current state of that idea.

### The `notifier` role

`notifyRewardAmount()` and `sweepTokens()` are things you'd want to call
routinely, ideally without needing the same key that controls
`setRewardsDuration`, `setEarlyWithdrawPenalty`, `setTierMultiplier`,
`setTierDuration`, `recoverERC20`, and reassigning ownership itself -
that key should stay a cold multisig.

So there are two separate keys:

- **`owner`** - the Treasury/multisig. Full admin control. Set once at
  deploy time via `STAKING_OWNER_ADDRESS`, changeable later via
  OpenZeppelin `Ownable`'s normal `transferOwnership`.
- **`notifier`** - set by the owner via `setNotifier(address)`, allowed to
  call `notifyRewardAmount()` and `sweepTokens()` and nothing else.
  Defaults to `address(0)` (disabled) until the owner explicitly sets it.

If the notifier key ever leaks, the worst it can do is call
`notifyRewardAmount()` (spend whatever native value is sent alongside the
call - the attacker's own funds, not stakers'), sweep already-forfeited/
donated tokens to an address of its choosing, or grief future reward
rates by calling `notifyRewardAmount()` with a tiny amount. It cannot
reassign itself as owner, touch `recoverERC20`, or change any tier/
penalty/duration setting.

## What this is not (yet)

- **Not deployed.** No `STAKING_CONTRACT_ADDRESS` exists yet. The site's
  Roadmap section reflects this ("Phase 2: Treasury Online").
- **Not audited.** This has solid test coverage (per-tier accrual math,
  the early-withdrawal penalty and its reward-forfeiture, multi-wallet
  withdrawal, permissionless contributions, the accounting invariant that
  a sweep can never reach stakers' principal, a live reentrancy-attack
  test, access control including the notifier role) but test coverage and
  an audit are different things - especially given how much bigger this
  contract is than a plain single-pool staking contract. Get a real audit
  - or at minimum multiple independent experienced eyes - before real
  value flows through this on mainnet.
- **Penalty sweep-and-swap is manual for now.** See "How a penalty becomes
  a reward" above.
- **NFT staking isn't built.** See that section above.
- **Owner is a real privilege.** Deploy with a multisig as the owner, not
  a single EOA - the deploy script refuses to run without an explicit
  `STAKING_OWNER_ADDRESS` for exactly this reason.

## Development

```bash
npm install
npx hardhat test        # 37 tests: tiers, penalty + forfeiture, multi-wallet withdrawal, exitStake, contributions, admin, notifier, reentrancy
npx hardhat compile
```

## Deployment

```bash
STAKING_OWNER_ADDRESS=0x... ARC_RPC_URL=https://rpc.mainnet.arc.io \
DEPLOYER_PRIVATE_KEY=0x... \
npx hardhat run scripts/deploy.js --network arc
```

`STAKING_OWNER_ADDRESS` should be the Treasury/multisig, never a throwaway
key - see "What this is not" above.

After deploying, the owner still needs to call `setNotifier(address)` once
(from the multisig) before anything but the owner itself can call
`notifyRewardAmount()` or `sweepTokens()` - `deploy.js` does this for you
if `STAKING_NOTIFIER_ADDRESS` is set, or it can be done later as a
separate transaction.
