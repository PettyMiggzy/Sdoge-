// Builds the Safe batches that set up SDOGECollectibles' designs from nft/designs.json.
//
//   npx hardhat run scripts/setup-designs.js --network arc            # step 1: create (closed)
//   OPEN=1 npx hardhat run scripts/setup-designs.js --network arc     # step 2: open for sale
//   LOCK=1 npx hardhat run scripts/setup-designs.js --network arc     # optional step 3: lock for good
//
// (`hardhat run` passes no flags to the script; `HARDHAT_NETWORK=arc node scripts/setup-designs.js
// --open` or `--lock` works too.)
//
// Step 1 writes createDesign(id, ...) for every design not created yet, in id order, after
// printing each design's reserve: a reserve can never be raised later. The contract takes the
// expected id, so a stray or repeated call can't shift the roster. Designs start closed. Run it
// again after the Safe executes the batch: it reads every design back and stops on any
// difference from the manifest. Only then does step 2 write the setPublicMint batch that opens
// them, which the Safe executes only once the site is live and the sale is announced. Step 3
// locks every design's supply and the collection, then freezes the metadata: all one-way.
const { ethers } = require("hardhat");
const c = require("./lib/common");

const OPEN_WARNING =
  "\nWARNING: opening is the launch. Execute this batch only after the site is live (sync-frontend.js has run " +
  "and the NFT page shows the designs) and the sale has been announced. Opened any earlier, the designs can be " +
  "minted by whoever watches the chain before anyone else knows.";

function loadManifest() {
  const { designs } = c.readRepoJson("nft/designs.json");
  designs.forEach((d, i) => {
    if (d.id !== i + 1) throw new Error(`nft/designs.json: design at position ${i + 1} has id ${d.id}.`);
    const meta = c.readRepoJson(`nft/metadata/${d.id}.json`);
    if (meta.name !== d.name) throw new Error(`Design ${d.id} is "${d.name}" but nft/metadata/${d.id}.json says "${meta.name}".`);
    d.priceWei = c.usdcToWei(d.priceUsdc, `design ${d.id} price`);
    if (d.priceWei < ethers.parseEther("0.01")) throw new Error(`Design ${d.id}: price below 0.01 USDC.`);
    if (!(d.maxSupply > 0) || !(d.reserved >= 0) || d.reserved > d.maxSupply) {
      throw new Error(`Design ${d.id}: bad maxSupply/reserved (${d.maxSupply}/${d.reserved}).`);
    }
  });
  return designs;
}

function printReserves(designs) {
  console.log("\nReserves (copies only the owner can mint, for the team and giveaways):");
  for (const d of designs) console.log(`  design ${d.id} ${d.name}: reserved ${d.reserved} of ${d.maxSupply}`);
  console.warn(
    "WARNING: a design's reserve can never be raised once it's created (only released to the public sale). " +
      "Check these numbers before the Safe signs."
  );
  if (designs.every((d) => d.reserved === 0)) {
    console.warn("  Every reserve is 0: the team will never be able to mint these designs for itself or for giveaways.");
  }
}

// lockSupply for each design still open to a raise, then lockCollection, then freezeMetadata
// (which needs the collection locked first).
async function lockBatch(nft, owner, locks) {
  const calls = [...locks];
  const frozen = await nft.metadataFrozen();
  if (!(await nft.collectionLocked())) calls.push(c.call(nft, "lockCollection()", "lockCollection", []));
  if (!frozen) calls.push(c.call(nft, "freezeMetadata()", "freezeMetadata", []));
  if (!calls.length) {
    console.log("Every design's supply and the collection are locked, and the metadata is frozen.");
    return null;
  }
  const base = (await nft.uri(1)).replace(/1\.json$/, "");
  if (!frozen && !base.startsWith("ipfs://")) {
    console.warn(`\nWARNING: the metadata base URI is ${base}, not IPFS. Frozen, that server must serve it forever.`);
  }
  console.warn(
    "\nWARNING: this batch is one-way. After it no design can be added, no supply raised, and the metadata " +
      "URI can never change."
  );
  return c.writeSafeBatch(
    "collectibles-lock",
    owner,
    "lock every design's supply and the collection, then freeze the metadata - one-way",
    calls
  );
}

