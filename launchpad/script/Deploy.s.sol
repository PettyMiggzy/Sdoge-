// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";
import {LaunchpadHook} from "../src/LaunchpadHook.sol";
import {LaunchpadFactory} from "../src/LaunchpadFactory.sol";

/// Hook addresses must encode their permission bits in the low bits of the
/// address itself, so the hook has to be CREATE2-mined to a matching salt -
/// a plain `new LaunchpadHook(...)` will not deploy to a valid address.
contract Deploy is Script {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951; // Arc mainnet - verify against contracts/README.md before using
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C; // verify it exists on Arc: cast code <addr>

    function run() external {
        address platform = vm.envAddress("PLATFORM"); // treasury, or an SDOGE buyback splitter
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG |
            Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG |
            Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        bytes memory args = abi.encode(IPoolManager(POOL_MANAGER), platform);
        (address predicted, bytes32 salt) = HookMiner.find(CREATE2_DEPLOYER, flags, type(LaunchpadHook).creationCode, args);

        vm.startBroadcast();
        LaunchpadHook hook = new LaunchpadHook{salt: salt}(IPoolManager(POOL_MANAGER), platform);
        require(address(hook) == predicted, "hook address mismatch");
        LaunchpadFactory factory = new LaunchpadFactory(IPoolManager(POOL_MANAGER), hook, platform);
        hook.setFactory(address(factory));
        vm.stopBroadcast();

        console.log("hook    ", address(hook));
        console.log("factory ", address(factory));
    }
}
