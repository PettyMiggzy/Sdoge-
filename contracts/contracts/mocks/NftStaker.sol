// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

interface IStakingForNftStaker {
    function exitStake(uint256 stakeId, bool allowEarly) external returns (uint256, uint256, uint256);
    function claimDeferredNft(uint256 designId, address to) external;
    function tierDuration(uint256) external view returns (uint256);
    function tierMultiplierBps(uint256) external view returns (uint256);
    function designBoostBps(uint256) external view returns (uint256);
    function nextStakeId() external view returns (uint256);
}

interface ICollectiblesMint {
    function mint(uint256 designId, uint256 amount) external payable;
}

/// @notice Test-only contract wallet that stakes one of its NFTs and can be told to refuse
///         ERC-1155 transfers afterwards, like a wallet whose receiver hook breaks or is removed.
contract NftStaker {
    IStakingForNftStaker public immutable staking;
    IERC20 public immutable token;
    IERC1155 public immutable collection;
    uint256 public stakeId;
    bool public refuseNfts;

    constructor(address staking_, address token_, address collection_) {
        staking = IStakingForNftStaker(staking_);
        token = IERC20(token_);
        collection = IERC1155(collection_);
    }

    function mintNft(uint256 designId) external payable {
        ICollectiblesMint(address(collection)).mint{value: msg.value}(designId, 1);
    }

    function stakeWithNft(uint256 designId, uint8 tier, uint256 amount) external {
        token.approve(address(staking), amount);
        stakeId = staking.nextStakeId();
        bytes memory terms = abi.encode(
            tier, amount, staking.tierDuration(tier), staking.tierMultiplierBps(tier), staking.designBoostBps(designId)
        );
        collection.safeTransferFrom(address(this), address(staking), designId, 1, terms);
    }

    function setRefuseNfts(bool refuse) external {
        refuseNfts = refuse;
    }

    function exit(bool allowEarly) external {
        staking.exitStake(stakeId, allowEarly);
    }

    function claimDeferredNft(uint256 designId, address to) external {
        staking.claimDeferredNft(designId, to);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external view returns (bytes4) {
        require(!refuseNfts, "no NFTs please");
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        view
        returns (bytes4)
    {
        require(!refuseNfts, "no NFTs please");
        return this.onERC1155BatchReceived.selector;
    }

    receive() external payable {}
}
