// Deploys SDOGEStaking on Arc.
//
//   STAKING_OWNER_ADDRESS=<team Safe> npx hardhat run scripts/deploy-staking.js --network arc
//
// Optional: STAKING_TOKEN_SINK_ADDRESS (where early-exit penalties are swept; defaults to the
// owner) and STAKING_NOTIFIER_ADDRESS (a wallet allowed to start reward periods). Both are
// owner-only settings, so they're written as a Safe batch, never sent by the deployer.
const { ethers } = require("hardhat");
const c = require("./lib/common");

async function run(opts) {
  const { expectedChainId = c.ARC_CHAIN_ID, sdoge = c.SDOGE_TOKEN_ADDRESS, tokenSink, notifier } = opts;
  await c.preflight(expectedChainId);
  const owner = await c.checkOwner("STAKING_OWNER_ADDRESS", opts.owner, opts);
  const token = await c.checkSdoge(sdoge);

  const staking = await (await ethers.getContractFactory("SDOGEStaking")).deploy(token, owner);
  await staking.waitForDeployment();
  console.log(`\nSDOGEStaking: ${await staking.getAddress()}`);
  await c.recordDeployment("SDOGEStaking", staking, [token, owner]);

  const calls = [];
  if (tokenSink) {
    const sink = c.checkAddress("STAKING_TOKEN_SINK_ADDRESS", tokenSink);
    calls.push(c.call(staking, `setTokenSink(${sink})`, "setTokenSink", [sink]));
  }
  if (notifier) {
    const n = c.checkAddress("STAKING_NOTIFIER_ADDRESS", notifier);
    calls.push(c.call(staking, `setNotifier(${n})`, "setNotifier", [n]));
  }
  if (calls.length) await c.writeSafeBatch("staking-setup", owner, "SDOGEStaking settings", calls);

  console.log(
    "\nStaking is open, with no rewards yet. To fund a period, the owner calls notifyRewardAmount() " +
      "with native USDC (NFT profits: Studio.withdraw() and marketplace fees add to unallocatedUsdc, " +
      "which notifyUnallocated() can stream). Then run scripts/sync-frontend.js."
  );
  return { staking };
}

if (require.main === module) {
  c.cli(() =>
    run({
      owner: c.requireEnv("STAKING_OWNER_ADDRESS", "the team's Safe on Arc"),
      tokenSink: c.envOr("STAKING_TOKEN_SINK_ADDRESS"),
      notifier: c.envOr("STAKING_NOTIFIER_ADDRESS"),
      allowEoa: c.flag("ALLOW_EOA_OWNER"),
      allowLowThreshold: c.flag("ALLOW_LOW_THRESHOLD"),
    })
  );
}

module.exports = { run };
