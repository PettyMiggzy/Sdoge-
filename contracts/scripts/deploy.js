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

  // Optional convenience: wire up the automated keeper's hot key in the same
  // deploy run. Safe to skip - notifier defaults to disabled (address(0))
  // and can be set later as a separate owner transaction.
  const notifierAddress = process.env.STAKING_NOTIFIER_ADDRESS;
  if (notifierAddress) {
    const [deployer] = await ethers.getSigners();
    if (deployer.address.toLowerCase() !== ownerAddress.toLowerCase()) {
      console.log(
        "\nSTAKING_NOTIFIER_ADDRESS was set, but the deployer isn't the owner - skipping setNotifier(). " +
          "The owner (Treasury/multisig) must call it separately: " +
          `staking.setNotifier("${notifierAddress}")`
      );
    } else {
      await (await staking.setNotifier(notifierAddress)).wait();
      console.log("  notifier:", notifierAddress, "(hot wallet allowed to call notifyRewardAmount()/sweepTokens())");
    }
  } else {
    console.log(
      "\nSTAKING_NOTIFIER_ADDRESS not set - notifier left disabled. The owner must call " +
        "setNotifier(address) before anything but the owner itself can call notifyRewardAmount() " +
        "or sweepTokens() - see contracts/README.md."
    );
  }

  console.log(
    "\nNothing is funded yet - stakers can deposit SDOGE immediately, but rewards are 0 until " +
      "notifyRewardAmount() is called with native USDC value. See contracts/README.md."
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
