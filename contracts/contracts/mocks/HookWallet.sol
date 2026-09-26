// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test-only contract wallet: makes arbitrary calls, and on receiving an ERC-1155 (once)
///         calls a hook, e.g. poking a keeper that notifies rewards. Used to check an exit's
///         in-flight rewards can't be re-promised from inside its NFT return.
contract HookWallet {
    address public hookTarget;
    bytes public hookData;
    bool public hookOk;

    function exec(address to, uint256 value, bytes calldata data) external payable returns (bytes memory ret) {
        bool ok;
        (ok, ret) = to.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function setHook(address target, bytes calldata data) external {
        hookTarget = target;
        hookData = data;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
        address t = hookTarget;
        if (t != address(0)) {
            hookTarget = address(0);
            (hookOk,) = t.call(hookData);
        }
        return this.onERC1155Received.selector;
    }

    receive() external payable {}
}

interface INotifyRewards {
    function notifyRewardAmount() external payable;
}

/// @notice Test-only keeper that anyone can poke into notifying rewards (like an unrestricted
///         performUpkeep): the kind of notifier a re-entrant exit could trigger.
contract PokeableNotifier {
    address public immutable staking;

    constructor(address staking_) {
        staking = staking_;
    }

    function poke() external {
        INotifyRewards(staking).notifyRewardAmount{value: address(this).balance}();
    }

    receive() external payable {}
}
