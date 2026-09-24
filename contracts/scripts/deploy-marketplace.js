// Deploys SDOGENFTMarketplace on Arc, bound to the Studio's collections and SDOGECollectibles
// (both read from deployments, so run deploy-studio.js and deploy-collectibles.js first).
//
//   MARKETPLACE_OWNER_ADDRESS=<team Safe> FEE_RECIPIENT_ADDRESS=<treasury> \
//   npx hardhat run scripts/deploy-marketplace.js --network arc
//
// Fees go to the fee recipient until the owner points them at staking; if SDOGEStaking is in
// deployments, the Safe batch for setRewardsPool(staking) is written too.
const { ethers } = require("hardhat");
const c = require("./lib/common");

async function run(opts) {
  const { expectedChainId = c.ARC_CHAIN_ID } = opts;
  await c.preflight(expectedChainId);
  const owner = await c.checkOwner("MARKETPLACE_OWNER_ADDRESS", opts.owner, opts);
  const feeRecipient = c.checkAddress("FEE_RECIPIENT_ADDRESS", opts.feeRecipient);
  const studioAddress = opts.studio || c.deployedAddress("SDOGEStudio");
  const collectiblesAddress = opts.collectibles || c.deployedAddress("SDOGECollectibles");
  if (!studioAddress || !collectiblesAddress) throw new Error("Deploy the Studio and the Collectibles first.");
  const studio = await ethers.getContractAt("SDOGEStudio", await c.requireCode("SDOGEStudio", studioAddress));
  const collectibles = await ethers.getContractAt("SDOGECollectibles", await c.requireCode("SDOGECollectibles", collectiblesAddress));
  await studio.communityCollection(); // both must really be what they claim
  await collectibles.nextDesignId();

  const args = [owner, studio.target, collectibles.target, feeRecipient];
  const market = await (await ethers.getContractFactory("SDOGENFTMarketplace")).deploy(...args);
  await market.waitForDeployment();
  console.log(`\nSDOGENFTMarketplace: ${await market.getAddress()} (fee ${await market.feeBps()} bps)`);
  await c.recordDeployment("SDOGENFTMarketplace", market, args);

  const staking = opts.staking || c.deployedAddress("SDOGEStaking");
  if (staking) {
    const pool = await c.requireCode("SDOGEStaking", staking);
    await c.writeSafeBatch("marketplace-setup", owner, "send marketplace fees to staking", [
      c.call(market, `setRewardsPool(${pool})`, "setRewardsPool", [pool]),
    ]);
  } else {
    console.log(`\nFees go to ${feeRecipient} until the owner calls setRewardsPool(staking).`);
  }
  return { marketplace: market };
}

if (require.main === module) {
  c.cli(() =>
    run({
      owner: c.requireEnv("MARKETPLACE_OWNER_ADDRESS", "the team's Safe on Arc"),
      feeRecipient: c.requireEnv("FEE_RECIPIENT_ADDRESS", "where fees go until staking is connected"),
      allowEoa: c.flag("ALLOW_EOA_OWNER"),
      allowLowThreshold: c.flag("ALLOW_LOW_THRESHOLD"),
    })
  );
}

module.exports = { run };
