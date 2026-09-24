// Deploys SDOGE Studio (mint credits, Community Art, creator collections) on Arc, with the
// packages from nft/studio.json.
//
//   STUDIO_OWNER_ADDRESS=<team Safe> TREASURY_ADDRESS=<where USDC revenue goes> \
//   npx hardhat run scripts/deploy-studio.js --network arc
//
// If SDOGEStaking is already in deployments, it also writes the Safe batch that points
// poolShareBps of the Studio's USDC revenue at the staking reward pool.
const { ethers } = require("hardhat");
const c = require("./lib/common");

function loadPackages(manifest) {
  if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) throw new Error("nft/studio.json has no packages.");
  return manifest.packages.map((p, i) => {
    const what = `package ${i} (${p.name})`;
    if (!Number.isInteger(p.mints) || p.mints < 1) throw new Error(`${what}: mints must be a whole number >= 1.`);
    const priceWei = p.priceUsdc == null ? 0n : c.usdcToWei(p.priceUsdc, `${what} USDC price`);
    const priceSdoge = p.priceSdoge == null ? 0n : c.sdogeToWei(p.priceSdoge, `${what} SDOGE price`);
    if (priceWei === 0n && priceSdoge === 0n) throw new Error(`${what} has no price.`);
    return { name: p.name, mints: p.mints, active: true, priceWei, priceSdoge };
  });
}

async function run(opts) {
  const { expectedChainId = c.ARC_CHAIN_ID, sdoge = c.SDOGE_TOKEN_ADDRESS } = opts;
  const manifest = opts.manifest || c.readRepoJson("nft/studio.json");
  await c.preflight(expectedChainId);
  const owner = await c.checkOwner("STUDIO_OWNER_ADDRESS", opts.owner, opts);
  const treasury = c.checkAddress("TREASURY_ADDRESS", opts.treasury);
  const token = await c.checkSdoge(sdoge);
  const packages = loadPackages(manifest);
  const contractURI = manifest.communityContractURI || "";
  const share = manifest.poolShareBps ?? 0;
  if (!Number.isInteger(share) || share < 0 || share > 10_000) throw new Error("poolShareBps must be 0-10000.");

  const args = [owner, token, treasury, packages.map(({ name, ...p }) => p), contractURI];
  const studio = await (await ethers.getContractFactory("SDOGEStudio")).deploy(...args);
  await studio.waitForDeployment();
  console.log(`\nSDOGEStudio: ${await studio.getAddress()}`);
  console.log(`  Community Art collection: ${await studio.communityCollection()}`);
  await c.recordDeployment("SDOGEStudio", studio, args);

  const onChain = await studio.getPackages();
  onChain.forEach((p, i) => {
    const usdc = p.priceWei > 0n ? `${ethers.formatEther(p.priceWei)} USDC` : "-";
    const sd = p.priceSdoge > 0n ? `${ethers.formatEther(p.priceSdoge)} SDOGE` : "-";
    console.log(`  package ${i} ${packages[i].name}: ${p.mints} mints for ${usdc} / ${sd}`);
  });

  const staking = opts.staking || c.deployedAddress("SDOGEStaking");
  if (staking && share > 0) {
    const pool = await c.requireCode("SDOGEStaking", staking);
    await c.writeSafeBatch("studio-setup", owner, "route Studio revenue to staking", [
      c.call(studio, `setRewardsPool(${pool}, ${share})  # ${share / 100}% of USDC credit sales to stakers`, "setRewardsPool", [pool, share]),
    ]);
  } else {
    console.log("\nRevenue goes 100% to the treasury until the owner calls setRewardsPool(staking, share).");
  }
  return { studio };
}

if (require.main === module) {
  c.cli(() =>
    run({
      owner: c.requireEnv("STUDIO_OWNER_ADDRESS", "the team's Safe on Arc"),
      treasury: c.requireEnv("TREASURY_ADDRESS", "where USDC revenue goes"),
      allowEoa: c.flag("ALLOW_EOA_OWNER"),
      allowLowThreshold: c.flag("ALLOW_LOW_THRESHOLD"),
    })
  );
}

module.exports = { run, loadPackages };
