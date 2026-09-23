# $SDOGE Staking

Stake $SDOGE, earn a share of yield the treasury earns elsewhere — funded by
putting the existing 1% buy tax to work (e.g. depositing it into Aave or
Morpho's USDC market on Arc, both live at mainnet launch), not by minting
new SDOGE or paying rewards out of pocket.

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

## How the yield actually gets here

This contract does **not** talk to Aave/Morpho itself — it only pays out
whatever native USDC the owner sends it. The funding flow is a separate,
off-chain-triggered step:

1. Treasury deposits its accumulated tax-USDC into Aave/Morpho on Arc.
2. Periodically (e.g. weekly, matching `rewardsDuration`), withdraw the
   interest earned and call `notifyRewardAmount()` on this contract with
   that amount as `msg.value`.
3. Stakers' rewards now accrue from that amount over the next
   `rewardsDuration` (default 7 days), claimable any time via
   `getReward()` (or `exit()` to withdraw stake + claim in one call).

Step 2 can start as a manual admin action — there's no reason to automate
the treasury→Aave→harvest pipeline before the staking contract itself has
been live and used for a while.

## What this is not (yet)

- **Not audited.** This has solid test coverage (staking/withdrawal
  accounting, proportional reward math across staggered stakers, reward
  rollover, a live reentrancy-attack test, access control) but test
  coverage and an audit are different things. Get a real audit — or at
  minimum multiple independent experienced eyes — before real value flows
  through this on mainnet.
- **No lock-up.** Stake and withdraw anytime. Simpler and safer for a
  first version; a locked/boosted-APY variant is a reasonable v2, not a
  v1 requirement.
- **Owner is a real privilege.** `notifyRewardAmount` and
  `setRewardsDuration` are owner-only. Deploy with a multisig as the
  owner, not a single EOA — the deploy script refuses to run without an
  explicit `STAKING_OWNER_ADDRESS` for exactly this reason.

## Development

```bash
npm install
npx hardhat test        # 14 tests: accounting, reward math, admin, reentrancy
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
