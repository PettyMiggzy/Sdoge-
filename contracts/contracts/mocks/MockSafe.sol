// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test-only stand-in for a Safe: reports its threshold and owners like the real one,
///         and executes a call (the "batch" a deploy script writes) when asked.
contract MockSafe {
    uint256 public immutable threshold;
    address[] private _owners;

    constructor(uint256 threshold_, address[] memory owners_) {
        threshold = threshold_;
        _owners = owners_;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    function exec(address to, bytes calldata data) external payable returns (bytes memory result) {
        bool ok;
        (ok, result) = to.call{value: msg.value}(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    receive() external payable {}
}
