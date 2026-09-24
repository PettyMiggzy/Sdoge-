// Shared deploy-script plumbing: preflight checks, the deployments record and Safe batches.
//
// Every script is a module exporting run(options) (so tests can drive it on a local chain) plus
// a CLI entry that reads options from the environment. The CLI refuses anything but Arc
// mainnet (chain 5042), an owner without contract code (a multisig is expected), and a Safe
// with fewer than 2 signers, unless the matching ALLOW_* override is set.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const ARC_CHAIN_ID = 5042n;
const SDOGE_TOKEN_ADDRESS = "0xf8df98fda14cabb2e8b6efe920081ffcbb0bb405";
const deploymentsDir = () => process.env.DEPLOYMENTS_DIR || path.join(__dirname, "..", "..", "deployments");
const REPO_ROOT = path.join(__dirname, "..", "..", "..");

const SAFE_ABI = ["function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])"];

function envOr(name, fallback) {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

function requireEnv(name, hint) {
  const v = envOr(name, undefined);
  if (v === undefined) throw new Error(`Set ${name}${hint ? `: ${hint}` : ""}.`);
  return v;
}

const flag = (name) => envOr(name, "") === "1";

async function preflight(expectedChainId = ARC_CHAIN_ID) {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== expectedChainId) {
    throw new Error(`Connected to chain ${chainId}, expected ${expectedChainId}. Run with --network arc.`);
  }
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer key: set DEPLOYER_PRIVATE_KEY.");
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Network ${network.name} (chain ${chainId}), deployer ${deployer.address}, ${ethers.formatEther(balance)} USDC for gas`);
  if (balance === 0n) throw new Error("The deployer has no USDC for gas.");
  return deployer;
}

// The owner of every contract should be the team's Safe on Arc: a contract, with 2+ signers.
async function checkOwner(label, address, { allowEoa = false, allowLowThreshold = false } = {}) {
  if (!ethers.isAddress(address)) throw new Error(`${label} (${address}) is not an address.`);
  const owner = ethers.getAddress(address);
  const code = await ethers.provider.getCode(owner);
  if (code === "0x") {
    if (!allowEoa) {
      throw new Error(
        `${label} ${owner} has no contract code on this chain. It should be the team's Safe (multisig) ` +
          `deployed on Arc. Set ALLOW_EOA_OWNER=1 only if you really mean a single key.`
      );
    }
    console.warn(`  WARNING: ${label} ${owner} is a plain wallet (single key), not a multisig.`);
    return owner;
  }
  let threshold;
  let owners;
  try {
    const safe = new ethers.Contract(owner, SAFE_ABI, ethers.provider);
    [threshold, owners] = await Promise.all([safe.getThreshold(), safe.getOwners()]);
  } catch {
    console.warn(`  NOTE: ${label} ${owner} is a contract but not a standard Safe; signer threshold not checked.`);
    return owner;
  }
  if (threshold < 2n && !allowLowThreshold) {
    throw new Error(
      `${label} ${owner} is a ${threshold}-of-${owners.length} Safe. Use at least 2 signers, ` +
        `or set ALLOW_LOW_THRESHOLD=1 if that's intended.`
    );
  }
  console.log(`  ${label}: Safe ${owner} (${threshold}-of-${owners.length})`);
  return owner;
}

// Any wallet or contract that can receive native USDC (treasury, fee recipient).
function checkAddress(label, address) {
  if (!ethers.isAddress(address) || ethers.getAddress(address) === ethers.ZeroAddress) {
    throw new Error(`${label} (${address}) is not a usable address.`);
  }
  return ethers.getAddress(address);
}

async function checkSdoge(address) {
  const token = new ethers.Contract(
    address,
    ["function symbol() view returns (string)", "function decimals() view returns (uint8)"],
    ethers.provider
  );
  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
  if (symbol !== "SDOGE" || decimals !== 18n) {
    throw new Error(`${address} is ${symbol} with ${decimals} decimals, not the 18-decimal SDOGE token.`);
  }
  return ethers.getAddress(address);
}

