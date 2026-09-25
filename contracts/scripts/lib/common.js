// Shared deploy-script plumbing: preflight checks, the deployments record and Safe batches.
//
// Every script is a module exporting run(options) (so tests can drive it on a local chain) plus
// a CLI entry that reads options from the environment. Everything a script needs is checked
// before its first transaction: the chain (Arc mainnet, 5042), the record (a contract already in
// it is refused unless FORCE_REDEPLOY=1), the owner (a Safe with 2+ signers unless the matching
// ALLOW_* override is set, never the deployer), every recipient and every dependency.
//
// Hardhat is only loaded when a helper needs the connected chain, so verify-deployment.js and
// sync-frontend.js can use this file from plain node.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const hre = () => require("hardhat");
const provider = () => hre().ethers.provider;

const ARC_CHAIN_ID = 5042n;
const ARC_PUBLIC_RPC = "https://rpc.mainnet.arc.io";
const SDOGE_TOKEN_ADDRESS = "0xf8df98fda14cabb2e8b6efe920081ffcbb0bb405";
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const USDC_SYSTEM_TOKEN = "0x3600000000000000000000000000000000000000";
const IPFS_GATEWAY = "https://ipfs.io/ipfs/";
const deploymentsDir = () => process.env.DEPLOYMENTS_DIR || path.join(__dirname, "..", "..", "deployments");
const REPO_ROOT = path.join(__dirname, "..", "..", "..");

const SAFE_ABI = ["function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])"];

const rel = (file) => {
  const r = path.relative(process.cwd(), file);
  return r.startsWith("..") ? file : r;
};

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

// The overrides every deploy script reads from the environment.
function overrides() {
  return {
    allowEoa: flag("ALLOW_EOA_OWNER"),
    allowLowThreshold: flag("ALLOW_LOW_THRESHOLD"),
    allowNonSafeOwner: flag("ALLOW_NON_SAFE_OWNER"),
    force: flag("FORCE_REDEPLOY"),
  };
}

async function preflight(expectedChainId = ARC_CHAIN_ID) {
  const { ethers: hh, network } = hre();
  const { chainId } = await hh.provider.getNetwork();
  if (chainId !== expectedChainId) {
    throw new Error(`Connected to chain ${chainId}, expected ${expectedChainId}. Run with --network arc.`);
  }
  const [deployer] = await hh.getSigners();
  if (!deployer) throw new Error("No deployer key: set DEPLOYER_PRIVATE_KEY.");
  const balance = await hh.provider.getBalance(deployer.address);
  console.log(`Network ${network.name} (chain ${chainId}), deployer ${deployer.address}, ${ethers.formatEther(balance)} USDC for gas`);
  if (recordName() !== network.name) {
    console.warn(
      `  NOTE: ARC_RPC_URL isn't Arc's public RPC, so this run counts as a rehearsal (a fork of Arc also ` +
        `reports chain 5042) and is recorded in ${rel(deploymentsFile())}. If it's a private mainnet RPC, ` +
        `set ARC_RECORD_MAINNET=1.`
    );
  }
  if (balance === 0n) throw new Error("The deployer has no USDC for gas.");
  return deployer;
}

// ---------- addresses ----------

function parseAddress(label, address) {
  if (typeof address !== "string" || !ethers.isAddress(address)) throw new Error(`${label} (${address}) is not an address.`);
  return ethers.getAddress(address);
}

// Addresses nobody can use: whatever is sent there is lost or refused.
function reservedAddress(address) {
  const a = ethers.getAddress(address);
  if (a === ethers.ZeroAddress) return "the zero address";
  if (a === BURN_ADDRESS) return "the burn address (0x...dEaD)";
  if (a.toLowerCase() === USDC_SYSTEM_TOKEN) return "Arc's USDC system token (0x3600...)";
  if (BigInt(a) <= 0xffffn) return "a precompile or system address";
  return null;
}

// An EIP-7702 delegation designator (0xef0100 + the delegate's address, 23 bytes): the account
// is still an EOA whose single key can re-delegate at any time, whatever the delegate is.
const isDelegation = (code) => typeof code === "string" && code.toLowerCase().startsWith("0xef0100");