async function run(opts = {}) {
  const { expectedChainId = c.ARC_CHAIN_ID, open = false, lock = false } = opts;
  if (open && lock) throw new Error("Opening and locking are separate batches: run with OPEN=1, execute it, then with LOCK=1.");
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== expectedChainId) throw new Error(`Connected to chain ${chainId}, expected ${expectedChainId}.`);
  const address = opts.collectibles || c.deployedAddress("SDOGECollectibles");
  if (!address) throw new Error("SDOGECollectibles isn't in deployments yet (run deploy-collectibles.js) - or set COLLECTIBLES_ADDRESS.");
  const nft = await ethers.getContractAt("SDOGECollectibles", await c.requireCode("SDOGECollectibles", address));
  const owner = await nft.owner();
  const designs = loadManifest();
  const next = Number(await nft.nextDesignId());

  const problems = [];
  const creates = [];
  const opens = [];
  const locks = [];
  for (const d of designs) {
    if (d.id >= next) {
      creates.push(c.call(nft, `createDesign(${d.id}, "${d.name}", ${d.maxSupply}, ${d.priceUsdc} USDC, ${d.reserved})`, "createDesign", [d.id, d.name, d.maxSupply, d.priceWei, d.reserved]));
      continue;
    }
    const on = await nft.designs(d.id);
    const diffs = [];
    if (on.name !== d.name) diffs.push(`name "${on.name}"`);
    if (on.maxSupply !== BigInt(d.maxSupply)) diffs.push(`maxSupply ${on.maxSupply}`);
    if (on.priceWei !== d.priceWei) diffs.push(`price ${ethers.formatEther(on.priceWei)} USDC`);
    if (on.reserved !== BigInt(d.reserved)) diffs.push(`reserved ${on.reserved}`);
    if (diffs.length) {
      problems.push(`design ${d.id} (${d.name}) on-chain has ${diffs.join(", ")}`);
      continue;
    }
    if (!on.publicMintOpen) opens.push(c.call(nft, `setPublicMint(${d.id}, true)  # ${d.name}`, "setPublicMint", [d.id, true]));
    if (!on.supplyLocked) locks.push(c.call(nft, `lockSupply(${d.id})  # ${d.name}`, "lockSupply", [d.id]));
  }
  if (next > designs.length + 1) problems.push(`the contract has ${next - 1} designs, the manifest ${designs.length}`);
  if (problems.length) throw new Error(`On-chain designs don't match nft/designs.json:\n  - ${problems.join("\n  - ")}`);

  if (creates.length) {
    if (open || lock) throw new Error("Some designs aren't created yet. Run without OPEN/LOCK first, execute that batch, then open or lock.");
    printReserves(designs.filter((d) => d.id >= next));
    return c.writeSafeBatch("collectibles-create-designs", owner, `create ${creates.length} designs (closed)`, creates);
  }
  if (lock) return lockBatch(nft, owner, locks);
  if (!open) {
    console.log(
      `All ${designs.length} designs exist and match nft/designs.json. Run with OPEN=1 to open them for sale ` +
        "once the site is live and the sale is announced."
    );
    return null;
  }
  if (!opens.length) {
    console.log("Every design is already open.");
    return null;
  }
  console.warn(OPEN_WARNING);
  return c.writeSafeBatch(
    "collectibles-open-designs",
    owner,
    `open ${opens.length} designs for sale - execute only once the site is live and the sale is announced`,
    opens
  );
}

if (require.main === module) {
  const arg = (name) => process.argv.includes(`--${name}`);
  c.cli(() =>
    run({
      collectibles: c.envOr("COLLECTIBLES_ADDRESS"),
      open: c.flag("OPEN") || arg("open"),
      lock: c.flag("LOCK") || arg("lock"),
    })
  );
}

module.exports = { run, loadManifest };
