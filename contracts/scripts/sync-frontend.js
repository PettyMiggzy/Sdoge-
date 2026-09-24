// Copies the deployed addresses from deployments/arc.json into the site's SDOGE_CONTRACTS
// block in assets/js/arc.js, the one place the pages read them from.
//
//   node scripts/sync-frontend.js            (or DEPLOYMENTS=path/to/file.json to use another)
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const ARC_JS = path.join(ROOT, "assets", "js", "arc.js");
const KEYS = { staking: "SDOGEStaking", collectibles: "SDOGECollectibles", studio: "SDOGEStudio", marketplace: "SDOGENFTMarketplace" };

function sync(deploymentsFile, arcJsFile = ARC_JS) {
  const record = JSON.parse(fs.readFileSync(deploymentsFile, "utf8"));
  if (record.chainId !== 5042) throw new Error(`${deploymentsFile} is for chain ${record.chainId}, not Arc (5042).`);
  let src = fs.readFileSync(arcJsFile, "utf8");
  const changed = [];
  for (const [key, name] of Object.entries(KEYS)) {
    const address = record.contracts?.[name]?.address;
    if (!address) continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`${name}: "${address}" is not an address.`);
    const re = new RegExp(`^(\\s*${key}: )'(0x[0-9a-fA-F]{40})?',$`, "m");
    if (!re.test(src)) throw new Error(`Couldn't find the "${key}:" line in the SDOGE_CONTRACTS block of ${arcJsFile}.`);
    src = src.replace(re, `$1'${address}',`);
    changed.push(`${key} = ${address}`);
  }
  fs.writeFileSync(arcJsFile, src);
  return changed;
}

if (require.main === module) {
  const file = process.env.DEPLOYMENTS || path.join(__dirname, "..", "deployments", "arc.json");
  try {
    const changed = sync(file);
    console.log(changed.length ? `Updated assets/js/arc.js:\n  ${changed.join("\n  ")}` : "Nothing deployed yet.");
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { sync };
