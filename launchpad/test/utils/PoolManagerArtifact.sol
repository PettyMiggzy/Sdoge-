// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Makes forge build v4-core's PoolManager so tests can deployCode() it. It needs v4-core's own
// optimizer settings, which foundry.toml applies to that file alone (compilation_restrictions).
import {PoolManager} from "v4-core/src/PoolManager.sol";