// What kind of account `address` is: "eoa" (no code, or a 7702 delegation), "safe" (answers
// getThreshold/getOwners consistently) or "contract". Calls are sequential on purpose: Arc's
// public RPC rate-limits eth_call.
async function inspectAccount(rpc, address) {
  const code = await rpc.getCode(address);
  if (code === "0x") return { kind: "eoa", delegated: false };
  if (isDelegation(code)) return { kind: "eoa", delegated: true };
  try {
    const safe = new ethers.Contract(address, SAFE_ABI, rpc);
    const threshold = await safe.getThreshold();
    const owners = [...(await safe.getOwners())];
    if (owners.length > 0 && threshold > 0n && threshold <= BigInt(owners.length)) return { kind: "safe", threshold, owners };
  } catch {
    // doesn't answer like a Safe
  }
  return { kind: "contract" };
}

// The owner of every contract should be the team's Safe on Arc: a contract, with 2+ signers.
async function checkOwner(label, address, { deployer, allowEoa = false, allowLowThreshold = false, allowNonSafeOwner = false } = {}) {
  const owner = parseAddress(label, address);
  const reserved = reservedAddress(owner);
  if (reserved) throw new Error(`${label} ${owner} is ${reserved}; nobody could ever act as owner.`);
  if (deployer && owner === ethers.getAddress(deployer)) {
    throw new Error(`${label} ${owner} is the deployer key. The deployer only pays gas; make the team's Safe the owner.`);
  }
  const account = await inspectAccount(provider(), owner);
  if (account.kind === "eoa") {
    const what = account.delegated
      ? "is a wallet with an EIP-7702 delegation: still a single key, not a Safe"
      : "has no contract code on this chain: a plain wallet (single key), not a Safe";
    if (!allowEoa) {
      throw new Error(
        `${label} ${owner} ${what}. It should be the team's Safe (multisig) deployed on Arc. ` +
          `Set ALLOW_EOA_OWNER=1 only if you really mean a single key.`
      );
    }
    console.warn(`  WARNING: ${label} ${owner} ${what}.`);
    return owner;
  }
  if (account.kind === "contract") {
    if (!allowNonSafeOwner) {
      throw new Error(
        `${label} ${owner} is a contract but not a Safe (getThreshold/getOwners don't answer like one). ` +
          `Use the team's Safe, or set ALLOW_NON_SAFE_OWNER=1 if this contract really should own it.`
      );
    }
    console.warn(`  WARNING: ${label} ${owner} is a contract but not a standard Safe; signer threshold not checked.`);
    return owner;
  }
  const { threshold, owners } = account;
  if (threshold < 2n && !allowLowThreshold) {
    throw new Error(
      `${label} ${owner} is a ${threshold}-of-${owners.length} Safe. Use at least 2 signers, ` +
        `or set ALLOW_LOW_THRESHOLD=1 if that's intended.`
    );
  }
  console.log(`  ${label}: Safe ${owner} (${threshold}-of-${owners.length})`);
  return owner;
}

// A treasury, fee recipient, token sink or notifier: never a reserved address. A USDC recipient
// must also take a plain native transfer, because that's how the Studio and the collectibles pay
// it: one that reverts would block their payouts.
async function checkAddress(label, address, { from, receivesUsdc = false } = {}) {
  const a = parseAddress(label, address);
  const reserved = reservedAddress(a);
  if (reserved) throw new Error(`${label} ${a} is ${reserved}, not a usable address.`);
  if (receivesUsdc) {
    const sender = from || (await hre().ethers.getSigners())[0]?.address;
    try {
      await provider().call({ from: sender, to: a, value: 1n });
    } catch (err) {
      throw new Error(
        `${label} ${a} refuses native USDC: a test transfer of 1 wei reverted (${err.shortMessage || err.message}). ` +
          `Use a wallet or a contract with a payable receive(), such as the Safe.`
      );
    }
  }
  return a;
}

async function requireCode(label, address) {
  const a = parseAddress(label, address);
  const code = await provider().getCode(a);
  if (code === "0x" || isDelegation(code)) throw new Error(`${label} ${a} has no contract code on this chain.`);
  return a;
}

