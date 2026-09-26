// Checks a deployments record against the chain, read-only, and exits 1 on any problem:
// - every recorded contract has code and was created by the recorded transaction, in the
//   recorded block (a record written on a fork of Arc fails here: its transactions never
//   reached Arc);
// - each one is owned by the recorded Safe (2+ signers), with no ownership transfer pending;
// - the wiring: staking's token, NFT collection, notifier and design boosts; the collectibles'
//   treasury and metadata URI;
//   the Studio's treasury, token and revenue routing; the marketplace's Studio, collectibles,
//   fee recipient, fee and revenue routing.
//
//   node scripts/verify-deployment.js        (DEPLOYMENTS=path/to/file.json for another record)
//
// It reads Arc's public RPC, never ARC_RPC_URL (which may be the fork a rehearsal ran on);
// VERIFY_RPC_URL overrides it. Optional: SAFE_ADDRESS (the owner every contract must have),
// EXPECTED_FEE_BPS (the marketplace fee, if the Safe changed it from 200), and the deploy
// scripts' ALLOW_EOA_OWNER / ALLOW_LOW_THRESHOLD / ALLOW_NON_SAFE_OWNER. sync-frontend.js runs
// the same checks before it touches the site.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const c = require("./lib/common");

const DEFAULT_FEE_BPS = 200;
const OWNABLE = ["function owner() view returns (address)", "function pendingOwner() view returns (address)"];
const ABI = {
  SDOGEStaking: [
    ...OWNABLE,
    "function stakingToken() view returns (address)",
    "function boostCollection() view returns (address)",
    "function notifier() view returns (address)",
    "function designBoostBps(uint256) view returns (uint256)",
    "function rewardsStarted() view returns (bool)",
    "function openStakeCount(address) view returns (uint256)",
  ],
  SDOGECollectibles: [
    ...OWNABLE,
    "function treasury() view returns (address)",
    "function nextDesignId() view returns (uint256)",
    "function uri(uint256) view returns (string)",
  ],
  SDOGEStudio: [
    ...OWNABLE,
    "function treasury() view returns (address)",
    "function sdoge() view returns (address)",
    "function rewardsPool() view returns (address)",
    "function poolShareBps() view returns (uint256)",
  ],
  SDOGENFTMarketplace: [
    ...OWNABLE,
    "function studio() view returns (address)",
    "function collectibles() view returns (address)",
    "function rewardsPool() view returns (address)",
    "function feeRecipient() view returns (address)",
    "function feeBps() view returns (uint256)",
  ],
};
// Where each contract's recorded constructor args hold its owner.
const OWNER_ARG = { SDOGEStaking: 2, SDOGECollectibles: 0, SDOGEStudio: 0, SDOGENFTMarketplace: 0 };

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
const same = (a, b) =>
  typeof a === "string" && typeof b === "string" && ethers.isAddress(a) && ethers.isAddress(b) && ethers.getAddress(a) === ethers.getAddress(b);
const brief = (err) => String(err?.shortMessage || err?.reason || err?.message || err).split("\n")[0].slice(0, 160);

// Arc's public RPC takes about 20 eth_calls a second per IP and past that answers -32005, even
// inside a batch. So nothing is batched, requests go out one at a time and spaced out, and a
// rate-limited one is retried after a pause.
class ArcRpcProvider extends ethers.JsonRpcProvider {
  #queue = Promise.resolve();
  #last = 0;

  constructor(url, { gapMs = 60, retries = 5 } = {}) {
    super(url, Number(c.ARC_CHAIN_ID), { staticNetwork: true, batchMaxCount: 1 });
    this.gapMs = gapMs;
    this.retries = retries;
  }

  _send(payload) {
    const result = this.#queue.then(() => this.#sendPaced(payload));
    this.#queue = result.catch(() => {});
    return result;
  }

  async #sendPaced(payload) {
    for (let attempt = 0; ; attempt++) {
      await sleep(this.#last + this.gapMs - Date.now());
      this.#last = Date.now();
      const responses = await super._send(payload);
      if (attempt >= this.retries || !responses.some((r) => r?.error?.code === -32005)) return responses;
      await sleep(250 * 2 ** attempt);
    }
  }
}

const arcProvider = (url = c.ARC_PUBLIC_RPC, pacing) => new ArcRpcProvider(url, pacing);

