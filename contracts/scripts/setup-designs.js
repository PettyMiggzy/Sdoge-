// Builds the Safe batches that set up SDOGECollectibles' designs from nft/designs.json.
//
//   npx hardhat run scripts/setup-designs.js --network arc            # step 1: create (closed)
//   OPEN=1 npx hardhat run scripts/setup-designs.js --network arc     # step 2: open for sale
//
// Step 1 writes createDesign(id, ...) for every design not created yet, in id order. The
// contract takes the expected id, so a stray or repeated call can't shift the roster. Designs
// start closed. Run it again after the Safe executes the batch: it reads every design back and
// stops on any difference from the manifest. Only then does step 2 write the setPublicMint
// batch that opens them.
const { ethers } = require("hardhat");
const c = require("./lib/common");

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

async function run(opts = {}) {
  const { expectedChainId = c.ARC_CHAIN_ID, open = false } = opts;
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
    if (diffs.length) problems.push(`design ${d.id} (${d.name}) on-chain has ${diffs.join(", ")}`);
    else if (!on.publicMintOpen) opens.push(c.call(nft, `setPublicMint(${d.id}, true)  # ${d.name}`, "setPublicMint", [d.id, true]));
  }
  if (next > designs.length + 1) problems.push(`the contract has ${next - 1} designs, the manifest ${designs.length}`);
  if (problems.length) throw new Error(`On-chain designs don't match nft/designs.json:\n  - ${problems.join("\n  - ")}`);

  if (creates.length) {
    if (open) throw new Error("Some designs aren't created yet. Run without OPEN=1 first, execute that batch, then open.");
    return c.writeSafeBatch("collectibles-create-designs", owner, `create ${creates.length} designs (closed)`, creates);
  }
  if (!open) {
    console.log(`All ${designs.length} designs exist and match nft/designs.json. Run with OPEN=1 to open them for sale.`);
    return null;
  }
  if (!opens.length) {
    console.log("Every design is already open.");
    return null;
  }
  return c.writeSafeBatch("collectibles-open-designs", owner, `open ${opens.length} designs for sale`, opens);
}

if (require.main === module) {
  c.cli(() => run({ collectibles: c.envOr("COLLECTIBLES_ADDRESS"), open: c.flag("OPEN") }));
}

module.exports = { run, loadManifest };
