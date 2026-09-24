# $SDOGE Staking Keeper

**Status: disabled (no schedule), kept only as reference.** The audit found it can't work as
configured and must not be re-enabled as is:
- The configured tax wallet is a contract (a fee-splitter clone), so no private key exists
  for it.
- Run 1 would treat the wallet's whole existing balance as new revenue.
- State lives in a git-committed file, so a failed push re-sends on the next run.
- The notifier key sits in CI next to npm-installed code and a write token.

Staking is funded by the team's Safe from NFT profits instead:
- Studio.withdraw() and marketplace fees go to the staking contract's `contributeUSDC`.
- The owner (or notifyUnallocated) streams that USDC out.

If automation comes back, use a dedicated funding wallet with explicit amounts, idempotent
runs keyed on chain state, SHA-pinned actions, and `persist-credentials: false`.

**Earlier status note: not the current plan, kept as reference infrastructure.**
Staking's primary funding source is now the contract's own early-withdrawal
penalty (self-funded by stakers, zero tax/Treasury involvement) — see
`../contracts/README.md`. The tax-revenue split this script implements
(Treasury 50% / Buyback 30% / Staking 20%) was built, then set aside before
shipping, because it still spends the project's own tax revenue rather than
funding rewards for free. This script and workflow are left in place,
inert, in case the tax-revenue path is revisited later — they don't run
against anything live and don't need to be deleted to build the penalty
path.

Watches the tax wallet, skims Staking's 20% cut off any newly-arrived tax
revenue, and sends it to the deployed `SDOGEStaking` contract. Runs as a
GitHub Actions cron job, same pattern as `bot/`.

## How it works

$SDOGE's 1% trade tax accumulates as native USDC at one known address —
`0xddab9022421c30391e9ec5ae6d0887c8adb88980`, the same wallet the buy bot
already excludes from buy alerts (found and confirmed there as the tax
collector, not a real buyer — see `bot/README.md`). Today, a human manually
swaps the tax's SDOGE for USDC and moves it into the Treasury/buyback flow.

This script does **not** replace or automate that. It has no visibility
into how the team executes Treasury deposits or buybacks, and shouldn't
guess. All it does, every run:

1. Reads the tax wallet's current native balance and compares it to
   `treasury/state.json`'s last-seen checkpoint.
2. If the balance **increased** — new tax revenue landed — it takes 20% of
   the increase and calls `notifyRewardAmount()` on `SDOGEStaking` with it,
   then moves the checkpoint up by exactly that much. The other 80% is left
   sitting in the wallet, completely untouched, for the existing manual
   Treasury/buyback process to pick up whenever it normally would.
3. If the balance **decreased or stayed the same** — the team's own manual
   sweep for Treasury/buyback ran since the last check — it just rebases
   its checkpoint to the new balance and does nothing else. It never tries
   to interpret or account for that drop; it's not this script's process.
4. If the 20% cut is below `MIN_STAKING_CUT_USDC` (default 5), it skips
   sending and leaves the checkpoint where it was, so small amounts
   accumulate across runs instead of triggering a wasted (or reverted —
   see the contract's own minimum reward-rate guard) transaction every
   time.

Every one of those branches was exercised against a real local chain (a
throwaway Hardhat node, not just unit-tested in isolation) before this was
considered done — including the "team drains the wallet mid-stream" case,
the dust-accumulates-across-runs case, and a deliberately-wrong private key
to confirm the script refuses to send from an unexpected address rather
than silently doing so.

## The `notifier` role (why this doesn't need the owner key)

`notifyRewardAmount()` needs to be callable by this automated keeper, which
means a hot wallet has to hold a key that can call it. But the contract's
`owner` is meant to be a secure multisig with broader admin powers
(`setRewardsDuration`, `recoverERC20`, reassigning the owner itself) — that
key should never be needed by, or exposed to, an automated script.

`SDOGEStaking` splits this: the owner calls `setNotifier(taxWalletAddress)`
**once**, from the multisig, and from then on that address can call
`notifyRewardAmount()` without needing owner privileges for anything else.
See `contracts/README.md` for the full access-control writeup. Until that
one-time `setNotifier` call happens, this script's transactions will
correctly revert (`"not owner or notifier"`) — that's expected, not a bug,
until the team has actually deployed staking and wired it up.

## Configuring it

Non-secret config lives in committed `treasury/config.json`:

- `TAX_WALLET_ADDRESS` — already filled in:
  `0xddab9022421c30391e9ec5ae6d0887c8adb88980`.
- `STAKING_CONTRACT_ADDRESS` — **empty until `SDOGEStaking` is deployed.**
  The script logs a clear "nothing to do yet" message and exits cleanly
  when this is blank, rather than erroring — expected state until then.
  Fill this in once `contracts/scripts/deploy.js` has run.
- `STAKING_BPS` — `2000` (20%), matching the site's Tokenomics split.
- `MIN_STAKING_CUT_USDC` — `5`, the dust threshold described above.

**One thing has to go through GitHub Secrets** — the tax wallet's private
key is about as sensitive as a credential gets on this project (it
controls real, already-collected tax revenue), so it can never live in
`config.json`:

`TAX_WALLET_PRIVATE_KEY` — add it at:
**https://github.com/PettyMiggzy/Sdoge-/settings/secrets/actions/new**
— name `TAX_WALLET_PRIVATE_KEY`, paste the tax wallet's private key, save.
The script checks the key actually corresponds to `TAX_WALLET_ADDRESS`
before ever sending a transaction, and refuses (loudly, without touching
`state.json`) if they don't match — a misconfigured secret fails safely
instead of silently sending from the wrong address.

`ARC_RPC_FALLBACK_URL` is optional and reuses the exact same secret the buy
bot uses, if already set — see `bot/README.md`'s RPC section.

## Testing before it touches real funds

```bash
cd treasury
npm install
ARC_RPC_URL=https://rpc.mainnet.arc.io DRY_RUN=true node fund-staking.js
```

`DRY_RUN=true` logs exactly what it would send without broadcasting a
transaction or touching `state.json` — safe to run anytime, including
against mainnet, to sanity-check the numbers before trusting it further.

Before ever setting `TAX_WALLET_PRIVATE_KEY` as a real secret, test the
full send path against a local chain (a throwaway Hardhat node from
`contracts/`, not mainnet) with a disposable test key — never the real tax
wallet key — to confirm your specific `STAKING_CONTRACT_ADDRESS` and
`notifier` setup actually works end-to-end first.

## Operational notes

- **Runs every 6 hours**, not every 5 minutes like the buy bot — tax
  revenue accumulates slowly and every run costs real gas, so there's no
  reason to poll as aggressively.
- State is committed as a real git commit on every run, same pattern as
  `bot/state.json`.
- A failed run (bad RPC, misconfigured key, contract not yet deployed)
  never advances `state.json`, so nothing is ever silently lost — the next
  successful run picks up the full accumulated amount since the last
  checkpoint, exactly as if nothing had gone wrong.