// [result, description] for a contract's owner, with the deploy scripts' ALLOW_* overrides.
function judgeOwner(account, { allowEoa = false, allowLowThreshold = false, allowNonSafeOwner = false }) {
  if (account.kind === "safe") {
    const what = `Safe, ${account.threshold}-of-${account.owners.length}`;
    if (account.threshold >= 2n) return ["ok", what];
    return [allowLowThreshold ? "warn" : "FAIL", `${what}: fewer than 2 signers`];
  }
  if (account.kind === "eoa") {
    const what = account.delegated ? "an EIP-7702 delegated wallet: a single key, not a Safe" : "a plain wallet: a single key, not a Safe";
    return [allowEoa ? "warn" : "FAIL", what];
  }
  return [allowNonSafeOwner ? "warn" : "FAIL", "a contract that isn't a Safe"];
}

function printTable(rows, log) {
  const head = ["contract", "check", "result", "detail"];
  const width = [0, 1, 2].map((i) => Math.max(head[i].length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((cell, i) => (i < 3 ? cell.padEnd(width[i]) : cell)).join("  ").trimEnd();
  log(line(head));
  log(line([...width.map((w) => "-".repeat(w)), "------"]));
  for (const r of rows) log(line(r));
}

// Returns the problems found (empty when everything checks out). Reads are sequential.
async function verify(opts = {}) {
  const { provider: rpc, log = console.log } = opts;
  if (!rpc) throw new Error("verify() needs a provider.");
  const record = opts.record || JSON.parse(fs.readFileSync(opts.file, "utf8"));
  const recorded = record.contracts || {};
  const sdoge = ethers.getAddress(opts.sdoge || c.SDOGE_TOKEN_ADDRESS);
  let expectedShare = opts.poolShareBps;
  if (expectedShare === undefined) {
    try {
      expectedShare = c.readRepoJson("nft/studio.json").poolShareBps ?? 0;
    } catch {
      // no manifest to compare with
    }
  }

  const rows = [];
  const problems = [];
  const report = (contract, check, result, detail) => {
    rows.push([contract, check, result, String(detail)]);
    if (result === "FAIL") problems.push(`${contract} ${check}: ${detail}`);
  };
  const pass = (contract, check, detail) => report(contract, check, "ok", detail);
  const fail = (contract, check, detail) => report(contract, check, "FAIL", detail);
  const note = (contract, check, detail) => report(contract, check, "note", detail);
  // One read: a revert or an RPC error becomes a problem instead of ending the run.
  const read = async (contract, check, fn) => {
    try {
      return await fn();
    } catch (err) {
      fail(contract, check, `couldn't read it (${brief(err)})`);
      return undefined;
    }
  };
  const expectAddress = (contract, check, actual, expected, source, hint = "") => {
    if (actual === undefined) return;
    if (same(actual, expected)) pass(contract, check, actual);
    else fail(contract, check, `${actual} on-chain, but ${source} ${expected || "nothing"}${hint}`);
  };
  // A revenue pool is either not set yet (routing waits for the Safe's seed stake) or the recorded staking.
  const expectPool = (contract, pool, unset) => {
    if (pool === undefined) return;
    if (pool === ethers.ZeroAddress) note(contract, "rewardsPool", `not set yet: ${unset}`);
    else expectAddress(contract, "rewardsPool", pool, recorded.SDOGEStaking?.address, "the recorded SDOGEStaking is");
  };

  const accounts = new Map();
  const checkOwnership = async (name, contract) => {
    const expected = recorded[name].args?.[OWNER_ARG[name]];
    const owner = await read(name, "owner", () => contract.owner());
    if (owner === undefined) return;
    if (!same(owner, expected)) return fail(name, "owner", `${owner} on-chain, but the record says ${expected}`);
    if (opts.expectedOwner && !same(owner, opts.expectedOwner)) {
      return fail(name, "owner", `${owner}, not the Safe ${opts.expectedOwner} (SAFE_ADDRESS)`);
    }
    if (!accounts.has(owner)) accounts.set(owner, await read(name, "owner", () => c.inspectAccount(rpc, owner)));
    const account = accounts.get(owner);
    if (account) {
      const [result, what] = judgeOwner(account, opts);
      report(name, "owner", result, `${owner} (${what})`);
    }
    const pending = await read(name, "pendingOwner", () => contract.pendingOwner());
    if (pending !== undefined && pending !== ethers.ZeroAddress) {
      fail(name, "pendingOwner", `an ownership transfer to ${pending} is waiting to be accepted`);
    }
  };

  // What each contract must be wired to, besides its owner.
  const bindings = {
    SDOGEStaking: async (name, staking) => {
      const settings = recorded[name].settings || {};
      const batch = " (the staking-setup Safe batch sets it)";
      expectAddress(name, "stakingToken", await read(name, "stakingToken", () => staking.stakingToken()), sdoge, "SDOGE is");
      const collection = await read(name, "boostCollection", () => staking.boostCollection());
      if (recorded.SDOGECollectibles) {
        expectAddress(name, "boostCollection", collection, recorded.SDOGECollectibles.address, "the recorded SDOGECollectibles is");
      } else {
        expectAddress(name, "boostCollection", collection, recorded[name].args?.[1], "the record says");
      }
      const notifier = settings.notifier || ethers.ZeroAddress;
      expectAddress(
        name,
        "notifier",
        await read(name, "notifier", () => staking.notifier()),
        notifier,
        "the record says",
        " (the staking-notifier Safe batch sets it, after the seed stake and the first rewards)"
      );
      // Rewards must start only after the owner's seed stake, or the first stakers split a stream
      // meant for a pool that can't empty.
      const started = await read(name, "seed stake", () => staking.rewardsStarted());
      const owner = await read(name, "seed stake", () => staking.owner());
      const seeds = started && owner !== undefined ? await read(name, "seed stake", () => staking.openStakeCount(owner)) : undefined;
      if (started === false) note(name, "seed stake", "rewards haven't started yet");
      else if (seeds > 0n) pass(name, "seed stake", `the owner has ${seeds} open stake(s)`);
      else if (seeds === 0n) fail(name, "seed stake", "rewards have started, but the owner has no open stake: the seed stake must come first");
      const boosts = Object.entries(settings.designBoosts || {});
      if (!boosts.length) return note(name, "designBoostBps", "none recorded");
      const wrong = [];
      for (const [id, bps] of boosts) {
        const onChain = await read(name, "designBoostBps", () => staking.designBoostBps(id));
        if (onChain === undefined) return;
        if (onChain !== BigInt(bps)) wrong.push(`design ${id} is ${onChain} on-chain, the record says ${bps}`);
      }
      if (wrong.length) fail(name, "designBoostBps", `${wrong.join("; ")}${batch}`);
      else pass(name, "designBoostBps", `all ${boosts.length} designs match the record`);
    },
    SDOGECollectibles: async (name, collectibles) => {
      const [, baseUri, treasury] = recorded[name].args || [];
      expectAddress(name, "treasury", await read(name, "treasury", () => collectibles.treasury()), treasury, "the record says");
      const next = await read(name, "uri", () => collectibles.nextDesignId());
      if (next === undefined) return;
      if (next <= 1n) return note(name, "uri", `no design yet, so the base URI ${baseUri} can't be read back`);
      const uri = await read(name, "uri", () => collectibles.uri(1));
      if (uri === `${baseUri}1.json`) pass(name, "uri", uri);
      else if (uri !== undefined) fail(name, "uri", `design 1 is at ${uri}, but the record's base URI is ${baseUri}`);
    },
    SDOGEStudio: async (name, studio) => {
      expectAddress(name, "treasury", await read(name, "treasury", () => studio.treasury()), recorded[name].args?.[2], "the record says");
      expectAddress(name, "sdoge", await read(name, "sdoge", () => studio.sdoge()), sdoge, "SDOGE is");
      const pool = await read(name, "rewardsPool", () => studio.rewardsPool());
      expectPool(name, pool, "all USDC revenue goes to the treasury");
      const share = await read(name, "poolShareBps", () => studio.poolShareBps());
      if (pool === undefined || share === undefined) return;
      if (pool === ethers.ZeroAddress) {
        if (share === 0n) pass(name, "poolShareBps", "0");
        else fail(name, "poolShareBps", `${share} with no pool`);
      } else if (expectedShare === undefined) note(name, "poolShareBps", `${share} (no nft/studio.json to compare with)`);
      else if (share === BigInt(expectedShare)) pass(name, "poolShareBps", `${share} (nft/studio.json)`);
      else fail(name, "poolShareBps", `${share} on-chain, but nft/studio.json says ${expectedShare}`);
    },
    SDOGENFTMarketplace: async (name, market) => {
      const studio = recorded.SDOGEStudio?.address;
      const collectibles = recorded.SDOGECollectibles?.address;
      expectAddress(name, "studio", await read(name, "studio", () => market.studio()), studio, "the recorded SDOGEStudio is");
      expectAddress(name, "collectibles", await read(name, "collectibles", () => market.collectibles()), collectibles, "the recorded SDOGECollectibles is");
      expectPool(name, await read(name, "rewardsPool", () => market.rewardsPool()), "fees go to the fee recipient");
      expectAddress(name, "feeRecipient", await read(name, "feeRecipient", () => market.feeRecipient()), recorded[name].args?.[3], "the record says");
      const fee = await read(name, "feeBps", () => market.feeBps());
      const expectedFee = opts.feeBps ?? DEFAULT_FEE_BPS;
      if (fee === undefined) return;
      if (fee === BigInt(expectedFee)) return pass(name, "feeBps", fee);
      const hint = opts.feeBps === undefined ? " (set EXPECTED_FEE_BPS if the Safe changed it on purpose)" : "";
      fail(name, "feeBps", `${fee} on-chain, expected ${expectedFee}${hint}`);
    },
  };

  log(`Verifying ${opts.file ? c.rel(opts.file) : "the record"} (chain ${record.chainId})${opts.rpcLabel ? ` against ${opts.rpcLabel}` : ""}\n`);

  const chainId = await read("record", "chain id", async () => BigInt(await rpc.send("eth_chainId", [])));
  if (chainId !== undefined) {
    if (record.chainId != null && BigInt(record.chainId) === chainId) pass("record", "chain id", chainId);
    else fail("record", "chain id", `the RPC is chain ${chainId}, the record is for chain ${record.chainId}`);
  }
  if (!Object.keys(recorded).length) fail("record", "contracts", "nothing is recorded");

  // Contract by contract: code, the deploy transaction, then the owner and the wiring.
  const names = [...Object.keys(bindings).filter((n) => n in recorded), ...Object.keys(recorded).filter((n) => !(n in bindings))];
  for (const name of names) {
    const entry = recorded[name];
    if (typeof entry?.address !== "string" || !ethers.isAddress(entry.address)) {
      fail(name, "address", `${entry?.address} is not an address`);
      continue;
    }
    const address = ethers.getAddress(entry.address);
    const code = await read(name, "code", () => rpc.getCode(address));
    const hasCode = code !== undefined && code !== "0x" && !c.isDelegation(code);
    if (hasCode) pass(name, "code", address);
    else if (code !== undefined) fail(name, "code", `${address} has no contract code`);
    const receipt = await read(name, "deploy tx", () => rpc.getTransactionReceipt(entry.txHash));
    if (receipt === null) fail(name, "deploy tx", `${entry.txHash} isn't on this chain (a record written on a fork?)`);
    else if (receipt) {
      const wrong = [];
      if (receipt.status !== 1) wrong.push("it reverted");
      if (receipt.blockNumber !== Number(entry.block)) wrong.push(`it's in block ${receipt.blockNumber}, the record says ${entry.block}`);
      if (!same(receipt.contractAddress, address)) wrong.push(`it created ${receipt.contractAddress || "no contract"}, not ${address}`);
      if (wrong.length) fail(name, "deploy tx", `${entry.txHash}: ${wrong.join("; ")}`);
      else pass(name, "deploy tx", `${entry.txHash} (block ${receipt.blockNumber})`);
    }
    if (hasCode && bindings[name]) {
      const contract = new ethers.Contract(address, ABI[name], rpc);
      await checkOwnership(name, contract);
      await bindings[name](name, contract);
    }
  }

  printTable(rows, log);
  log(problems.length ? `\n${problems.length} problem(s):\n  - ${problems.join("\n  - ")}` : "\nAll checks passed.");
  return problems;
}

// What the CLI checks against, from the environment. sync-frontend.js uses the same.
function envOptions() {
  const safe = c.envOr("SAFE_ADDRESS");
  if (safe !== undefined && !ethers.isAddress(safe)) throw new Error(`SAFE_ADDRESS (${safe}) is not an address.`);
  const fee = c.envOr("EXPECTED_FEE_BPS");
  if (fee !== undefined && !/^\d+$/.test(fee)) throw new Error(`EXPECTED_FEE_BPS must be a whole number of basis points (got ${fee}).`);
  const url = c.envOr("VERIFY_RPC_URL", c.ARC_PUBLIC_RPC);
  return {
    provider: arcProvider(url),
    rpcLabel: new URL(url).origin, // never the path, where RPC keys usually live
    expectedOwner: safe,
    feeBps: fee === undefined ? undefined : Number(fee),
    allowEoa: c.flag("ALLOW_EOA_OWNER"),
    allowLowThreshold: c.flag("ALLOW_LOW_THRESHOLD"),
    allowNonSafeOwner: c.flag("ALLOW_NON_SAFE_OWNER"),
  };
}

const defaultRecord = () => process.env.DEPLOYMENTS || path.join(__dirname, "..", "deployments", "arc.json");

if (require.main === module) {
  const file = defaultRecord();
  c.cli(async () => {
    if (!fs.existsSync(file)) throw new Error(`${file} doesn't exist: nothing deployed yet (or set DEPLOYMENTS).`);
    const problems = await verify({ file, ...envOptions() });
    if (problems.length) throw new Error(`${path.basename(file)} failed verification.`);
  });
}

module.exports = { verify, arcProvider, envOptions, defaultRecord };
