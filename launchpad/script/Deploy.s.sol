// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";
import {LaunchpadHook} from "../src/LaunchpadHook.sol";
import {LaunchpadFactory} from "../src/LaunchpadFactory.sol";
import {LaunchpadRouter} from "../src/LaunchpadRouter.sol";

/// Deploys the factory (which deploys the hook) and the router. Two transactions from the
/// broadcaster, and nothing left to hand over afterwards:
///   - the factory's owner is LAUNCHPAD_OWNER from the start (the Treasury multisig);
///   - platform fees go to FEE_RECIPIENT (it can be a contract; it's paid through the USDC ERC-20);
///   - the hook's factory is fixed at construction, so there's no setFactory step to get wrong.
///
/// A hook's address has to carry its permission flags in its low bits, so the hook is CREATE2'd
/// by the factory at a mined salt. The factory's own address comes from the broadcaster's nonce,
/// which is why the salt is mined against the predicted factory address right before deploying.
///
///   LAUNCHPAD_OWNER=0x... FEE_RECIPIENT=0x... \
///   forge script script/Deploy.s.sol --rpc-url $ARC_RPC_URL --broadcast --private-key $DEPLOYER_KEY
contract Deploy is Script {
    address public constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951; // Arc mainnet
    address public constant USDC = 0x3600000000000000000000000000000000000000;

    uint160 public constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_DONATE_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    function run() external returns (LaunchpadFactory factory, LaunchpadRouter router) {
        address owner = vm.envAddress("LAUNCHPAD_OWNER");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        require(owner != address(0) && feeRecipient != address(0), "set LAUNCHPAD_OWNER and FEE_RECIPIENT");
        require(POOL_MANAGER.code.length > 0, "no PoolManager at POOL_MANAGER on this chain");
        require(USDC.code.length > 0, "no USDC at 0x3600... on this chain");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        address predictedFactory = vm.computeCreateAddress(deployer, vm.getNonce(deployer));
        (address predictedHook, bytes32 salt) = HookMiner.find(
            predictedFactory, HOOK_FLAGS, type(LaunchpadHook).creationCode, abi.encode(IPoolManager(POOL_MANAGER))
        );

        factory = new LaunchpadFactory(IPoolManager(POOL_MANAGER), owner, feeRecipient, salt);
        router = new LaunchpadRouter(IPoolManager(POOL_MANAGER), factory);
        vm.stopBroadcast();

        require(address(factory) == predictedFactory, "factory address mismatch");
        require(address(factory.hook()) == predictedHook, "hook address mismatch");
        require(factory.hook().factory() == address(factory), "hook not bound to factory");
        require(factory.owner() == owner && factory.feeRecipient() == feeRecipient, "admin mismatch");

        console.log("FACTORY_ADDRESS=%s", address(factory));
        console.log("HOOK_ADDRESS=%s", address(factory.hook()));
        console.log("ROUTER_ADDRESS=%s", address(router));
    }
}
