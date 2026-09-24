const { ethers } = require("hardhat");

async function main() {
  const ownerAddress = process.env.MARKETPLACE_OWNER_ADDRESS;
  if (!ownerAddress) {
    throw new Error(
      "Set MARKETPLACE_OWNER_ADDRESS to the Treasury/multisig that should control feeBps/rewardsPool - " +
        "do not deploy with a throwaway EOA as owner."
    );
  }
  // Optional: SDOGEStaking's address, if it's already deployed - resale fees
  // route to it via contributeUSDC() so marketplace volume feeds stakers'
  // USDC rewards. Leave unset and call setRewardsPool() later if staking
  // isn't live yet; fees just go to the owner in the meantime.
  const rewardsPool = process.env.STAKING_REWARDS_POOL_ADDRESS;

  const Marketplace = await ethers.getContractFactory("SDOGENFTMarketplace");
  const marketplace = await Marketplace.deploy(ownerAddress);
  await marketplace.waitForDeployment();
  const marketplaceAddress = await marketplace.getAddress();

  console.log("SDOGENFTMarketplace deployed to:", marketplaceAddress);
  console.log("  owner:", ownerAddress);
  console.log("  feeBps:", await marketplace.feeBps(), "(2%)");

  if (rewardsPool) {
    const tx = await marketplace.setRewardsPool(rewardsPool);
    await tx.wait();
    console.log("  rewardsPool set to:", rewardsPool);
  } else {
    console.log(
      "  rewardsPool: not set - resale fees go straight to the owner until " +
        "setRewardsPool(stakingAddress) is called."
    );
  }

  console.log(
    "\nLive immediately for both NFT contracts - sellers just need to approve() " +
      "(SDOGECommunityMint, ERC-721) or setApprovalForAll() (SDOGECollectibles, ERC-1155) " +
      `this contract (${marketplaceAddress}) before calling listERC721()/listERC1155().`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
