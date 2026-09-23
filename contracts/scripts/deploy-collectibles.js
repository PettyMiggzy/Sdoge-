const { ethers } = require("hardhat");

// Placeholder - replace with wherever metadata actually ends up hosted
// (IPFS via nft.storage/Pinata, or a URL on the site itself) before
// deploying for real. The contract appends "<id>.json" itself (see
// SDOGECollectibles.uri()), so this should end in a trailing slash and
// must NOT include a literal "{id}" - that EIP-1155 convention isn't used
// here.
const DEFAULT_BASE_URI = "https://stabledoge1.example/nft/metadata/";

async function main() {
  const ownerAddress = process.env.COLLECTIBLES_OWNER_ADDRESS;
  if (!ownerAddress) {
    throw new Error(
      "Set COLLECTIBLES_OWNER_ADDRESS to the Treasury/multisig that should control minting and pricing - " +
        "do not deploy with a throwaway EOA as owner."
    );
  }
  const baseURI = process.env.COLLECTIBLES_BASE_URI || DEFAULT_BASE_URI;

  const Collectibles = await ethers.getContractFactory("SDOGECollectibles");
  const nft = await Collectibles.deploy(ownerAddress, baseURI);
  await nft.waitForDeployment();

  console.log("SDOGECollectibles deployed to:", await nft.getAddress());
  console.log("  owner:", ownerAddress);
  console.log("  baseURI:", baseURI);
  console.log(
    "\nNo designs exist yet - call createDesign(name, maxSupply, priceWei) once per design " +
      "(see nft/metadata/ for the 6 designs currently defined) before anyone can mint."
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
