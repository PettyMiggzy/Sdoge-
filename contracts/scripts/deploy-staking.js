// Deploys SDOGEStaking on Arc.
//
//   STAKING_OWNER_ADDRESS=<team Safe> npx hardhat run scripts/deploy-staking.js --network arc
//
// Deploy SDOGECollectibles first: its NFTs boost stakes, and the staking contract is tied to it
// for good (STAKING_BOOST_COLLECTION overrides the recorded one). The owner settings are written
// as a Safe batch (staking-setup), never sent by the deployer: each design's boost, from
// nft/staking-boosts.json by the design's tier in nft/designs.json, and the notifier if
// STAKING_NOTIFIER_ADDRESS is set (a wallet allowed to start reward periods). The record keeps
// them, so verify-deployment.js can check the Safe applied them.
const { ethers } = require("hardhat");
const c = require("./lib/common");

// The seed stake's tier: 365 days, the longest lock.
const SEED_TIER = 4;
// SDOGEStaking.MAX_BOOST_BPS: +50%.
const MAX_BOOST_BPS = 5000;
const ERC1155_INTERFACE_ID = "0xd9b67a26";

// Each design's boost: its tier's, from nft/staking-boosts.json.
function loadBoosts(manifest = c.readRepoJson("nft/staking-boosts.json")) {
  const { designs } = c.readRepoJson("nft/designs.json");
  return designs.map((d) => {
    const bps = manifest.tierBoostBps?.[d.tier];
    if (!Number.isInteger(bps) || bps < 0 || bps > MAX_BOOST_BPS) {
      throw new Error(
        `nft/staking-boosts.json: tier "${d.tier}" (design ${d.id}, ${d.name}) needs a boost of 0-${MAX_BOOST_BPS} bps.`
      );
    }
    return { id: d.id, name: d.name, tier: d.tier, bps };
  });
}

// The recorded SDOGECollectibles (or STAKING_BOOST_COLLECTION): an ERC-1155 with designs.
async function checkCollection(address) {
  if (!address) {
    throw new Error(
      "No SDOGECollectibles in the record. Deploy it first (scripts/deploy-collectibles.js): its NFTs boost stakes, " +
        "and the staking contract is tied to it for good. Or set STAKING_BOOST_COLLECTION to its address."
    );
  }
  const a = await c.requireCode("SDOGECollectibles", address);
  const nft = new ethers.Contract(
    a,
    ["function supportsInterface(bytes4) view returns (bool)", "function nextDesignId() view returns (uint256)"],
    ethers.provider
  );
  let ok = false;
  try {
    ok = (await nft.supportsInterface(ERC1155_INTERFACE_ID)) && (await nft.nextDesignId()) >= 1n;
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`${a} isn't SDOGECollectibles (an ERC-1155 with designs); check the record.`);
  return a;
}

async function run(opts) {
  const { expectedChainId = c.ARC_CHAIN_ID, sdoge = c.SDOGE_TOKEN_ADDRESS, force = false } = opts;
  const deployer = await c.preflight(expectedChainId);
  await c.checkRecord("SDOGEStaking", { force });
  const owner = await c.checkOwner("STAKING_OWNER_ADDRESS", opts.owner, { ...opts, deployer: deployer.address });
  const token = await c.checkSdoge(sdoge);
  const collection = await checkCollection(opts.collection || c.deployedAddress("SDOGECollectibles"));
  const boosts = loadBoosts(opts.boostManifest);
  const notifier = opts.notifier ? await c.checkAddress("STAKING_NOTIFIER_ADDRESS", opts.notifier) : null;

  const args = [token, collection, owner];
  const staking = await (await ethers.getContractFactory("SDOGEStaking")).deploy(...args);
  await staking.waitForDeployment();
  console.log(`\nSDOGEStaking: ${await staking.getAddress()}`);
  console.log(`  NFT boosts come from SDOGECollectibles ${collection}`);
  const designBoosts = Object.fromEntries(boosts.map((b) => [b.id, b.bps]));
  await c.recordDeployment("SDOGEStaking", staking, args, {
    settings: { notifier: notifier || ethers.ZeroAddress, designBoosts },
  });

  const summary = boosts.map((b) => `${b.id}:+${b.bps / 100}%`).join(" ");
  const calls = [
    c.call(staking, `setDesignBoosts  # ${summary}`, "setDesignBoosts", [boosts.map((b) => b.id), boosts.map((b) => b.bps)]),
  ];
  if (notifier) calls.push(c.call(staking, `setNotifier(${notifier})`, "setNotifier", [notifier]));
  await c.writeSafeBatch("staking-setup", owner, "SDOGEStaking settings", calls);
  console.log("\nNFT boosts in that batch (nft/staking-boosts.json):");
  for (const b of boosts) console.log(`  design ${b.id} ${b.name} (${b.tier}): +${b.bps / 100}%`);

  const duration = await staking.tierDuration(SEED_TIER);
  const multiplier = await staking.tierMultiplierBps(SEED_TIER);
  console.log(
    "\nStaking is open, with no rewards yet. While nobody else is staked, even a 1-wei stake would earn the " +
      "whole first reward stream, so the Safe goes first, in this order:\n" +
      `  1. Execute the staking-setup batch (the NFT boosts${notifier ? " and the notifier" : ""}).\n` +
      "  2. Seed: before any revenue is routed to staking and before any reward period starts, the Safe approves " +
      "its own SDOGE and opens a seed stake it never exits, e.g. in the 365-day tier: " +
      `stake(${SEED_TIER}, <amount>, ${duration}, ${multiplier}).\n` +
      "  3. Only then start rewards, from the Safe or the notifier: notifyRewardAmount() with native USDC, and " +
      "notifySdogeRewards(<amount>) with SDOGE (approve it first). From then on early-exit penalties stream to " +
      "the stakers on their own.\n" +
      "  4. Then route revenue: execute the setRewardsPool batches that deploy-studio.js and " +
      "deploy-marketplace.js write (studio-setup, marketplace-setup).\n" +
      "  5. Once the boosts are final, lockBoosts() fixes them for good.\n" +
      "Check the result with scripts/verify-deployment.js before scripts/sync-frontend.js."
  );
  return { staking };
}

if (require.main === module) {
  c.cli(() =>
    run({
      owner: c.requireEnv("STAKING_OWNER_ADDRESS", "the team's Safe on Arc"),
      collection: c.envOr("STAKING_BOOST_COLLECTION"),
      notifier: c.envOr("STAKING_NOTIFIER_ADDRESS"),
      ...c.overrides(),
    })
  );
}

module.exports = { run, loadBoosts, checkCollection };