async function checkSdoge(address) {
  const a = await requireCode("SDOGE token", address);
  const token = new ethers.Contract(
    a,
    ["function symbol() view returns (string)", "function decimals() view returns (uint8)"],
    provider()
  );
  let symbol;
  let decimals;
  try {
    symbol = await token.symbol();
    decimals = await token.decimals();
  } catch {
    throw new Error(`${a} doesn't answer symbol()/decimals(); it isn't the SDOGE token.`);
  }
  if (symbol !== "SDOGE" || decimals !== 18n) {
    throw new Error(`${a} is ${symbol} with ${decimals} decimals, not the 18-decimal SDOGE token.`);
  }
  return a;
}

// The recorded SDOGEStaking that revenue will be routed to: it must have code and stake SDOGE.
async function checkStakingPool(address, sdoge) {
  const a = await requireCode("SDOGEStaking", address);
  let staked;
  try {
    staked = await new ethers.Contract(a, ["function stakingToken() view returns (address)"], provider()).stakingToken();
  } catch {
    throw new Error(`SDOGEStaking ${a} doesn't answer stakingToken(); check the record.`);
  }
  if (ethers.getAddress(staked) !== ethers.getAddress(sdoge)) {
    throw new Error(`SDOGEStaking ${a} stakes ${staked}, not SDOGE ${ethers.getAddress(sdoge)}; check the record.`);
  }
  return a;
}

// ---------- deployments/<record>.json ----------

// The record's name: the network's, except that an anvil fork of Arc also reports chain 5042 (and
// Arc's genesis), so a run on "arc" through any RPC but the public one is a rehearsal, recorded
// apart, unless ARC_RECORD_MAINNET=1 says the RPC is a private mainnet one.
function recordName({ networkName = hre().network.name, url = hre().network.config.url, env = process.env } = {}) {
  if (networkName !== "arc") return networkName;
  const isPublic = String(url || "").trim().replace(/\/+$/, "").toLowerCase() === ARC_PUBLIC_RPC;
  return isPublic || String(env.ARC_RECORD_MAINNET || "").trim() === "1" ? "arc" : "arc-rehearsal";
}

function deploymentsFile(name = recordName()) {
  return path.join(deploymentsDir(), `${name}.json`);
}

function safeBatchFile(batch, name = recordName()) {
  return path.join(deploymentsDir(), `${name}-${batch}.safe.json`);
}

function loadDeployments(name = recordName()) {
  const file = deploymentsFile(name);
  if (!fs.existsSync(file)) return { chainId: null, contracts: {} };
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.contracts = data.contracts || {};
  return data;
}

function deployedAddress(contractName, name = recordName()) {
  return loadDeployments(name).contracts[contractName]?.address;
}

// Before any transaction: the record must be for this chain and writable, and must not hold
// `name` yet. With force (FORCE_REDEPLOY=1) a new one is deployed anyway; recordDeployment keeps
// the old entry under "replaced".
async function checkRecord(name, { force = false } = {}) {
  const file = deploymentsFile();
  const data = loadDeployments();
  const { chainId } = await provider().getNetwork();
  if (data.chainId !== null && BigInt(data.chainId) !== chainId) {
    throw new Error(`${rel(file)} is for chain ${data.chainId}, not ${chainId}. Nothing was sent.`);
  }
  const existing = data.contracts[name];
  if (existing) {
    if (!force) {
      throw new Error(
        `${name} is already recorded in ${rel(file)} (${existing.address}, block ${existing.block}). Nothing was sent. ` +
          `Check it with scripts/verify-deployment.js, or set FORCE_REDEPLOY=1 to deploy a new one and replace the record.`
      );
    }
    console.warn(
      `  WARNING: FORCE_REDEPLOY=1: ${name} ${existing.address} will be replaced in ${rel(file)}. ` +
        `Anything wired to the old one must be re-pointed.`
    );
  }
  try {
    fs.mkdirSync(deploymentsDir(), { recursive: true });
    fs.accessSync(deploymentsDir(), fs.constants.W_OK);
  } catch (err) {
    throw new Error(`Can't write the record in ${deploymentsDir()} (${err.code || err.message}). Nothing was sent.`);
  }
  console.log(`  record: ${rel(file)}`);
  return file;
}

