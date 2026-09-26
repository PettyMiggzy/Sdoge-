// Verifies the recorded contracts' source on Sourcify (which supports Arc, chain 5042), with the
// exact compiler input Hardhat built them from. Arc's explorer shows the source once someone asks
// it for the contract (the site's arc.js does, once per visit).
//
//   npx hardhat compile && node scripts/verify-sourcify.js      (DEPLOYMENTS=path/to/file.json for another record)
//
// It uses Sourcify's v2 API: hardhat-verify still calls the v1 endpoints, which Sourcify has
// retired. The Studio's collection template (made inside the Studio's constructor, the code
// behind every creator collection and Community Art) is verified too.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const c = require("./lib/common");
const { defaultRecord } = require("./verify-deployment");

const API = "https://sourcify.dev/server";
const NAMES = ["SDOGECollectibles", "SDOGEStaking", "SDOGEStudio", "SDOGENFTMarketplace"];
const ARTIFACTS = path.join(__dirname, "..", "artifacts", "contracts");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildInfo(name) {
  const dir = path.join(ARTIFACTS, `${name}.sol`);
  const dbg = JSON.parse(fs.readFileSync(path.join(dir, `${name}.dbg.json`), "utf8"));
  return JSON.parse(fs.readFileSync(path.join(dir, dbg.buildInfo), "utf8"));
}

async function verifyOne({ name, address, txHash }, fetchImpl = globalThis.fetch) {
  const info = buildInfo(name);
  const body = { stdJsonInput: info.input, compilerVersion: info.solcLongVersion, contractIdentifier: `contracts/${name}.sol:${name}` };
  if (txHash) body.creationTransactionHash = txHash;
  const res = await fetchImpl(`${API}/v2/verify/${c.ARC_CHAIN_ID}/${address}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const started = await res.json().catch(() => ({}));
  // 409: already verified.
  if (res.status === 409) return "already verified";
  if (!res.ok) throw new Error(`${name} ${address}: HTTP ${res.status} ${JSON.stringify(started).slice(0, 200)}`);
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const job = await (await fetchImpl(`${API}/v2/verify/${started.verificationId}`)).json();
    if (!job.isJobCompleted) continue;
    if (job.error) throw new Error(`${name} ${address}: ${job.error.customCode || ""} ${job.error.message || JSON.stringify(job.error)}`);
    return `${job.contract.match} (creation ${job.contract.creationMatch}, runtime ${job.contract.runtimeMatch})`;
  }
  throw new Error(`${name} ${address}: Sourcify didn't finish in 3 minutes (job ${started.verificationId}).`);
}

async function run(file = defaultRecord()) {
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const jobs = NAMES.filter((n) => record.contracts[n]).map((n) => ({ name: n, ...record.contracts[n] }));
  if (record.contracts.SDOGEStudio) {
    const rpc = new ethers.JsonRpcProvider(c.envOr("VERIFY_RPC_URL", c.ARC_PUBLIC_RPC), Number(c.ARC_CHAIN_ID), { staticNetwork: true });
    const studio = new ethers.Contract(record.contracts.SDOGEStudio.address, ["function collectionImplementation() view returns (address)"], rpc);
    jobs.push({ name: "SDOGEStudioCollection", address: await studio.collectionImplementation() });
  }
  for (const job of jobs) console.log(`${job.name} ${job.address}: ${await verifyOne(job)}`);
}

if (require.main === module) c.cli(() => run());

module.exports = { run, verifyOne };
