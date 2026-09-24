const { ethers } = require("hardhat");

const SDOGE_TOKEN_ADDRESS = "0xf8df98fda14cabb2e8b6efe920081ffcbb0bb405";

async function main() {
  const ownerAddress = process.env.COMMUNITY_MINT_OWNER_ADDRESS;
  if (!ownerAddress) {
    throw new Error(
      "Set COMMUNITY_MINT_OWNER_ADDRESS to the Treasury/multisig that should control burnAmount - " +
        "do not deploy with a throwaway EOA as owner."
    );
  }
  const tokenAddress = process.env.SDOGE_TOKEN_ADDRESS || SDOGE_TOKEN_ADDRESS;

  const CommunityMint = await ethers.getContractFactory("SDOGECommunityMint");
  const nft = await CommunityMint.deploy(tokenAddress, ownerAddress);
  await nft.waitForDeployment();

  console.log("SDOGECommunityMint deployed to:", await nft.getAddress());
  console.log("  sdoge token:", tokenAddress);
  console.log("  owner:", ownerAddress);
  console.log("  burnAmount:", ethers.formatEther(await nft.burnAmount()), "SDOGE");
  console.log(
    "\nLive immediately - mint() is permissionless, no design/allowlist step needed. " +
      "Callers need to approve() this contract for burnAmount SDOGE before calling mint(uri)."
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
