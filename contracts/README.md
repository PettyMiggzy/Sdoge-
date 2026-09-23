# $SDOGE Staking

Stake $SDOGE, earn native USDC. The primary funding source costs the
project and the Treasury nothing: an **early-withdrawal penalty**.
Withdraw within `earlyWithdrawWindow` (default 7 days) of your last stake
and `earlyWithdrawPenaltyBps` (default 15%) of what you're withdrawing
stays behind instead of being paid out. Sweep that out, convert it to
USDC, feed it to `notifyRewardAmount()` — impatient stakers fund patient
ones. No tax revenue, no Treasury yield, no minting.

## Why this, not tax revenue or Treasury yield

Two other funding paths were considered and set aside — worth recording
why, so this doesn't get re-litigated from scratch later:

- **A slice of the existing 1% trade tax** (e.g. Treasury 50% / Buyback
  30% / Staking 20%) was built and then reverted. It technically works,
  but it's still the project's money — just moved from one bucket to
  another — not the "don't use our own money" outcome that was actually
  asked for.
- **Treasury yield** (depositing tax-USDC into Aave or Morpho on Arc) was
  checked directly against live data the week Arc launched (mainnet went
  live 2026-09-16): Aave's Arc market held ~$76–125M in supplied USDC with
  **0.00% supply APY** because almost nothing was being borrowed yet, and
  Morpho's Arc-native Steakhouse Prime USDC vault (allocating into
  cirBTC-collateralized borrowing) showed **0.00% net APY** with well under
  $100k deposited. Circle's USYC was also checked and ruled out separately:
  $100k minimum investment, non-U.S.-persons only, institutional KYC/
  allow-listing required — not realistically usable here. In short: on a
  one-week-old chain, these markets haven't bootstrapped real borrowing
  demand yet, so "real yield" would currently mean real numbers close to
  zero. This could change as Arc matures and is worth rechecking later
  (nothing here rules it out permanently), but it isn't funding anything
  today.

The early-withdrawal penalty sidesteps both problems: it doesn't touch tax
revenue or Treasury principal, and it doesn't depend on some other
protocol's borrow demand ever showing up. It's also nothing new in DeFi —
exit penalties that redistribute to remaining participants are a
well-worn pattern (e.g. veTokenomics-style locking systems).

## Why native USDC, not an ERC-20 reward

Arc's native currency **is** USDC (like ETH on mainnet) — not an ERC-20.
That's the one detail that shapes everything here: $SDOGE (the staked
asset) is a normal ERC-20, but rewards are paid as native value
(`payable` / `call{value:}`), not `IERC20.transfer()`. Mixing those up is
the easiest way to ship a staking contract that silently can't pay out.

The accrual math itself is the standard Synthetix `StakingRewards` model:
a per-second `rewardRate` and a `rewardPerToken` accumulator, so reward
distribution is correct regardless of when anyone stakes or unstakes,
without ever looping over stakers (that pattern is about as battle-tested
as DeFi code gets — plenty of major protocols run a fork of it — so this
adapts it rather than inventing new accrual math for something that holds
real funds).

## How a penalty becomes a reward

1. Someone withdraws within `earlyWithdrawWindow` of their last `stake()`.
   `earlyWithdrawPenaltyBps` of the withdrawn amount stays in the contract
   (in SDOGE) instead of being paid out; the rest goes to them as normal.
   Tracked separately in `pendingPenalties` — it's forfeited stake, never
   confused with anyone's principal (see the accounting invariant covered
   by tests: contract's SDOGE balance always equals `totalSupply() +
   pendingPenalties`, so a sweep can mathematically never reach into a
   staker's balance).
2. `sweepPenalties(address to)` (owner or notifier) moves the accumulated
   SDOGE out.
3. Swap it for USDC (e.g. via the same pool everyone else trades SDOGE
   on) and call `notifyRewardAmount()` with the proceeds. This step is
   manual for now — there's no `treasury/` keeper for it yet, deliberately:
   penalty volume will be small and unpredictable at first, and it's not
   worth automating before there's a sense of how often it's actually
   worth running. `../treasury/fund-staking.js` already exists as a
   reference for this exact "accumulate, sweep, swap, notifyRewardAmount()"
   shape (built for the tax-revenue path above) if/when this gets
   automated later.

Penalty settings (`earlyWithdrawPenaltyBps`, `earlyWithdrawWindow`) are
owner-tunable via `setEarlyWithdrawSettings`, capped at 30% so even a
compromised owner key can't turn this into a principal-confiscation trap.

### The `notifier` role

`notifyRewardAmount()` and `sweepPenalties()` are things you'd want to call
routinely, ideally without needing the same key that controls
`setRewardsDuration`, `recoverERC20`, and reassigning ownership itself —
that key should stay a cold multisig.

So there are two separate keys:

- **`owner`** — the Treasury/multisig. Full admin control. Set once at
  deploy time via `STAKING_OWNER_ADDRESS`, changeable later via
  OpenZeppelin `Ownable`'s normal `transferOwnership`.
- **`notifier`** — set by the owner via `setNotifier(address)`, allowed to
  call `notifyRewardAmount()` and `sweepPenalties()` and nothing else.
  Defaults to `address(0)` (disabled) until the owner explicitly sets it —
  nothing is wired up until someone with the owner key deliberately does
  so.

If the notifier key ever leaks, the worst it can do is call
`notifyRewardAmount()` (spend whatever native value is sent alongside the
call — the attacker's own funds, not stakers'), sweep already-forfeited
penalties to an address of its choosing, or grief future reward rates by
calling `notifyRewardAmount()` with a tiny amount. It cannot reassign
itself as owner, touch `recoverERC20`, change `rewardsDuration`, or reach
stakers' principal.

## What this is not (yet)

- **Not deployed.** No `STAKING_CONTRACT_ADDRESS` exists yet — see
  Deployment below. The site's Roadmap section reflects this ("Phase 2:
  Treasury Online").
- **Not audited.** This has solid test coverage (staking/withdrawal
  accounting, early-withdrawal penalty and its accounting invariant,
  proportional reward math across staggered stakers, reward rollover, a
  live reentrancy-attack test, access control including the notifier
  role) but test coverage and an audit are different things. Get a real
  audit — or at minimum multiple independent experienced eyes — before
  real value flows through this on mainnet.
- **Penalty sweep-and-swap is manual for now.** See "How a penalty becomes
  a reward" above.
- **Owner is a real privilege.** Deploy with a multisig as the owner, not
  a single EOA — the deploy script refuses to run without an explicit
  `STAKING_OWNER_ADDRESS` for exactly this reason.

## Development

```bash
npm install
npx hardhat test        # 31 tests: accounting, early-withdrawal penalty, reward math, admin, notifier, reentrancy
npx hardhat compile
```

## Deployment

```bash
STAKING_OWNER_ADDRESS=0x... ARC_RPC_URL=https://rpc.mainnet.arc.io \
DEPLOYER_PRIVATE_KEY=0x... \
npx hardhat run scripts/deploy.js --network arc
```

`STAKING_OWNER_ADDRESS` should be the Treasury/multisig, never a throwaway
key — see "What this is not" above.

After deploying, the owner still needs to call `setNotifier(address)` once
(from the multisig) before anything can call `notifyRewardAmount()` or
`sweepPenalties()` — deploy.js does this for you if
`STAKING_NOTIFIER_ADDRESS` is set, or it can be done later as a separate
transaction.