// `extra` holds anything verify-deployment.js should check later (e.g. the settings a Safe batch
// applies).
async function recordDeployment(name, contract, args, extra = {}) {
  const { chainId } = await provider().getNetwork();
  const receipt = await contract.deploymentTransaction().wait();
  const file = deploymentsFile();
  const data = loadDeployments();
  if (data.chainId !== null && BigInt(data.chainId) !== chainId) {
    throw new Error(`${rel(file)} is for chain ${data.chainId}, not ${chainId}.`);
  }
  data.chainId = Number(chainId);
  const address = await contract.getAddress();
  // A forced redeploy keeps the old entry: that contract may still hold funds or be wired somewhere.
  const previous = data.contracts[name];
  if (previous) (data.replaced ||= []).push({ name, ...previous, replacedBy: address });
  data.contracts[name] = { address, txHash: receipt.hash, block: receipt.blockNumber, args, ...extra };
  fs.mkdirSync(deploymentsDir(), { recursive: true });
  const json = JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  fs.writeFileSync(file, json + "\n");
  console.log(`  recorded in ${rel(file)}`);
  return data.contracts[name];
}

// ---------- Safe batches ----------

// Owner-only follow-ups are never sent by the deployer: they're written as a Safe Transaction
// Builder batch (deployments/<record>-<name>.safe.json) and printed as raw calldata.
async function writeSafeBatch(name, safeAddress, description, calls) {
  const { chainId } = await provider().getNetwork();
  const batch = {
    version: "1.0",
    chainId: chainId.toString(),
    createdAt: Date.now(),
    meta: { name, description, createdFromSafeAddress: safeAddress },
    transactions: calls.map((c) => ({ to: c.to, value: "0", data: c.data, contractMethod: null, contractInputsValues: null })),
  };
  fs.mkdirSync(deploymentsDir(), { recursive: true });
  const file = safeBatchFile(name);
  fs.writeFileSync(file, JSON.stringify(batch, null, 2) + "\n");
  console.log(`\nOwner transactions for the Safe ${safeAddress} (${description}):`);
  for (const c of calls) console.log(`  ${c.label}\n    to:   ${c.to}\n    data: ${c.data}`);
  console.log(`Saved as a Safe Transaction Builder batch: ${rel(file)}`);
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

// ---------- files and metadata links ----------

function readRepoJson(file) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, file), "utf8"));
}

function toHttp(uri) {
  return uri.startsWith("ipfs://") ? IPFS_GATEWAY + uri.slice("ipfs://".length) : uri;
}

// A metadata link the contracts will take (they revert on anything but 1-512 bytes of printable
// ASCII without spaces), on ipfs:// or https://, with no placeholder left in it.
function checkUri(label, uri) {
  if (typeof uri !== "string" || !/^(ipfs:\/\/|https:\/\/)./.test(uri)) {
    throw new Error(`${label} must start with ipfs:// or https:// (got ${uri}).`);
  }
  if (!/^[\x21-\x7e]+$/.test(uri)) throw new Error(`${label} must be printable ASCII with no spaces (got ${JSON.stringify(uri)}).`);
  if (uri.length > 512) throw new Error(`${label} is ${uri.length} bytes; the contract takes at most 512.`);
  for (const bad of ["{id}", "REPLACE_ME", ".example", "localhost"]) {
    if (uri.includes(bad)) throw new Error(`${label} contains "${bad}": ${uri}`);
  }
  return uri;
}

async function fetchJson(uri, fetchImpl = globalThis.fetch) {
  const url = toHttp(uri);
  try {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    throw new Error(`Could not load ${url}: ${err.message}`);
  }
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
  ARC_PUBLIC_RPC,
  SDOGE_TOKEN_ADDRESS,
  BURN_ADDRESS,
  USDC_SYSTEM_TOKEN,
  REPO_ROOT,
  rel,
  envOr,
  requireEnv,
  flag,
  overrides,
  preflight,
  reservedAddress,
  isDelegation,
  inspectAccount,
  checkOwner,
  checkAddress,
  checkSdoge,
  requireCode,
  checkStakingPool,
  recordName,
  deploymentsFile,
  safeBatchFile,
  loadDeployments,
  deployedAddress,
  checkRecord,
  recordDeployment,
  writeSafeBatch,
  call,
  usdcToWei,
  sdogeToWei,
  readRepoJson,
  toHttp,
  checkUri,
  fetchJson,
  cli,
};
