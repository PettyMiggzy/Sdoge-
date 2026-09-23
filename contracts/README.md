# $SDOGE Staking

Stake $SDOGE, earn a direct 20% cut of the existing 1% buy tax, paid out as
native USDC — not yield the Treasury earns elsewhere, and not new SDOGE
minted out of thin air. The same tax that funds the Treasury (50%) and
Buyback (30%) funds this too; see the site's Tokenomics section for the
full split.

An earlier version of this plan considered funding rewards from Treasury
yield (e.g. depositing tax-USDC into Aave/Morpho on Arc). That's ruled out:
the site publicly promises the Treasury reserve takes on no lending or
yield-strategy risk, and rewriting that promise to enable staking wasn't
worth it when a tax-revenue slice gets the same outcome with no new risk to
the reserve. Nothing below talks to Aave or Morpho.

## Why this design

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

## How the tax revenue actually gets here

This contract doesn't watch the tax wallet or swap anything itself — it
only pays out whatever native USDC it's sent via `notifyRewardAmount()`.
`../treasury/fund-staking.js` is the piece that watches the known tax
wallet, skims its 20% cut off any newly-arrived USDC, and calls
`notifyRewardAmount()` with it — see `../treasury/README.md` for exactly
how that works and what it deliberately leaves alone (the other 80%, which
still goes through the existing manual Treasury/Buyback process).

### The `notifier` role

`notifyRewardAmount()` needs to be called automatically and often (whenever
new tax revenue shows up), which means a hot wallet has to be able to call
it. But `notifyRewardAmount`, `setRewardsDuration`, and `recoverERC20` are
all owner-only, and the owner should be a multisig kept offline — a hot key
should never be able to do everything the owner can.

So there are two separate keys:

- **`owner`** — the Treasury/multisig. Full admin control. Set once at
  deploy time via `STAKING_OWNER_ADDRESS`, changeable later via
  OpenZeppelin `Ownable`'s normal `transferOwnership`.
- **`notifier`** — set by the owner via `setNotifier(address)`, and allowed
  to call `notifyRewardAmount()` and nothing else. This is the tax wallet's
  hot key that `treasury/fund-staking.js` holds. Defaults to `address(0)`
  (disabled) until the owner explicitly sets it — nothing is wired up until
  someone with the owner key deliberately does so.

If the notifier key ever leaks, the worst it can do is call
`notifyRewardAmount()` (spend whatever native value is sent alongside the
call — the attacker's own funds, not stakers') or grief future reward rates
by calling it with a tiny amount. It cannot reassign itself as owner,
change `rewardsDuration`, or touch `recoverERC20`.

## What this is not (yet)

- **Not deployed.** No `STAKING_CONTRACT_ADDRESS` exists yet — see
  Deployment below. The site's Roadmap section reflects this ("Phase 2:
  Treasury Online").
- **Not audited.** This has solid test coverage (staking/withdrawal
  accounting, proportional reward math across staggered stakers, reward
  rollover, a live reentrancy-attack test, access control including the
  notifier role) but test coverage and an audit are different things. Get
  a real audit — or at minimum multiple independent experienced eyes —
  before real value flows through this on mainnet.
- **No lock-up.** Stake and withdraw anytime. Simpler and safer for a
  first version; a locked/boosted-APY variant is a reasonable v2, not a
  v1 requirement.
- **Owner is a real privilege.** Deploy with a multisig as the owner, not
  a single EOA — the deploy script refuses to run without an explicit
  `STAKING_OWNER_ADDRESS` for exactly this reason.

## Development

```bash
npm install
npx hardhat test        # 17 tests: accounting, reward math, admin, notifier, reentrancy
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

After deploying, the owner still needs to call `setNotifier(taxWalletAddress)`
once (from the multisig) before `treasury/fund-staking.js` can do anything —
deploy.js does this for you if `STAKING_NOTIFIER_ADDRESS` is set, or it can
be done later as a separate transaction.