async function requireCode(label, address) {
  if (!ethers.isAddress(address) || (await ethers.provider.getCode(address)) === "0x") {
    throw new Error(`${label} ${address} has no contract code on this chain.`);
  }
  return ethers.getAddress(address);
}

// ---------- deployments/<network>.json ----------

function deploymentsFile(networkName = network.name) {
  return path.join(deploymentsDir(), `${networkName}.json`);
}

function loadDeployments(networkName = network.name) {
  const file = deploymentsFile(networkName);
  if (!fs.existsSync(file)) return { chainId: null, contracts: {} };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function deployedAddress(name, networkName = network.name) {
  return loadDeployments(networkName).contracts[name]?.address;
}

async function recordDeployment(name, contract, args) {
  const { chainId } = await ethers.provider.getNetwork();
  const receipt = await contract.deploymentTransaction().wait();
  const data = loadDeployments();
  if (data.chainId !== null && BigInt(data.chainId) !== chainId) {
    throw new Error(`${deploymentsFile()} is for chain ${data.chainId}, not ${chainId}.`);
  }
  data.chainId = Number(chainId);
  data.contracts[name] = {
    address: await contract.getAddress(),
    txHash: receipt.hash,
    block: receipt.blockNumber,
    args,
  };
  fs.mkdirSync(deploymentsDir(), { recursive: true });
  const json = JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  fs.writeFileSync(deploymentsFile(), json + "\n");
  console.log(`  recorded in ${path.relative(process.cwd(), deploymentsFile())}`);
  return data.contracts[name];
}

// ---------- Safe batches ----------

// Owner-only follow-ups are never sent by the deployer: they're written as a Safe Transaction
// Builder batch (deployments/<network>-<name>.safe.json) and printed as raw calldata.
async function writeSafeBatch(name, safeAddress, description, calls) {
  const { chainId } = await ethers.provider.getNetwork();
  const batch = {
    version: "1.0",
    chainId: chainId.toString(),
    createdAt: Date.now(),
    meta: { name, description, createdFromSafeAddress: safeAddress },
    transactions: calls.map((c) => ({ to: c.to, value: "0", data: c.data, contractMethod: null, contractInputsValues: null })),
  };
  fs.mkdirSync(deploymentsDir(), { recursive: true });
  const file = path.join(deploymentsDir(), `${network.name}-${name}.safe.json`);
  fs.writeFileSync(file, JSON.stringify(batch, null, 2) + "\n");
  console.log(`\nOwner transactions for the Safe ${safeAddress} (${description}):`);
  for (const c of calls) console.log(`  ${c.label}\n    to:   ${c.to}\n    data: ${c.data}`);
  console.log(`Saved as a Safe Transaction Builder batch: ${path.relative(process.cwd(), file)}`);
  return { file, batch };
}

function call(contract, label, fn, args) {
  return { label, to: contract.target, data: contract.interface.encodeFunctionData(fn, args) };
}

// ---------- units ----------

// "40" or "12.5" USDC -> 18-decimal native wei, rejecting more than 6 decimals.
function usdcToWei(text, what) {
  const s = String(text).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`${what}: "${text}" is not a USDC amount with at most 6 decimals.`);
  return ethers.parseEther(s);
}

function sdogeToWei(text, what) {
  const s = String(text).trim();
  if (!/^\d+(\.\d{1,18})?$/.test(s)) throw new Error(`${what}: "${text}" is not a SDOGE amount.`);
  return ethers.parseEther(s);
}

function readRepoJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"));
}

function cli(run) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`\nERROR: ${err.message}`);
      process.exit(1);
    });
}

module.exports = {
  ARC_CHAIN_ID,
  SDOGE_TOKEN_ADDRESS,
  REPO_ROOT,
  envOr,
  requireEnv,
  flag,
  preflight,
  checkOwner,
  checkAddress,
  checkSdoge,
  requireCode,
  loadDeployments,
  deployedAddress,
  recordDeployment,
  writeSafeBatch,
  call,
  usdcToWei,
  sdogeToWei,
  readRepoJson,
  cli,
};
