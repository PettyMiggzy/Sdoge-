// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {SdogePadHook} from "../src/SdogePadHook.sol";
import {SdogePadPortal} from "../src/SdogePadPortal.sol";
import {SdogePadFactory} from "../src/SdogePadFactory.sol";
import {SdogePadTreasury} from "../src/SdogePadTreasury.sol";

/// @notice Deploys a fresh SDOGE Pad: its own `SdogePadTreasury`, its own
/// `SdogePadHook` and the main `SdogePadPortal` (isMainPad = true). The pad
/// shares only Arc's PoolManager and USDC with anything already on chain.
///
/// Two roles are fixed here, and neither has to be the wallet that pays gas:
///   TREASURY_OWNER  owns the treasury, which collects the platform's cut of
///                   every launch; it can withdraw at any time and can hand
///                   ownership on in two steps. Defaults to the deployer.
///   PAD_ADMIN       the hook's bootstrapper: the only address that can switch
///                   on the main portal and decide the one-shot white-label
///                   factory slot. It can never be changed. Defaults to
///                   TREASURY_OWNER.
/// When PAD_ADMIN is the deployer, the portal is switched on and WHITE_LABEL
/// is applied in this broadcast. When it isn't (a throwaway deploy wallet),
/// the pad is deployed switched off and PAD_ADMIN sends one transaction
/// later, printed at the end; the deploy wallet keeps no power at all.
///
/// Usage (see pad/README.md for the full runbook):
///   TREASURY_OWNER=0x.. forge script script/DeploySdogePad.s.sol:DeploySdogePad \
///     --rpc-url https://rpc.mainnet.arc.io --broadcast \
///     --account sdogepad-deployer --sender <deployer address>
///
/// Before running this against a real key with real funds:
///   1. `cast code 0x4e59b44847b379578588920cA78FbF26c0B4956C --rpc-url $ARC_RPC_URL`
///      must return non-empty bytecode. That's the canonical CREATE2
///      deployer proxy every EVM chain gets from the same pre-signed
///      deployment transaction — verified live on Arc mainnet
///      (chain id 5042); re-check if deploying anywhere else. If it's
///      missing, the hook-mining step below produces an address the actual
///      deploy doesn't match, and `run()` reverts on the `require` before
///      anything is spent.
///   2. The deployer must be funded with enough USDC-denominated gas (Arc
///      is USDC-native gas) to cover three contract deployments plus one
///      bootstrap call: about 0.3 USDC, so send it 1 USDC.
///   3. Build from the exact commit you deploy, with the toolchain pinned in
///      `foundry.toml` (`solc`, `evm_version`, `bytecode_hash`). The mined
///      salt is only valid for the exact init code it was mined against, and
///      the metadata hash in that init code covers every source byte, so
///      any edit, even to a comment, changes it (audit finding D-3). This
///      script mines and deploys in one run, so that holds automatically.
///
/// No `vm.ffi` anywhere in this script (audit findings D-4/D-6): hook
/// mining uses Uniswap's own pure-Solidity `HookMiner` library instead of
/// an external Python process, so there's no `ffi = true` dependency, no
/// `python3`/`pycryptodome` requirement on whoever runs this, and nothing
/// to audit in a scripting language outside Solidity.
contract DeploySdogePad is Script {
    // Uniswap v4 PoolManager on Arc — the same address on mainnet (5042)
    // and testnet (5042002). Re-check with `cast code` before deploying
    // anywhere else; don't hand-edit it from memory.
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    // Arc's native USDC predeploy — the ONLY quote asset the main pad's
    // Portal will ever use (audit fix M-1: quoteAsset is now fixed per
    // Portal at construction; a launch can't pick its own).
    address constant USDC = 0x3600000000000000000000000000000000000000;

    // Canonical CREATE2 deployer proxy (Nick's method / Arachnid's
    // deployer). This, not the broadcaster's own EOA, is the address a
    // salted `new X{salt: s}(...)` actually deploys from when Foundry
    // broadcasts it (audit finding D-2) — HookMiner.find's own doc comment
    // confirms this is exactly the value to mine against in a forge script.
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // Flags required post-audit (the 2026-09-22 audit's fixes — see SdogePadHook's
    // contract-level comment for the full reasoning):
    //   BEFORE_INITIALIZE               - gates pool creation to
    //                                      authorized portals (H-3)
    //   BEFORE_SWAP + ...RETURNS_DELTA  - taxes quote when it's the
    //                                      swap's specified leg (H-1)
    //   AFTER_SWAP + ...RETURNS_DELTA   - taxes quote when it's the
    //                                      swap's unspecified leg
    //   BEFORE_ADD_LIQUIDITY            - only a launch's own locker may
    //                                      add liquidity (2026-09-24 audit,
    //                                      hook-1: range orders dodged tax)
    // Without the RETURNS_DELTA bits, a hook's returned delta is
    // silently ignored and every real swap reverts with
    // CurrencyNotSettled(). Value 0x28CC.
    uint160 constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    function run() external {
        // Prefer a keystore or hardware wallet over a plaintext key in the
        // environment (audit deploy-config-3):
        //   forge script ... --broadcast --account <keystore-name> --sender <address>
        //   forge script ... --broadcast --ledger --sender <address>
        // DEPLOYER_PRIVATE_KEY still works when set.
        uint256 deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        address deployer = deployerKey != 0 ? vm.addr(deployerKey) : msg.sender;
        require(deployer != DEFAULT_SENDER, "pass --sender <address> with --account/--ledger (or set DEPLOYER_PRIVATE_KEY)");
        address treasuryOwner = vm.envOr("TREASURY_OWNER", deployer);
        address padAdmin = vm.envOr("PAD_ADMIN", treasuryOwner);
        require(treasuryOwner != address(0) && padAdmin != address(0), "TREASURY_OWNER and PAD_ADMIN must be real addresses");
        bool adminIsDeployer = padAdmin == deployer;
        uint256 whiteLabel = vm.envOr("WHITE_LABEL", uint256(2));
        require(whiteLabel <= 2, "WHITE_LABEL must be 0, 1 or 2");
        require(adminIsDeployer || whiteLabel == 2, "only PAD_ADMIN can decide the factory slot - leave WHITE_LABEL unset");
        console2.log("Deploying as:", deployer);
        console2.log("Treasury owner:", treasuryOwner);
        console2.log("Pad admin:", padAdmin);

        if (deployerKey != 0) vm.startBroadcast(deployerKey);
        else vm.startBroadcast();

        // The owner decides by hand what to do with accumulated platform
        // revenue. No swap logic, no keeper, nothing automated.
        SdogePadTreasury treasury = new SdogePadTreasury(treasuryOwner);
        console2.log("SdogePadTreasury:", address(treasury));

        // PAD_ADMIN, passed explicitly rather than captured as msg.sender in
        // the constructor, is who gets to bootstrap this hook (audit finding
        // D-1): under a forge broadcast the constructor's msg.sender is the
        // CREATE2 proxy, which would have bricked bootstrapping for good.
        bytes memory creationCode = type(SdogePadHook).creationCode;
        bytes memory constructorArgs = abi.encode(POOL_MANAGER, padAdmin);
        (address predictedHook, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, HOOK_FLAGS, creationCode, constructorArgs);

        // Re-check immediately before deploying, not just at mining time
        // (audit finding D-8): HookMiner.find already skips addresses with
        // existing code during its search, but mining is a view call and
        // the real broadcast happens moments later — this closes that gap.
        require(predictedHook.code.length == 0, "mined hook address already has code - re-mine with a fresh search");

        SdogePadHook hook = new SdogePadHook{salt: salt}(POOL_MANAGER, padAdmin);
        require(address(hook) == predictedHook, "hook address mismatch - build differs from the one mining was run against");
        require(
            uint160(address(hook)) & Hooks.ALL_HOOK_MASK == HOOK_FLAGS,
            "mined address does not actually carry the required flag bits"
        );
        console2.log("SdogePadHook:", address(hook));

        SdogePadPortal portal = new SdogePadPortal(POOL_MANAGER, address(hook), address(treasury), USDC, true);
        console2.log("SdogePadPortal (main pad):", address(portal));

        if (adminIsDeployer) {
            hook.bootstrapMainPortal(address(portal));
            console2.log("Main portal switched on.");
            // The hook's factory slot is one-shot. WHITE_LABEL picks what to
            // do with it in this same broadcast (2026-09-24 audit,
            // factory-trust-1):
            //   2 (default) leave it open to bootstrap a factory later
            //               (bootstrapFactory validates it). Until then only
            //               PAD_ADMIN can fill it, so keep that key safe.
            //   1           deploy SdogePadFactory, owned by TREASURY_OWNER,
            //               and bootstrap it now.
            //   0           renounce the slot: permanent, no white-label pads ever.
            if (whiteLabel == 2) {
                console2.log("Factory slot left open - only PAD_ADMIN can fill it, with hook.bootstrapFactory().");
            } else if (whiteLabel == 1) {
                uint256 setupFee = vm.envOr("PAD_SETUP_FEE", uint256(100e6)); // raw USDC units: 100e6 = $100
                SdogePadFactory factory =
                    new SdogePadFactory(POOL_MANAGER, address(hook), address(treasury), USDC, setupFee, treasuryOwner);
                hook.bootstrapFactory(address(factory));
                console2.log("SdogePadFactory (white-label pads):", address(factory));
            } else {
                hook.renounceFactoryBootstrap();
                console2.log("Factory slot renounced - no white-label pads on this hook.");
            }
        }

        vm.stopBroadcast();

        console2.log("---");
        if (!adminIsDeployer) {
            console2.log("The pad is deployed but switched OFF. To switch it on, PAD_ADMIN sends one transaction:");
            console2.log("  to:       ", address(hook));
            console2.log("  call:      bootstrapMainPortal(address)  with the portal address:", address(portal));
            console2.log("  e.g. cast send <hook> 'bootstrapMainPortal(address)' <portal> --rpc-url https://rpc.mainnet.arc.io --account <PAD_ADMIN keystore>");
            console2.log("The factory slot stays open until PAD_ADMIN decides it (bootstrapFactory or renounceFactoryBootstrap).");
            console2.log("---");
        }
        console2.log("Save these addresses (treasury, hook, portal) into pad-web's env and pad/deployments/.");
        console2.log("Then verify source with script/verify.sh (NETWORK=mainnet, these addresses).");
        console2.log("Deliberately a separate step, not --verify on this script: Arc's explorer indexer");
        console2.log("can lag the chain tip by 100k+ blocks, well past --verify's own retry window, so");
        console2.log("verification needs to be independently re-runnable until the indexer catches up.");
    }
}
