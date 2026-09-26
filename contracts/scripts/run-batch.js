// Sends one of the owner batches the deploy scripts write (deployments/<record>-<name>.safe.json)
// from the deployer, for a supervised launch without a Safe: the deployer owns the contracts
// (ALLOW_DEPLOYER_OWNER=1) only until scripts/handover.js offers them to the real owner.
// Every contract the batch calls must be owned by the deployer; if one isn't, nothing is sent.
//
//   BATCH=collectibles-create-designs npx hardhat run scripts/run-batch.js --network arc
//
// Batches: collectibles-create-designs, staking-setup, staking-notifier, studio-setup,
// marketplace-setup, collectibles-open-designs (and collectibles-lock, one-way).
const fs = require("fs");
const { ethers } = require("hardhat");
const c = require("./lib/common");

async function run({ expectedChainId = c.ARC_CHAIN_ID, batch, file } = {}) {
  const deployer = await c.preflight(expectedChainId);
  const where = file || c.safeBatchFile(batch);
  if (!fs.existsSync(where)) throw new Error(`No batch at ${c.rel(where)}. Run the deploy script that writes it first.`);
  const { transactions, meta } = JSON.parse(fs.readFileSync(where, "utf8"));
  if (!Array.isArray(transactions) || !transactions.length) throw new Error(`${c.rel(where)} has no transactions.`);

  for (const to of new Set(transactions.map((t) => ethers.getAddress(t.to)))) {
    let owner = null;
    try {
      owner = await new ethers.Contract(to, ["function owner() view returns (address)"], ethers.provider).owner();
    } catch {
      // not Ownable
    }
    if (!owner || ethers.getAddress(owner) !== deployer.address) {
      throw new Error(`${to} is owned by ${owner ?? "no readable owner"}, not the deployer ${deployer.address}. Nothing was sent.`);
    }
  }

  console.log(`\n${meta?.description || batch}: ${transactions.length} transaction(s) from the deployer`);
  const receipts = [];
  for (const [i, t] of transactions.entries()) {
    const tx = await deployer.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value || 0) });
    const receipt = await tx.wait();
    console.log(`  ${i + 1}/${transactions.length} ${tx.hash} (gas ${receipt.gasUsed})`);
    receipts.push(receipt);
  }
  return receipts;
}

if (require.main === module) {
  c.cli(() => run({ batch: c.requireEnv("BATCH", "the batch's name, e.g. collectibles-create-designs") }));
}

module.exports = { run };
