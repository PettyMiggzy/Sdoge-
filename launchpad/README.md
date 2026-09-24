# Meme-token launchpad (Telegram-launched, no UI)

A separate, generic Uniswap v4 launchpad for Arc — anyone launches a token via
a Telegram bot command, not this project's own site. Designed in a different
session (pasted in and saved here verbatim as source, not built or discussed
in this repo's own history before now) — this README captures what changed
on the way in and what's still open.

**Status: saved, not compiled, not tested, not deployed.** This is its own
[Foundry](https://getfoundry.sh/) project, kept separate from `contracts/`
on purpose — that directory is a Hardhat project (OpenZeppelin via npm,
`hardhat.config.js`), and mixing the two toolchains into one folder risks
real conflicts (remappings, build artifacts, dependency resolution). Nothing
here has touched `contracts/`.

## What it is

One tx (`LaunchpadFactory.launch(name, symbol, uri)`) does everything:
deploys a fixed-supply ERC-20 (`LaunchToken`), creates a Uniswap v4 pool
paired with USDC, and seeds the *entire* supply as a single-sided liquidity
position with no withdraw function — LP is locked by construction, no
"graduation" step, no separate curve contract. A single hook
(`LaunchpadHook`) applies a 2% fee on every swap's USDC leg: buys split
25% to a per-token `MemeVault` / 50% to `platform` / 25% to the token's
creator; sells go 100% to `platform`. `MemeVault` holds real USDC and lets
holders burn tokens to redeem a pro-rata share — a real floor price, since
buying below it is a free arbitrage (buy from the pool, redeem at the vault).

`platform` is a single configurable address (`setPlatform`, owner-gated) —
the natural connection to *this* project: point it at an SDOGE buyback
splitter later, so every launch on the pad feeds $SDOGE buybacks. Not
wired up; just what the constant is there for.

## The one real fix made while saving this

The original draft (before the version saved here) used native value
(`address(0)`, 18 decimals) as `currency0`. That's wrong for Arc: every
pool on Arc's shared PoolManager — confirmed against **this repo's own
live SDOGE/USDC pool**, not assumed — accounts USDC through the ERC-20
view at `0x3600000000000000000000000000000000000000` with **6 decimals**
(`bot/config.json`'s `USDC_POOL_DECIMALS`, verified earlier against a real
on-chain Swap event's decoded amount matching a known real-dollar buy — see
`bot/README.md`'s "Why Swap events, not tx.value"). The version saved here
already has that fix applied throughout (`LaunchpadHook`, `MemeVault`,
`LaunchpadFactory`'s `VIRTUAL_USDC = 5_000e6`) — the original transcript's
back-and-forth about which decimals to use is resolved, not left open.

Also folded in: `LaunchpadFactory` mines a CREATE2 salt so a launched
token's address always sorts above the USDC address (`_deployTokenAboveUsdc`)
— a plain `new LaunchToken(...)` would land below USDC about 1 in 5 times
and silently flip the token into `currency0`, breaking every direction
check in the hook. Cheap (≈1.3 iterations average) and now unconditional,
not a follow-up.

## The four open questions, answered against live Arc data

Checked directly against Arc mainnet (`https://rpc.mainnet.arc.io`), not
assumed — commands are reproducible with `curl`/`cast`:

1. **Is `currency0` of the real SDOGE/USDC pool `0x3600...`?** Yes.
   `bot/buy-bot.js`'s own live, production-verified decoder computes this
   the same way (`usdcIsCurrency0: BigInt(usdcView) < BigInt(token)`,
   `bot/buy-bot.js:385`) — v4 sorts currencies by raw address, and
   `0x3600...` < `0xf8df98...` (SDOGE), so USDC is `currency0`. This is
   exactly the invariant `LaunchpadFactory._deployTokenAboveUsdc` enforces
   for every future launch.
2. **Pool USDC decimals — `0.49e6` or `0.49e18`?** `0.49e6` — 6 decimals.
   Already the resolved fact behind `VIRTUAL_USDC = 5_000e6` above; nothing
   new here, restated for completeness against the checklist.
3. **Does the CREATE2 deployer exist on Arc?** Yes, confirmed live:
   `eth_getCode` on `0x4e59b44847b379578588920cA78FbF26c0B4956C` returns
   the standard non-empty "Nick's method" factory bytecode
   (`0x7fffffff...5bf3`), not `0x`. `script/Deploy.s.sol`'s
   `CREATE2_DEPLOYER` constant is good as-is — no fallback deployer needed.
4. **Argus pool fee/tickSpacing — match theirs?** Pulled the real
   `Initialize` event for the live SDOGE/USDC pool
   (`PoolManager` at block `22350355`, `topics[0]` =
   `keccak256("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)")`,
   `topics[1]` = `POOL_ID`) and decoded it: **`fee = 10000` (the standard
   Uniswap 1% tier), `tickSpacing = 200`** (the standard pairing for that
   tier) **, and a non-zero hook: `0x572c15cdf8902231f0d8b35432dfc817d726a044`**.
   So SDOGE's own pool is not a plain fee-only pool — it already runs
   through a real hook whose logic isn't known here (not this repo's
   contract, source unseen). Deliberately **not copying this**: matching
   `fee`/`tickSpacing` alone wouldn't make launchpad pools economically
   indistinguishable from Argus's anyway (different hook, different
   economics), and setting a nonzero static `fee` in `PoolKey` alongside a
   hook that already takes its own cut via `beforeSwap`/`afterSwap` deltas
   risks double-charging or fighting the pool's own fee accounting — our
   `fee: 0` ("the hook IS the fee") is the safer, deliberate choice from
   the original design and stays unless someone decides the cosmetic
   indexer-matching is worth that risk. Only found because this pool
   happened to fall in the very first 10k-block window searched after the
   token's own deploy block (found via binary search on `eth_getCode`,
   since Arc's `eth_getLogs` caps ranges at 10,000 blocks) — a lucky first
   guess, not an indication the same shortcut works for arbitrary pools.

## Still genuinely open (not resolved by the fix above)

- **`v4-periphery`'s exact API** — this targets the `SwapParams`/
  `ModifyLiquidityParams` location in `PoolOperation.sol` (current `main`
  as of when this was written). An older pinned commit may have those
  types on `IPoolManager` instead — the only thing that would need touching.
- **Not compiled.** `forge install` hasn't been run (would pull
  `uniswap/v4-core`, `uniswap/v4-periphery`, `OpenZeppelin/openzeppelin-contracts`
  as git submodules — a real network operation, not done automatically
  just to save these files). Do that before trusting it compiles as-is.
- **No tests.** The original design discussion flagged a fork test (one
  buy, one sell, assert `owed[platform]` moves and `floor()` goes nonzero)
  as the next step — not written yet.
- **Not integrated** with `bot/` or the site. Wiring notes below are the
  plan, not implemented.

## Setup

```bash
cd launchpad
forge install uniswap/v4-core uniswap/v4-periphery OpenZeppelin/openzeppelin-contracts
PLATFORM=0x... forge script script/Deploy.s.sol \
  --rpc-url https://rpc.mainnet.arc.io --private-key $DEPLOYER_PRIVATE_KEY --broadcast
```

## Wiring it to what already exists (planned, not built)

A launched pool looks identical to any other Arc/Argus pool to every
existing tool here — `POOL_ID` just comes from the `Launched` event instead
of being found by scanning history. The buy bot's Swap-event scanner
(`bot/buy-bot.js`) would work against it unchanged once pointed at the new
`POOL_ID`. The Telegram `/launch` command would be one call:

```js
const factory = new ethers.Contract(
  FACTORY,
  [
    'function launch(string,string,string) payable returns (address,address,bytes32)',
    'event Launched(uint256 indexed index, bytes32 indexed poolId, address token, address vault, address creator, string name, string symbol, string uri)',
  ],
  master
);
const tx = await factory.launch(name, symbol, imageUrl, { value: ethers.parseUnits('2', 18) });
const rc = await tx.wait();
const { poolId, token, vault } = factory.interface.parseLog(
  rc.logs.find((l) => l.address === FACTORY)
).args;
// -> register poolId with a buy bot instance + trending indexer, post the launch card
```

## Next steps, if this gets picked up

1. `forge install` the three deps, `forge build`, fix whatever the actual
   installed `v4-periphery` version needs.
2. Write the fork test (one buy, one sell, assert the fee split and
   `floor()`).
3. Verify the CREATE2 deployer on Arc before any real deploy.
4. Decide whether `platform` should be an SDOGE buyback splitter from
   day one, or a plain treasury address to start.
