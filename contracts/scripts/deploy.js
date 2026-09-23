const { ethers } = require("hardhat");

const SDOGE_TOKEN_ADDRESS = "0xf8df98fda14cabb2e8b6efe920081ffcbb0bb405";

async function main() {
  const ownerAddress = process.env.STAKING_OWNER_ADDRESS;
  if (!ownerAddress) {
    throw new Error(
      "Set STAKING_OWNER_ADDRESS to the Treasury/multisig that should control funding and admin " +
        "functions - do not deploy with a throwaway EOA as owner."
    );
  }

  const Staking = await ethers.getContractFactory("SDOGEStaking");
  const staking = await Staking.deploy(SDOGE_TOKEN_ADDRESS, ownerAddress);
  await staking.waitForDeployment();

  console.log("SDOGEStaking deployed to:", await staking.getAddress());
  console.log("  stakingToken:", SDOGE_TOKEN_ADDRESS);
  console.log("  owner:", ownerAddress);
  console.log(
    "\nNothing is funded yet - stakers can deposit SDOGE immediately, but rewards are 0 until " +
      "the owner calls notifyRewardAmount() with native USDC value. See contracts/README.md."
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
