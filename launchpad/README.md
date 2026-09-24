# Meme-token launchpad (Uniswap v4 on Arc)

The on-chain half of the Telegram launchpad in `../tgpad/`. Anyone can launch a token in one transaction. Every token gets a **meme vault**: real USDC, fed by its buys, that holders can redeem against.

**Status: rebuilt after the audit, compiled, 61 Foundry tests passing; not deployed yet; re-audit pending.** This is its own [Foundry](https://getfoundry.sh/) project, separate from the Hardhat project in `../contracts/`.

## How it works

`LaunchpadFactory.launch(name, symbol, uri)` (pay `launchFee` in native USDC; 2 USDC by default) does everything in one transaction:

- **Deploys `LaunchToken`.** It's a plain fixed-supply ERC-20: 1B tokens, no owner, no mint, no fees, no pause.
- **Deploys the token's `MemeVault`.**
- **Creates a Uniswap v4 pool against USDC and puts the whole supply into it** as one single-sided position, from (almost) `MIN_TICK` up to the launch price.
  - The position belongs to the factory, which has no function to remove it, so **the liquidity is locked forever**.
  - Constant liquidity over that range *is* a constant-product curve with $4,995.40 of virtual USDC. There's no separate bonding-curve contract and no graduation step.

`LaunchpadHook` runs every launchpad pool:

| | Buy (USDC in) | Sell (USDC out) |
|---|---|---|
| Fee | 2% of the USDC side | 2% of the USDC side |
| To the token's vault | 0.5% | 0 |
| To the token's creator | 0.5% | 0 |
| To the platform | 1% | 2% |

- **The fee is 2% in every swap shape:** exact-in or exact-out, buy or sell.
- **Fees are never moved during a swap.** They're minted as ERC-6909 USDC claims inside the PoolManager: the vault's share straight to the vault, the rest to the hook.
- **Creators collect with `hook.claim(creator)`.** The platform's share goes to the factory's `feeRecipient` via `hook.claimPlatform()`. Anyone can trigger either one, and the USDC only ever goes to its owner.

### The meme vault

```
floor           = backing / effectiveSupply
backing         = USDC held by the vault + its USDC claims in the PoolManager
effectiveSupply = totalSupply - tokens at 0x...dEaD - tokens held by the vault
```

- **Every token shares the backing equally, including the tokens still sitting in the pool.** `redeem(amount, minUsdcOut, to)` burns tokens and pays exactly their share, rounded down in the vault's favour.
- **The floor only goes up.** Buys add USDC. Sells and transfers don't touch it. Redemptions, burns and tokens sent to `0x…dEaD` only raise it (fuzz-tested).
- **Nothing can inflate a redemption.** The denominator is the token's supply, which no swap, flash loan or flash swap can move. `redeem` also refuses to run inside a PoolManager unlock.
- **The floor pulls the price up.** While the market price is below the floor, buying and redeeming is free money. That arbitrage is what lifts the price.

Read the floor with `floorPrice()` (USDC per whole token, 18 decimals: `1e18` = $1) and a payout with `quoteRedeem(amount)` (6-decimal USDC).

### `LaunchpadRouter`

What the Telegram bot trades through:

| Function | What it does |
|---|---|
| `buy(token, usdcIn, minTokensOut, to, deadline)` | Pays with ERC-20 USDC; approve the router first. |
| `buyWithNative(token, minTokensOut, to, deadline)` | Pays with `msg.value`. One transaction, no approval. |
| `sell(token, tokensIn, minUsdcOut, to, deadline)` | Approve the router for the tokens first. |
| `quoteBuy(token, usdcIn)`, `quoteSell(token, tokensIn)` | Exact quotes with the fee included. Call them with `eth_call`. |

- Trades are exact-in and fill completely or revert.
- The router holds nothing between transactions and only accepts tokens this factory launched.

### Admin

- **The factory's owner is an `Ownable2Step` owner:** the Treasury multisig, set in the constructor.
- **What it can do:**
  - set `launchFee`, either 0 or between 0.01 and 100 USDC. The bounds catch a fee accidentally entered in 6-decimal units.
  - set `feeRecipient`, which can't be `address(0)`.
- **What it can't do:** touch a pool, a token, a vault or anyone's fees, pause anything, or upgrade anything. `renounceOwnership` is disabled so the fee settings can't get stuck.
- **Launch fees stay in the factory** until anyone calls `withdrawLaunchFees()`. They're paid through the USDC ERC-20 view, so a fee-splitter contract without a payable `receive()` can be the recipient.

## What the audit found and what changed

| Finding | Fix |
|---|---|
| **Critical:** anyone could drain every vault in one transaction by flash-selling tokens inside a PoolManager unlock, which shrank the "tokens outside the pool" denominator, then redeeming. | The denominator is now the token's effective total supply, which swaps can't move. `redeem` also reverts inside an unlock. Regression tests replay the attack in one unlock and across unlocks. |
| **High:** `Deploy.s.sol` reverted with a multisig platform, and the only working setup left the deployer EOA as sole admin with no handover. | The factory deploys the hook itself, so `hook.factory` is fixed at construction and there's no `setFactory`. The multisig owns the factory from the first block. The script runs end to end in a test. |
| **High:** `redeem` ignored the vault's unclaimed fee share, had no minimum payout, and could burn tokens for 0. | The vault's share is minted straight to the vault, so the backing is always current. `minUsdcOut` added; a zero payout reverts. |
| **Medium:** `launch` pushed the fee to `platform`, which was also the only admin. A recipient that can't take native USDC (like the SDOGE splitter) would brick launches. | Pull-based fees, a separate owner and recipient, and payment through the ERC-20 view. |
| **Medium:** `floor()` was off by 1e18. | `floorPrice()` returns an 18-decimal price and is tested against a hand calculation. |
| **Medium:** dependencies weren't pinned and the README's install steps didn't compile. | Git submodules pinned to compatible commits (below). |
| **Medium:** a creator launched through a shared bot wallet would pay its fees to that wallet. | The bot gives every user their own wallet and launches from it. The hook also has a two-step `transferCreator` / `acceptCreator`. |
| **Low:** exact-in buys paid the fee on USDC that never traded when a price limit stopped them. | Exact-in buys and exact-out sells must fill completely. |
| **Low:** exact-out sells always reverted. | Supported, at the same 2%. |
| **Low:** exact-out buys paid 1.96%. | Now exactly 2% of the total paid. |
| **Low:** fees were `take`n before the swapper settled, so a `sync`-first locker paid twice. | ERC-6909 claims; nothing moves mid-swap. |
| **Low:** anyone could push the price to `MAX_SQRT_PRICE` for free (there's no liquidity above the launch price). | Sells can't end above the launch price. |
| **Low:** donations were stuck in the locked position. | `donate` reverts. |
| **Low:** burned and dEaD tokens diluted the vault forever. | They're excluded from `effectiveSupply`. |
| **Low:** tokens that left the pool forfeited their share to whoever held last (the "bounty"). | Every token shares the backing equally. |
| **Low:** the floor wasn't actually a floor: buys could lower it. | It now only goes up. |
| **Low:** `setPlatform(0)` and one-step handovers could brick admin. | Two-step owner and a non-zero recipient. |
| **Low:** `launchFee` was unbounded, silent and overpayable. | Bounded, emits an event, and must be paid exactly. |
| **Info:** rounding the start tick down set a $5,025 start. | Rounded to the nearest tick instead: $4,995.40. |

**Still true, by design:**
- **The USDC paid for redeemed tokens stays in the pool for good.** The position can never be withdrawn, and burned tokens can't be sold back, so that USDC is out of reach. It's the price of locked liquidity. It's small unless a large share of the supply is redeemed.
- **A buy needs full liquidity.** An exact-in buy either fills completely or reverts; a price-limited buy should use exact-out.

## Build and test

```bash
git submodule update --init --recursive   # v4-core 59d3ecf, v4-periphery 3779387, OpenZeppelin v5.7.0, forge-std
cd launchpad
forge build
forge test
```

Why those pins:
- **v4-periphery 3779387** is the last commit that still ships `utils/BaseHook.sol` and `utils/HookMiner.sol`.
- **v4-core 59d3ecf** is the exact commit that v4-periphery version pins.
- **The `@uniswap/v4-core/` remapping points at the same tree as `v4-core/`**, so types match.
- **The tests deploy a real v4-core `PoolManager`,** compiled under v4-core's own optimizer settings (see `foundry.toml`). USDC in the tests is a double of Arc's: a 6-decimal ERC-20 view over native balances.

## Deploy

```bash
cd launchpad
LAUNCHPAD_OWNER=0xTreasuryMultisig FEE_RECIPIENT=0xFeeRecipient \
forge script script/Deploy.s.sol --rpc-url https://rpc.mainnet.arc.io --broadcast --private-key $DEPLOYER_KEY
```

The script makes two transactions, the factory (which deploys the hook) and the router. It checks every address and setting, then prints `FACTORY_ADDRESS`, `HOOK_ADDRESS` and `ROUTER_ADDRESS` for `../tgpad/.env`.

## Arc facts this relies on (checked against mainnet)

- **USDC is `currency0` in every pool here.** Pools use USDC's ERC-20 view at `0x3600…0000` with **6 decimals**, which sorts below every launched token. The factory mines a CREATE2 salt so a token always lands above it.
- **Native USDC (18 decimals) and that ERC-20 view share one balance.** That's why the launch fee and `buyWithNative` take `msg.value`, while the pools and the fees use 6-decimal units.
- **PoolManager: `0x8366a39CC670B4001A1121B8F6A443A643e40951`.**
