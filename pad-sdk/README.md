# sdoge-pad-sdk

TypeScript SDK for [SDOGE Pad](https://pad.stabledoge.site), the SDOGE
token launchpad on Arc. Find launches the block they happen, quote, buy,
sell, launch tokens and claim creator fees. Built on [viem](https://viem.sh).

Bots are welcome. SDOGE Pad has no anti-snipe window, no max buy, no max
wallet, no cooldown and no blacklist, in the tokens or the hook. The first
block of every launch is open to anyone.

## How the pad works (what a bot needs to know)

- Every launch is a plain ERC-20 with a fixed 1,000,000,000 supply, trading
  against **USDC** on its own **Uniswap v4** pool (1% LP fee, tick spacing
  200) from the first block. No bonding curve, no migration.
- The whole supply starts in one single-sided position, so **the first trade
  on a launch has to be a buy**. Sells work once buyers have put USDC in.
- Each launch has a **tax of 0-10% per side**, chosen by its creator and
  fixed forever. It's taken **in USDC** on every swap, never in the token.
  90% goes to the creator, 10% to the platform.
- **USDC is also Arc's gas token.** A buy keeps $0.10 back for gas by default
  (`gasReserveUsdc`).
- Swaps go through Arc's Universal Router with Permit2. By default each
  trade approves exactly what it spends, and the router's allowance expires
  after a day. A bot that trades often can pass `approvals: 'unlimited'` to
  approve once and skip two transactions per trade.

## Install

Not on npm yet. From this repo:

```
cd pad-sdk
npm install
npm run build
npm test          # offline checks
```

Then import from `pad-sdk/dist/index.js`, or `npm install /path/to/pad-sdk`
in your bot's folder and import from `sdoge-pad-sdk`.

## Quick start

Read-only:

```js
import { createPublicClient, http } from 'viem';
import { arc, createPadClient } from 'sdoge-pad-sdk';

const pad = createPadClient({ publicClient: createPublicClient({ chain: arc, transport: http() }) });

const launches = await pad.getLaunches();           // every launch, oldest first
const t = await pad.getToken(launches.at(-1).token); // pool key, taxes, live price
console.log(t.priceUsd, t.marketCapUsd);

const tokensOut = await pad.quoteBuy(t.token, 5_000_000n); // $5 in, after tax, fee and impact
```

Trading:

```js
import { createArcClients, createPadClient } from 'sdoge-pad-sdk';

const { publicClient, walletClient } = createArcClients(process.env.PRIVATE_KEY);
const pad = createPadClient({ publicClient, walletClient });

// Buy $5 the moment anything launches, 5% max slippage.
pad.watchLaunches(async (launch) => {
  const { hash } = await pad.buy({ token: launch.token, usdcIn: 5_000_000n, slippageBps: 500 });
  console.log('bought', launch.symbol, hash);
});
```

Runnable versions: `examples/watch-launches.mjs`, `examples/buy-new-launches.mjs`
(a small sniper) and `examples/market-api.mjs`.

## `createPadClient({ publicClient, walletClient?, config?, gasReserveUsdc?, approvals? })`

Amounts are raw units: USDC has 6 decimals, launch tokens 18.

| Method | What it does |
|---|---|
| `isLive()` | Whether the pad is switched on (launches can open pools). |
| `getLaunches({ fromBlock?, toBlock? })` | Every launch in a range, oldest first. |
| `watchLaunches(onLaunch, { pollIntervalMs?, fromBlock?, onError? })` | Calls back on each new launch as soon as its block is visible (polls every 500 ms by default). Returns a stop function. |
| `getToken(token)` | Pool key and id, taxes, splitter, locker, sqrt price, tick, `priceUsd`, `marketCapUsd`. |
| `quoteBuy(token, usdcIn)` / `quoteSell(token, tokensIn)` | Exact output from the live pool, tax and fee included. Moves nothing, needs no balance. `0n` means nothing to fill against yet. |
| `buy({ token, usdcIn, slippageBps?, amountOutMin?, deadlineSec? })` | Checks the balance (plus the gas reserve), quotes, sets approvals if needed, swaps. Default slippage 300 (3%). |
| `sell({ token, amountIn, slippageBps?, amountOutMin?, deadlineSec? })` | Same for selling. |
| `launch({ name, symbol, startingMarketCapUsd?, buyTaxBps?, sellTaxBps? })` | Launches a token (opening market cap from $100, default $1,000; taxes 0-1000 bps). Returns the parsed `LaunchCreated`. |
| `pendingTax(token)` / `flush(token)` | Tax the hook is holding for a launch, and moving it to the launch's splitter (anyone can call). |
| `harvestFees(token)` | Collects the launch's LP fees into its splitter (anyone can call). |
| `creatorBalance(token)` / `claim(token, to?)` | The creator's claimable USDC, and claiming it (creator only). |

Lower-level pieces are exported too: `poolKeyFor`, `poolIdOf`, `readSlot0`,
`priceFromSqrt`, `buildExactInSwap`, `quoteExactIn`, `withSlippage`, every ABI,
and `ARC_MAINNET` (all contract addresses).

## HTTP API

The pad site serves the same data as JSON, with no key and CORS open to
every origin. `createPadApi()` wraps it.

| Endpoint | Returns |
|---|---|
| `GET /api/v1/config` | Chain, RPC, every contract address, pool settings, whether the pad is live. |
| `GET /api/v1/launches?limit=50&before=<block>` | Launches, newest first. |
| `GET /api/v1/market?limit=30` | Live price, market cap and change since launch of the newest launches. |
| `GET /api/v1/tokens/<address>` | One launch: pool details, live price, tax waiting to be flushed, description and links. |

Base URL: `https://pad.stabledoge.site`.

## Contracts on Arc mainnet (chain 5042)

| | Address |
|---|---|
| SdogePadPortal | `0x7F80b1198e6DAa56b0019Cb45020382358E385Fd` |
| SdogePadHook | `0x10dE365Cc583bA953a9e6C36658A138082d9e8cc` |
| SdogePadTreasury | `0x5B2A7f99b3Bd79211b2154dC997f2F8c3CAaF3Aa` |
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| Universal Router | `0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| USDC | `0x3600000000000000000000000000000000000000` |

Source for all of it is in `../pad`, verified on Sourcify.

## License

MIT
