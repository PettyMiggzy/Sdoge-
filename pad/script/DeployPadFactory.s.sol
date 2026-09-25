// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {SdogePadHook} from "../src/SdogePadHook.sol";
import {SdogePadPortal} from "../src/SdogePadPortal.sol";
import {SdogePadFactory} from "../src/SdogePadFactory.sol";

/// @notice Deploys the white-label pad factory and plugs it into a LIVE
/// SdogePadHook, in one broadcast from that hook's PAD_ADMIN (its
/// bootstrapper). Only needed when the factory slot was left open at deploy.
/// This is one-shot: once the factory is plugged in, the hook will never
/// accept another, so settle the economics first (pad/README.md,
/// "White-label pads").
///
///   PORTAL=<SdogePadPortal> forge script script/DeployPadFactory.s.sol \
///     --rpc-url https://rpc.mainnet.arc.io --broadcast \
///     --account <PAD_ADMIN keystore> --sender <PAD_ADMIN>
///
/// PORTAL is the pad's main portal; the hook and treasury are read from it,
/// so a mistyped address can't pair a factory with the wrong pad.
/// Optional: PAD_SETUP_FEE (raw USDC units; 100000000 = $100) and
/// FACTORY_OWNER (who may change the setup fee later; default the sender).
contract DeployPadFactory is Script {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant USDC = 0x3600000000000000000000000000000000000000;

    function run() external returns (SdogePadFactory factory) {
        SdogePadPortal portal = SdogePadPortal(vm.envAddress("PORTAL"));
        require(address(portal).code.length != 0, "PORTAL has no code on this chain");
        address hook = portal.hook();
        address treasury = portal.treasury();
        require(portal.isMainPad(), "PORTAL is not a main pad portal");
        require(portal.poolManager() == POOL_MANAGER && portal.quoteAsset() == USDC, "PORTAL is wired to another PoolManager or quote asset");
        require(SdogePadHook(hook).isAuthorizedPortal(address(portal)), "the pad is not switched on yet - PAD_ADMIN must call bootstrapMainPortal first");
        require(!SdogePadHook(hook).factoryBootstrapped(), "the hook's factory slot is already used");
        uint256 setupFee = vm.envOr("PAD_SETUP_FEE", uint256(100e6));

        uint256 deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        address deployer = deployerKey != 0 ? vm.addr(deployerKey) : msg.sender;
        require(deployer != DEFAULT_SENDER, "pass --sender <address> with --account/--ledger (or set DEPLOYER_PRIVATE_KEY)");
        address factoryOwner = vm.envOr("FACTORY_OWNER", deployer);
        console2.log("Deploying as:", deployer);
        console2.log("Hook:", hook);
        console2.log("Treasury:", treasury);

        if (deployerKey != 0) vm.startBroadcast(deployerKey);
        else vm.startBroadcast();
        // The factory's owner can only change the price of NEW pads (capped
        // at $10k). It has no power over pads, launches or liquidity.
        factory = new SdogePadFactory(POOL_MANAGER, hook, treasury, USDC, setupFee, factoryOwner);
        // Reverts with NotBootstrapper unless `deployer` is the hook's PAD_ADMIN.
        SdogePadHook(hook).bootstrapFactory(address(factory));
        vm.stopBroadcast();

        require(SdogePadHook(hook).factory() == address(factory), "factory not plugged in");
        console2.log("SdogePadFactory:", address(factory));
        console2.log("Factory owner:", factoryOwner);
        console2.log("Setup fee (raw USDC):", setupFee);
    }
}
