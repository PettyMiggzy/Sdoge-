# SDOGE Pad (contracts)

The launchpad contracts behind SDOGE Pad: anyone can launch a token on Arc
that trades against USDC on a real Uniswap v4 pool from its first block.
There is no bonding curve, no graduation and no migration.

**Status:** deploying on Arc mainnet. The addresses below are already fixed:
they follow from the deploy wallet's first transactions and this exact build.
Once deployed, the pad stays switched off until the pad admin sends one
transaction (step 2 under "Deploy"). Full record: `deployments/arc-mainnet.json`.

| Contract | Address |
|---|---|
| SdogePadTreasury (owner `0x5899…5914`) | `0x5B2A7f99b3Bd79211b2154dC997f2F8c3CAaF3Aa` |
| SdogePadHook | `0x10dE365Cc583bA953a9e6C36658A138082d9e8cc` |
| SdogePadPortal (main pad) | `0x7F80b1198e6DAa56b0019Cb45020382358E385Fd` |

The contracts were audited twice in September 2026; `test/AuditFixes.t.sol`
covers every fix. Dependencies are pinned to exact commits (`foundry.lock`,
submodules under `lib/`).

## How a launch works

1. **`SdogePadPortal.createLaunch(name, symbol, startingMarketCap, buyTax, sellTax)`**
   is permissionless and costs only gas. In one transaction it:
   - mints a plain ERC-20 with a fixed 1,000,000,000 supply (no owner, no
     mint, no transfer tax);
   - opens a USDC pool (1% LP fee, tick spacing 200) at the creator's
     chosen opening market cap, anywhere from $100 up;
   - puts the whole supply into a single-sided position held by a locker
     that never gives it back.
2. **Trading starts at once** on that pool. Right after launch the position
   is all token, so the first trade has to be a buy; selling works as soon
   as buyers have put USDC in.
3. **Tax** is the creator's choice at launch, 0–10% per side, and can never
   change. The shared hook takes it in USDC on every swap, buy or sell,
   never in the launch token.
4. **Revenue** (the tax plus the USDC side of the LP fees) splits
   **90% to the creator and 10% to the platform**. Nothing moves during a
   swap: the hook holds the tax until anyone calls `flush`. The creator then
   calls `claim` on their launch's splitter, and anyone can call
   `claimPlatform` to send the platform's 10% to `SdogePadTreasury`.
5. **The treasury** is deliberately simple. It receives USDC, and its owner
   can `withdraw` it. There is no swap logic and nothing automatic; what the
   platform cut is spent on is the owner's call. Ownership moves in two
   steps (`transferOwner` + `acceptOwner`), so it can go to a Safe later.

No trading restrictions, by design: no anti-snipe window, max buy, max
wallet, cooldown, blacklist or pause, in the token or the hook. Those are
what token scanners (GoPlus, honeypot.is, TokenSniffer) flag.
`test_NoTradingRestrictions_*` checks that a launch-block buy, a full
sell-back and a free wallet-to-wallet transfer all work.

## Security properties (from the audits)

- **Pool creation is gated.** Only an authorized portal can initialize a
  pool on the hook, so nobody can front-run a launch by creating its pool
  first.
- **Only a launch's own locker can add liquidity**, so nobody can dodge the
  tax with a range order.
- **A taxed swap fills in full or reverts**, exact-output swaps pay the same
  rate as exact-input ones, and a swap that fills nothing reverts (no free
  price pushes).
- **Revenue never moves inside a swap.** A blocklisted treasury or creator
  can only block its own claim, never trading.
- **The white-label factory slot is one-shot** and can be renounced. See
  below.

`test/AuditFixes.t.sol` covers each fix, and every fix was mutation-checked:
reverting any one makes a test fail.

## Tests

```
git submodule update --init --recursive pad/lib   # from the repo root
cd pad
forge test                                         # 36 passed, 1 skipped
ARC_FORK_URL=https://rpc.mainnet.arc.io forge test --match-contract ForkArcTest -vv
```

The skipped test is `ForkArcTest`. It needs an Arc RPC. It deploys a fresh
SDOGE Pad onto a mainnet fork (the real PoolManager and USDC) and runs a
launch, a launch-block buy, a sell-back, a flush and the creator's claim.
Arc's two native-USDC precompiles are stubbed with behavior read from a
live mainnet trace.

## Deploy (Arc mainnet)

Three roles, which can be three different wallets:

| Role | What it does | Setting |
|---|---|---|
| Deploy wallet | Pays about 0.3 USDC of gas. Keeps no power afterwards when the other two are different wallets, so a throwaway is fine. | the wallet running the script |
| Treasury owner | Owns `SdogePadTreasury`, which collects the platform's 10%. Can withdraw any time, and hand ownership on. | `TREASURY_OWNER` |
| Pad admin | The hook's permanent admin: switches the main portal on and decides the white-label slot. Can never be changed. | `PAD_ADMIN` (defaults to `TREASURY_OWNER`) |

The owner's wallet for both roles is
**`0x5899a0576A94327a6316E01190f951edf7645914`**, the wallet that created $SDOGE.

