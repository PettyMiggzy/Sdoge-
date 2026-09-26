// Hands the contracts to their real owner after a supervised launch (deployed with
// ALLOW_DEPLOYER_OWNER=1 and set up with scripts/run-batch.js): every recorded contract the
// deployer still owns is offered to NEW_OWNER_ADDRESS with transferOwnership. The contracts are
// Ownable2Step, so nothing changes until the new owner accepts, on stabledoge.site/owner.html
// connected with that wallet (one "Accept ownership" per contract). Until then the deployer is
// still the owner: it can finish the setup, and running this again with another address replaces
// the offer.
//
//   NEW_OWNER_ADDRESS=<owner wallet> ALLOW_EOA_OWNER=1 npx hardhat run scripts/handover.js --network arc
//
// Every contract is checked before anything is sent. The record keeps the new owner (handoverTo),
// so verify-deployment.js expects it from then on.
const { ethers } = require("hardhat");
const c = require("./lib/common");

const NAMES = ["SDOGECollectibles", "SDOGEStaking", "SDOGEStudio", "SDOGENFTMarketplace"];
const OWNER_PAGE = "https://www.stabledoge.site/owner.html";
const ABI = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function transferOwnership(address)",
];

async function run(opts = {}) {
  const { expectedChainId = c.ARC_CHAIN_ID } = opts;
  const deployer = await c.preflight(expectedChainId);
  // The deployer is never a valid new owner, whatever ALLOW_DEPLOYER_OWNER says.
  const newOwner = await c.checkOwner("NEW_OWNER_ADDRESS", opts.newOwner, { ...opts, deployer: deployer.address, allowDeployer: false });
  const file = c.deploymentsFile();
  const record = c.loadDeployments();
  const names = NAMES.filter((n) => record.contracts[n]);
  if (!names.length) throw new Error(`Nothing is recorded in ${c.rel(file)}.`);

  const plan = [];
  for (const name of names) {
    const contract = new ethers.Contract(await c.requireCode(name, record.contracts[name].address), ABI, deployer);
    const owner = ethers.getAddress(await contract.owner());
    const pending = ethers.getAddress(await contract.pendingOwner());
    if (owner === newOwner) {
      console.log(`  ${name}: already owned by ${newOwner}`);
      plan.push({ name, send: false });
    } else if (owner !== deployer.address) {
      throw new Error(`${name} ${contract.target} is owned by ${owner}, not the deployer ${deployer.address}. Nothing was sent.`);
    } else if (pending === newOwner) {
      console.log(`  ${name}: already offered to ${newOwner}, waiting for it to accept`);
      plan.push({ name, send: false });
    } else {
      if (pending !== ethers.ZeroAddress) console.warn(`  ${name}: replaces the offer to ${pending}`);
      plan.push({ name, contract, send: true });
    }
  }

  const sent = [];
  for (const p of plan) {
    if (p.send) {
      const tx = await p.contract.transferOwnership(newOwner);
      await tx.wait();
      console.log(`  ${p.name}: offered to ${newOwner} (${tx.hash})`);
      sent.push(p.name);
    }
    record.contracts[p.name].handoverTo = newOwner;
  }
  c.saveDeployments(record);
  console.log(`  recorded in ${c.rel(file)}`);

  console.log(
    `\nNext, the new owner: open ${OWNER_PAGE}, connect ${newOwner}, and press "Accept ownership" on each ` +
      "contract. Until then the deployer is still the owner. Check it afterwards with scripts/verify-deployment.js."
  );
  return { newOwner, sent };
}

if (require.main === module) {
  c.cli(() => run({ newOwner: c.requireEnv("NEW_OWNER_ADDRESS", "the wallet or Safe that will own the contracts"), ...c.overrides() }));
}

module.exports = { run, OWNER_PAGE };
