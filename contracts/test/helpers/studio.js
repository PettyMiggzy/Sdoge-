// Shared by the Studio, collection and marketplace tests. No tests in here.
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));

// The launch packages: 1 mint for 5 USDC (or 1,000,000 SDOGE burned), 10 for 20, 100 for 50,
// 1,000 for 100.
const PACKAGES = [
  { mints: 1, active: true, priceWei: E("5"), priceSdoge: E("1000000") },
  { mints: 10, active: true, priceWei: E("20"), priceSdoge: 0 },
  { mints: 100, active: true, priceWei: E("50"), priceSdoge: 0 },
  { mints: 1000, active: true, priceWei: E("100"), priceSdoge: 0 },
];

async function deployStudio(owner, sdoge, treasury) {
  const studio = await (await ethers.getContractFactory("SDOGEStudio")).deploy(
    owner.address,
    await sdoge.getAddress(),
    treasury.address,
    PACKAGES,
    "ipfs://bafy/community.json"
  );
  const community = await ethers.getContractAt("SDOGEStudioCollection", await studio.communityCollection());
  return { studio, community };
}

// Creates a collection owned by `who` and returns it as a contract.
async function newCollection(studio, who, opts = {}) {
  const { name = "Alice Club", symbol = "ACLUB", maxSupply = 0, royaltyTo = ethers.ZeroAddress, royaltyBps = 500 } = opts;
  const args = [name, symbol, maxSupply, royaltyTo, royaltyBps, ""];
  const addr = await studio.connect(who).createCollection.staticCall(...args);
  await studio.connect(who).createCollection(...args);
  return ethers.getContractAt("SDOGEStudioCollection", addr);
}

module.exports = { PACKAGES, deployStudio, newCollection };
