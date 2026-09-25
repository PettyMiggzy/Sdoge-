// Copies the deployed addresses from deployments/arc.json into the site's SDOGE_CONTRACTS
// block in assets/js/arc.js, the one place the pages read them from. It first runs
// verify-deployment.js against Arc and changes nothing unless every check passes, so a record
// written on a fork, or a contract wired to the wrong thing, never reaches the site.
//
//   node scripts/sync-frontend.js            (or DEPLOYMENTS=path/to/file.json to use another)
//
// It takes verify-deployment.js's settings (VERIFY_RPC_URL, SAFE_ADDRESS, EXPECTED_FEE_BPS,
// ALLOW_*). SKIP_VERIFY=1 skips the on-chain check, for local testing only.
const fs = require("fs");
const path = require("path");
const c = require("./lib/common");
const { verify, envOptions, defaultRecord } = require("./verify-deployment");

const ROOT = path.join(__dirname, "..", "..");
const ARC_JS = path.join(ROOT, "assets", "js", "arc.js");
const KEYS = { staking: "SDOGEStaking", collectibles: "SDOGECollectibles", studio: "SDOGEStudio", marketplace: "SDOGENFTMarketplace" };

// Tests pass expectedChainId and a verifier or provider; everything else goes to verify().
async function sync(deploymentsFile, arcJsFile = ARC_JS, opts = {}) {
  const { expectedChainId = Number(c.ARC_CHAIN_ID), skipVerify = false, verifier = verify, ...verifyOptions } = opts;
  const record = JSON.parse(fs.readFileSync(deploymentsFile, "utf8"));
  if (record.chainId !== Number(expectedChainId)) {
    const expected = Number(expectedChainId) === Number(c.ARC_CHAIN_ID) ? "Arc (5042)" : expectedChainId;
    throw new Error(`${deploymentsFile} is for chain ${record.chainId}, not ${expected}.`);
  }
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
  if (!changed.length) return changed;
  if (skipVerify) {
    console.warn("WARNING: SKIP_VERIFY=1 - the record was not checked on-chain. Never ship an arc.js written this way.");
  } else {
    const problems = await verifier({ ...verifyOptions, file: deploymentsFile, record });
    if (problems.length) {
      throw new Error(
        `${path.basename(deploymentsFile)} failed verification (${problems.length} problem(s), listed above), ` +
          `so ${path.basename(arcJsFile)} was not changed.`
      );
    }
  }
  fs.writeFileSync(arcJsFile, src);
  return changed;
}

if (require.main === module) {
  const file = defaultRecord();
  c.cli(async () => {
    const skipVerify = c.flag("SKIP_VERIFY");
    const changed = await sync(file, ARC_JS, skipVerify ? { skipVerify } : envOptions());
    console.log(changed.length ? `Updated assets/js/arc.js:\n  ${changed.join("\n  ")}` : "Nothing deployed yet.");
  });
}

module.exports = { sync };
