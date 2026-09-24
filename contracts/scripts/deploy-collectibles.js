// Deploys SDOGECollectibles (the 12 named designs, ERC-1155) on Arc.
//
//   COLLECTIBLES_OWNER_ADDRESS=<team Safe> TREASURY_ADDRESS=<where mint revenue goes> \
//   COLLECTIBLES_BASE_URI=ipfs://<CID>/ npx hardhat run scripts/deploy-collectibles.js --network arc
//
// The base URI must end in "/" (the contract appends "<id>.json") and must already serve all 12
// metadata files with real images: the script fetches each one and checks its name against
// nft/designs.json. Then run scripts/setup-designs.js to create the designs (closed), check
// them, and open them.
const { ethers } = require("hardhat");
const c = require("./lib/common");

const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

function toHttp(uri) {
  return uri.startsWith("ipfs://") ? IPFS_GATEWAY + uri.slice("ipfs://".length) : uri;
}

async function checkBaseUri(base, { skipFetch = false, fetchImpl = globalThis.fetch } = {}) {
  if (!base) throw new Error("Set COLLECTIBLES_BASE_URI to where the 12 metadata files are pinned (ipfs://<CID>/).");
  if (!/^(ipfs:\/\/|https:\/\/)/.test(base)) throw new Error(`Base URI must start with ipfs:// or https:// (got ${base}).`);
  if (!base.endsWith("/")) throw new Error(`Base URI must end in "/" - the contract appends "<id>.json" (got ${base}).`);
  for (const bad of ["{id}", "REPLACE_ME", ".example", "localhost", " "]) {
    if (base.includes(bad)) throw new Error(`Base URI contains "${bad}": ${base}`);
  }
  if (skipFetch) {
    console.warn("  WARNING: SKIP_METADATA_CHECK=1 - the metadata at the base URI was not checked.");
    return base;
  }
  const { designs } = c.readRepoJson("nft/designs.json");
  for (const d of designs) {
    const url = `${toHttp(base)}${d.id}.json`;
    let meta;
    try {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      meta = await res.json();
    } catch (err) {
      throw new Error(`Could not load ${url}: ${err.message}`);
    }
    if (meta.name !== d.name) throw new Error(`${url} is "${meta.name}", expected "${d.name}".`);
    if (typeof meta.image !== "string" || !meta.image || meta.image.includes("REPLACE_ME")) {
      throw new Error(`${url} has no real image yet (${meta.image}). Pin the art and update the metadata first.`);
    }
  }
  console.log(`  metadata: all ${designs.length} files at ${base} match nft/designs.json`);
  return base;
}

async function run(opts) {
  const { expectedChainId = c.ARC_CHAIN_ID } = opts;
  await c.preflight(expectedChainId);
  const owner = await c.checkOwner("COLLECTIBLES_OWNER_ADDRESS", opts.owner, opts);
  const treasury = c.checkAddress("TREASURY_ADDRESS", opts.treasury);
  const baseUri = await checkBaseUri(opts.baseUri, opts);

  const nft = await (await ethers.getContractFactory("SDOGECollectibles")).deploy(owner, baseUri, treasury);
  await nft.waitForDeployment();
  console.log(`\nSDOGECollectibles: ${await nft.getAddress()}`);
  await c.recordDeployment("SDOGECollectibles", nft, [owner, baseUri, treasury]);
  console.log("\nNo designs exist yet. Next: npx hardhat run scripts/setup-designs.js --network arc");
  return { collectibles: nft };
}

if (require.main === module) {
  c.cli(() =>
    run({
      owner: c.requireEnv("COLLECTIBLES_OWNER_ADDRESS", "the team's Safe on Arc"),
      treasury: c.requireEnv("TREASURY_ADDRESS", "where mint revenue goes"),
      baseUri: c.envOr("COLLECTIBLES_BASE_URI"),
      skipFetch: c.flag("SKIP_METADATA_CHECK"),
      allowEoa: c.flag("ALLOW_EOA_OWNER"),
      allowLowThreshold: c.flag("ALLOW_LOW_THRESHOLD"),
    })
  );
}

module.exports = { run, checkBaseUri };
