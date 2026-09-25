// Deploys SDOGE Studio (mint credits, Community Art, creator collections) on Arc, with the
// packages and the Community Art collection's contractURI from nft/studio.json.
//
//   STUDIO_OWNER_ADDRESS=<team Safe> TREASURY_ADDRESS=<where USDC revenue goes> \
//   npx hardhat run scripts/deploy-studio.js --network arc
//
// communityContractURI must be the pinned collection metadata JSON (ipfs://... or https://...);
// the script fetches it (SKIP_METADATA_CHECK=1 skips that). ALLOW_EMPTY_CONTRACT_URI=1 deploys
// without one; the Safe can set it later with setCommunityContractURI.
//
// If SDOGEStaking is already in deployments, it also writes the Safe batch that points
// poolShareBps of the Studio's USDC revenue at the staking reward pool.
const { ethers } = require("hardhat");
const c = require("./lib/common");

// The contract's limits (SDOGEStudio._checkPackage), so a bad manifest is refused before anything is sent.
const MAX_PACKAGES = 20;
const MAX_PACKAGE_MINTS = 100_000;
const USDC_RANGE = [ethers.parseEther("0.01"), ethers.parseEther("1000000")];
const SDOGE_RANGE = [ethers.parseEther("1"), ethers.parseEther("1000000000")];

function loadPackages(manifest) {
  if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) throw new Error("nft/studio.json has no packages.");
  if (manifest.packages.length > MAX_PACKAGES) throw new Error(`nft/studio.json has more than ${MAX_PACKAGES} packages.`);
  return manifest.packages.map((p, i) => {
    const what = `package ${i} (${p.name})`;
    if (!Number.isInteger(p.mints) || p.mints < 1) throw new Error(`${what}: mints must be a whole number >= 1.`);
    if (p.mints > MAX_PACKAGE_MINTS) throw new Error(`${what}: at most ${MAX_PACKAGE_MINTS} mints.`);
    const priceWei = p.priceUsdc == null ? 0n : c.usdcToWei(p.priceUsdc, `${what} USDC price`);
    const priceSdoge = p.priceSdoge == null ? 0n : c.sdogeToWei(p.priceSdoge, `${what} SDOGE price`);
    if (priceWei === 0n && priceSdoge === 0n) throw new Error(`${what} has no price.`);
    if (priceWei !== 0n && (priceWei < USDC_RANGE[0] || priceWei > USDC_RANGE[1])) {
      throw new Error(`${what}: the USDC price must be 0.01-1,000,000.`);
    }
    if (priceSdoge !== 0n && (priceSdoge < SDOGE_RANGE[0] || priceSdoge > SDOGE_RANGE[1])) {
      throw new Error(`${what}: the SDOGE price must be 1-1,000,000,000.`);
    }
    return { name: p.name, mints: p.mints, active: true, priceWei, priceSdoge };
  });
}

// The Community Art collection's contractURI: its name, description and image on marketplaces.
async function checkContractUri(uri, { allowEmptyContractUri = false, skipFetch = false, fetchImpl = globalThis.fetch } = {}) {
  if (uri == null || uri === "") {
    if (!allowEmptyContractUri) {
      throw new Error(
        "nft/studio.json has no communityContractURI. Pin the Community Art collection's metadata JSON and put " +
          "its ipfs:// or https:// link there, or set ALLOW_EMPTY_CONTRACT_URI=1 to deploy without it."
      );
    }
    console.warn(
      "  WARNING: ALLOW_EMPTY_CONTRACT_URI=1: the Community Art collection has no contractURI. The Safe can set " +
        "it later with setCommunityContractURI(uri) on the Studio."
    );
    return "";
  }
  c.checkUri("communityContractURI", uri);
  if (skipFetch) {
    console.warn("  WARNING: SKIP_METADATA_CHECK=1 - the communityContractURI was not fetched.");
    return uri;
  }
  const meta = await c.fetchJson(uri, fetchImpl);
  if (typeof meta?.name !== "string" || !meta.name.trim()) {
    throw new Error(`${c.toHttp(uri)} has no "name": it isn't collection metadata.`);
  }
  console.log(`  communityContractURI: ${uri} ("${meta.name}")`);
  return uri;
}

async function run(opts) {
  const { expectedChainId = c.ARC_CHAIN_ID, sdoge = c.SDOGE_TOKEN_ADDRESS, force = false } = opts;
  const manifest = opts.manifest || c.readRepoJson("nft/studio.json");
  const deployer = await c.preflight(expectedChainId);
  await c.checkRecord("SDOGEStudio", { force });
  const owner = await c.checkOwner("STUDIO_OWNER_ADDRESS", opts.owner, { ...opts, deployer: deployer.address });
  const treasury = await c.checkAddress("TREASURY_ADDRESS", opts.treasury, { from: deployer.address, receivesUsdc: true });
  const token = await c.checkSdoge(sdoge);
  const packages = loadPackages(manifest);
  const contractURI = await checkContractUri(manifest.communityContractURI, opts);
  const share = manifest.poolShareBps ?? 0;
  if (!Number.isInteger(share) || share < 0 || share > 10_000) throw new Error("poolShareBps must be 0-10000.");
  const stakingAddress = opts.staking || c.deployedAddress("SDOGEStaking");
  const pool = stakingAddress && share > 0 ? await c.checkStakingPool(stakingAddress, token) : null;

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

  if (pool) {
    await c.writeSafeBatch("studio-setup", owner, "route Studio revenue to staking", [
      c.call(studio, `setRewardsPool(${pool}, ${share})  # ${share / 100}% of USDC credit sales to stakers`, "setRewardsPool", [pool, share]),
    ]);
    console.log("Execute it only once the Safe's seed stake is open and the first reward period has started (see deploy-staking.js).");
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
      allowEmptyContractUri: c.flag("ALLOW_EMPTY_CONTRACT_URI"),
      skipFetch: c.flag("SKIP_METADATA_CHECK"),
      ...c.overrides(),
    })
  );
}

module.exports = { run, loadPackages, checkContractUri };