1. **Deploy.** On Linux, macOS or WSL:

   ```
   curl -L https://foundry.paradigm.xyz | bash && foundryup
   git clone --recurse-submodules https://github.com/PettyMiggzy/Sdoge-
   cd Sdoge-/pad
   forge test                                     # expect: 36 passed, 1 skipped
   cast wallet import sdogepad-deployer --interactive   # the deploy wallet's key, stored encrypted
   TREASURY_OWNER=0x5899a0576A94327a6316E01190f951edf7645914 \
   forge script script/DeploySdogePad.s.sol:DeploySdogePad \
     --rpc-url https://rpc.mainnet.arc.io --broadcast \
     --account sdogepad-deployer --sender <deploy wallet address>
   ```

   Don't put a private key in `pad/.env`: forge loads that file
   automatically. The script mines the hook address (flags `0x28CC`) with
   Uniswap's pure-Solidity `HookMiner`, with no ffi. For pad admin
   `0x5899…5914` the hook lands at
   `0x10dE365Cc583bA953a9e6C36658A138082d9e8cc` (it depends only on this exact
   build and the pad admin). A different hook address means a different build:
   stop and check.

2. **Switch it on.** When the pad admin isn't the deploy wallet, the pad is
   deployed switched off (no pool can be created), and the pad admin sends
   one transaction, which the script prints at the end:

   ```
   cast send <hook> 'bootstrapMainPortal(address)' <portal> \
     --rpc-url https://rpc.mainnet.arc.io --account <pad admin keystore>
   ```

   The explorer's "Write contract" tab on the hook, connected with the pad
   admin's wallet, does the same. If the pad admin runs the deploy itself,
   this happens inside the deploy.

3. **Verify the source.** Token scanners treat unverified source as a red
   flag.

   ```
   NETWORK=mainnet VERIFIER=sourcify \
   TREASURY=0x.. HOOK=0x.. PORTAL=0x.. DEPLOYER=<deploy wallet> \
   TREASURY_OWNER=0x5899a0576A94327a6316E01190f951edf7645914 \
   bash script/verify.sh
   ```

   After the first launch, run it again with `LAUNCH_TOKEN=<address>`. Every
   launch token has the same bytecode, so the explorer can match the rest.
   `VERIFIER=sourcify` avoids explorer.arc.io's Cloudflare check; drop it to
   use Blockscout. If Blockscout says "Address is not a smart-contract", its
   indexer is behind, so try again later.

4. **Record it.** Put the addresses and the portal's deploy block in
   `deployments/arc-mainnet.json` and the site's environment
   (`pad-web/.env.example` lists every variable).

5. **First launch.** From the site, launch a token, then do a small buy and
   sell, then `flush` and `claim`. Verify that launch token (step 3) and
   check it on GoPlus:
   `https://api.gopluslabs.io/api/v1/token_security/5042?contract_addresses=<token>`.

### The white-label slot

`WHITE_LABEL` only applies when the pad admin runs the deploy itself:

- `2` (default): leave it open. Only the pad admin can fill it later.
- `1`: deploy `SdogePadFactory` now, owned by the treasury owner (setup fee
  `PAD_SETUP_FEE`, default `100000000` = $100).
- `0`: renounce it for good. No white-label pads, ever.

When the pad admin is a different wallet, the slot stays open for the pad
admin to decide later, either with `script/DeployPadFactory.s.sol` or with
`hook.renounceFactoryBootstrap()`.

## White-label pads (later, optional)

`SdogePadFactory` sells anyone their own launchpad on the same shared hook,
for a setup fee (default $100, capped at $10k). On a white-label pad the
platform takes a fixed 15% of every launch's revenue, the pad owner sets
their own share from 0 to 85%, and creators get the rest. Each launch keeps
the split it launched with. Pad owners can also charge a launch fee of up
to $100, split 15/85. The factory contracts (`SdogePadFactory`, `PadPortal`,
`PadRevenueSplitter`) are newer than the last audit; have them audited
before plugging a factory in.

The hook accepts exactly one factory, ever, so settle these numbers first:

```
PORTAL=<SdogePadPortal> forge script script/DeployPadFactory.s.sol \
  --rpc-url https://rpc.mainnet.arc.io --broadcast \
  --account <pad admin keystore> --sender <pad admin>
```

The script reads the hook and treasury from the portal, checks the pad is
switched on, and the hook itself rejects any sender but the pad admin.

## Files

| File | What it is |
|---|---|
| `src/SdogePadHook.sol` | The shared v4 hook: pool gating, USDC tax, `flush`. |
| `src/SdogePadPortal.sol` | The main pad: `createLaunch`. |
| `src/SdogePadLaunchToken.sol` | The plain ERC-20 every launch mints. |
| `src/SdogePadLocker.sol` | Holds each launch's position forever; harvests LP fees. |
| `src/SdogePadRevenueSplitter.sol` | Per-launch 90/10 split (85/15 on white-label pads). |
| `src/SdogePadTreasury.sol` | Collects the platform cut; the owner withdraws. |
| `src/SdogePadFactory.sol`, `PadPortal.sol`, `PadRevenueSplitter.sol` | White-label pads. |
| `script/DeploySdogePad.s.sol` | Treasury + hook + portal in one broadcast. |
| `script/DeployPadFactory.s.sol` | Plugs a factory into a live SDOGE Pad hook. |
| `script/verify.sh` | Source verification (Blockscout or Sourcify). |
