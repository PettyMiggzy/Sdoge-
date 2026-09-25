// Deploys SDOGEStaking on Arc.
//
//   STAKING_OWNER_ADDRESS=<team Safe> npx hardhat run scripts/deploy-staking.js --network arc
//
// Optional: STAKING_TOKEN_SINK_ADDRESS (where early-exit penalties are swept; defaults to the
// owner) and STAKING_NOTIFIER_ADDRESS (a wallet allowed to start reward periods). Both are
// owner-only settings, so they're written as a Safe batch, never sent by the deployer. The record
// keeps them, so verify-deployment.js can check the Safe applied them.
const { ethers } = require("hardhat");
const c = require("./lib/common");

// The seed stake's tier: 365 days, the longest lock.
const SEED_TIER = 4;

async function run(opts) {
  const { expectedChainId = c.ARC_CHAIN_ID, sdoge = c.SDOGE_TOKEN_ADDRESS, force = false } = opts;
  const deployer = await c.preflight(expectedChainId);
  await c.checkRecord("SDOGEStaking", { force });
  const owner = await c.checkOwner("STAKING_OWNER_ADDRESS", opts.owner, { ...opts, deployer: deployer.address });
  const token = await c.checkSdoge(sdoge);
  const sink = opts.tokenSink ? await c.checkAddress("STAKING_TOKEN_SINK_ADDRESS", opts.tokenSink) : null;
  if (sink === token) throw new Error("STAKING_TOKEN_SINK_ADDRESS is the SDOGE token itself: swept SDOGE would be stuck there.");
  const notifier = opts.notifier ? await c.checkAddress("STAKING_NOTIFIER_ADDRESS", opts.notifier) : null;

  const staking = await (await ethers.getContractFactory("SDOGEStaking")).deploy(token, owner);
  await staking.waitForDeployment();
  console.log(`\nSDOGEStaking: ${await staking.getAddress()}`);
  await c.recordDeployment("SDOGEStaking", staking, [token, owner], {
    settings: { tokenSink: sink || owner, notifier: notifier || ethers.ZeroAddress },
  });

  const calls = [];
  if (sink) calls.push(c.call(staking, `setTokenSink(${sink})`, "setTokenSink", [sink]));
  if (notifier) calls.push(c.call(staking, `setNotifier(${notifier})`, "setNotifier", [notifier]));
  if (calls.length) await c.writeSafeBatch("staking-setup", owner, "SDOGEStaking settings", calls);

  const duration = await staking.tierDuration(SEED_TIER);
  const multiplier = await staking.tierMultiplierBps(SEED_TIER);
  console.log(
    "\nStaking is open, with no rewards yet. While nobody else is staked, even a 1-wei stake would earn the " +
      "whole first reward stream, so the Safe goes first, in this order:\n" +
      "  1. Seed: before any revenue is routed to staking and before any reward period starts, the Safe approves " +
      "its own SDOGE and opens a seed stake it never exits, e.g. in the 365-day tier: " +
      `stake(${SEED_TIER}, <amount>, ${duration}, ${multiplier}).\n` +
      "  2. Only then start the first period: notifyRewardAmount() with native USDC, from the Safe or the notifier.\n" +
      "  3. Then route revenue: execute the setRewardsPool batches that deploy-studio.js and " +
      "deploy-marketplace.js write (studio-setup, marketplace-setup).\n" +
      "Check the result with scripts/verify-deployment.js before scripts/sync-frontend.js."
  );
  return { staking };
}

if (require.main === module) {
  c.cli(() =>
    run({
      owner: c.requireEnv("STAKING_OWNER_ADDRESS", "the team's Safe on Arc"),
      tokenSink: c.envOr("STAKING_TOKEN_SINK_ADDRESS"),
      notifier: c.envOr("STAKING_NOTIFIER_ADDRESS"),
      ...c.overrides(),
    })
  );
}

module.exports = { run };
