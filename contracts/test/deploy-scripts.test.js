// Runs the real deploy scripts against the in-process chain, with a MockSafe as the owner.
const { expect } = require("chai");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { ethers } = require("hardhat");

const c = require("../scripts/lib/common");
const deployStaking = require("../scripts/deploy-staking");
const deployCollectibles = require("../scripts/deploy-collectibles");
const setupDesigns = require("../scripts/setup-designs");
const deployStudio = require("../scripts/deploy-studio");
const deployMarketplace = require("../scripts/deploy-marketplace");
const { verify, arcProvider } = require("../scripts/verify-deployment");
const { sync } = require("../scripts/sync-frontend");

const LOCAL = 31337n;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const USDC_SYSTEM = "0x3600000000000000000000000000000000000000";
const readRepoJson = (file) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", file), "utf8"));
const { designs } = readRepoJson("nft/designs.json");
const studioManifest = readRepoJson("nft/studio.json");

// Serves the 12 metadata files the way a pinned folder would.
const okFetch = async (url) => {
  const id = Number(url.match(/(\d+)\.json$/)[1]);
  return { ok: true, json: async () => ({ name: designs[id - 1].name, image: `ipfs://bafyimages/${id}.png` }) };
};

// nft/studio.json with the Community Art collection's metadata pinned.
const CONTRACT_URI = "ipfs://bafycommunity/collection.json";
const contractFetch = async () => ({ ok: true, json: async () => ({ name: "SDOGE Community Art" }) });
const pinnedStudio = { manifest: { ...studioManifest, communityContractURI: CONTRACT_URI }, fetchImpl: contractFetch };

async function quiet(fn) {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

// What the operator is told: everything fn prints.
async function capture(fn) {
  const { log, warn } = console;
  let out = "";
  console.log = console.warn = (...args) => {
    out += args.join(" ") + "\n";
  };
  try {
    return { result: await fn(), out };
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

async function fixture() {
  process.env.DEPLOYMENTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sdoge-deploy-"));
  const [deployer, s1, s2, treasury, notifier, other] = await ethers.getSigners();
  const Safe = await ethers.getContractFactory("MockSafe");
  const safe = await Safe.deploy(2, [s1.address, s2.address]);
  const soloSafe = await Safe.deploy(1, [s1.address]);
  const sdoge = await (await ethers.getContractFactory("MockERC20")).deploy("Stable Doge", "SDOGE");
  // The NFT collection a staking deploy is tied to when no SDOGECollectibles is recorded yet.
  const collection = await (await ethers.getContractFactory("SDOGECollectibles")).deploy(
    await safe.getAddress(),
    "ipfs://bafyboost/",
    treasury.address
  );
  const base = {
    expectedChainId: LOCAL,
    owner: await safe.getAddress(),
    sdoge: await sdoge.getAddress(),
    collection: await collection.getAddress(),
  };
  return { deployer, treasury, notifier, other, safe, soloSafe, sdoge, collection, base };
}

const recordFile = () => path.join(process.env.DEPLOYMENTS_DIR, "hardhat.json");
const readRecord = () => JSON.parse(fs.readFileSync(recordFile(), "utf8"));
const writeRecord = (data) => fs.writeFileSync(recordFile(), JSON.stringify(data, null, 2));
const readBatch = (name) => JSON.parse(fs.readFileSync(path.join(process.env.DEPLOYMENTS_DIR, `hardhat-${name}.safe.json`), "utf8"));
const nonceOf = (signer) => ethers.provider.getTransactionCount(signer.address);
const encode = (contract, fn, args) => contract.interface.encodeFunctionData(fn, args);

// Executes a written Safe batch (a script's result, or a batch file's contents) through the MockSafe.
async function execBatch(safe, result) {
  for (const tx of (result.batch || result).transactions) await safe.exec(tx.to, tx.data);
}

// Every contract deployed by the scripts, the staking settings applied by the Safe, and the 12
// designs created (so the collectibles' URI can be read back). Revenue isn't routed to staking yet.
// Staking comes after the collectibles, whose NFTs boost stakes.
async function deployAll(f) {
  const { collectibles } = await quiet(() =>
    deployCollectibles.run({ ...f.base, treasury: f.treasury.address, baseUri: "ipfs://bafymeta/", fetchImpl: okFetch })
  );
  await execBatch(f.safe, await quiet(() => setupDesigns.run({ expectedChainId: LOCAL })));
  const { staking } = await quiet(() =>
    deployStaking.run({ ...f.base, collection: undefined, notifier: f.notifier.address })
  );
  await execBatch(f.safe, readBatch("staking-setup"));
  await execBatch(f.safe, readBatch("staking-notifier"));
  const { studio } = await quiet(() => deployStudio.run({ ...f.base, treasury: f.treasury.address, ...pinnedStudio }));
  const { marketplace } = await quiet(() => deployMarketplace.run({ ...f.base, feeRecipient: f.treasury.address }));
  return { staking, collectibles, studio, marketplace };
}

const check = (f, extra = {}) =>
  verify({ file: recordFile(), provider: ethers.provider, sdoge: f.base.sdoge, log: () => {}, ...extra });

describe("deploy scripts", function () {
  after(() => delete process.env.DEPLOYMENTS_DIR);

  describe("preflight guards", function () {
    it("refuse the wrong chain", async function () {
      const f = await fixture();
      await expect(quiet(() => deployStaking.run({ ...f.base, expectedChainId: 5042n }))).to.be.rejectedWith(
        "Connected to chain 31337, expected 5042"
      );
    });

    it("refuse an owner that isn't a multisig, unless told otherwise", async function () {
      const f = await fixture();
      await expect(quiet(() => deployStaking.run({ ...f.base, owner: f.treasury.address }))).to.be.rejectedWith(
        "has no contract code"
      );
      const solo = await f.soloSafe.getAddress();
      await expect(quiet(() => deployStaking.run({ ...f.base, owner: solo }))).to.be.rejectedWith("is a 1-of-1 Safe");
      await quiet(() => deployStaking.run({ ...f.base, owner: f.treasury.address, allowEoa: true }));
      await quiet(() => deployStaking.run({ ...f.base, owner: solo, allowLowThreshold: true, force: true }));
    });

    it("refuse an EIP-7702 delegated wallet as owner, even one delegating to a Safe", async function () {
      const f = await fixture();
      const wallet = ethers.Wallet.createRandom().address;
      await ethers.provider.send("hardhat_setCode", [wallet, "0xef0100" + (await f.safe.getAddress()).slice(2)]);
      expect((await ethers.provider.getCode(wallet)).length).to.equal(2 + 23 * 2);
      const nonce = await nonceOf(f.deployer);
      await expect(quiet(() => deployStaking.run({ ...f.base, owner: wallet }))).to.be.rejectedWith(
        "is a wallet with an EIP-7702 delegation: still a single key, not a Safe"
      );
      expect(await nonceOf(f.deployer)).to.equal(nonce);
      // It's a single key, so only the single-key override lets it through.
      const { result, out } = await capture(() => deployStaking.run({ ...f.base, owner: wallet, allowEoa: true }));
      expect(out).to.include("EIP-7702");
      expect(await result.staking.owner()).to.equal(wallet);
    });

    it("refuse the deployer, an unusable address, or a contract that isn't a Safe as owner", async function () {
      const f = await fixture();
      const token = f.base.sdoge; // a contract, but not a Safe
      const nonce = await nonceOf(f.deployer);
      const bad = (owner, extra = {}) => quiet(() => deployStaking.run({ ...f.base, owner, ...extra }));
      await expect(bad(f.deployer.address, { allowEoa: true })).to.be.rejectedWith("is the deployer key");
      await expect(bad(DEAD, { allowEoa: true })).to.be.rejectedWith("the burn address");
      await expect(bad("0x0000000000000000000000000000000000000004", { allowEoa: true })).to.be.rejectedWith("a precompile");
      await expect(bad(token)).to.be.rejectedWith("is a contract but not a Safe");
      await expect(bad(token, { allowEoa: true, allowLowThreshold: true })).to.be.rejectedWith("ALLOW_NON_SAFE_OWNER=1");
      expect(await nonceOf(f.deployer)).to.equal(nonce);
      const { staking } = await bad(token, { allowNonSafeOwner: true });
      expect(await staking.owner()).to.equal(token);
    });

    it("refuse a token that isn't SDOGE", async function () {
      const f = await fixture();
      const other = await (await ethers.getContractFactory("MockERC20")).deploy("Other", "OTHER");
      const otherAddress = await other.getAddress();
      await expect(quiet(() => deployStaking.run({ ...f.base, sdoge: otherAddress }))).to.be.rejectedWith(
        "not the 18-decimal SDOGE token"
      );
      await expect(quiet(() => deployStaking.run({ ...f.base, sdoge: f.treasury.address }))).to.be.rejectedWith(
        "has no contract code"
      );
    });
  });

  describe("the deployments record", function () {
    it("is named after the network; on arc, any RPC but the public one records a rehearsal", function () {
      const name = (networkName, url, env = {}) => c.recordName({ networkName, url, env });
      expect(name("arc", "https://rpc.mainnet.arc.io")).to.equal("arc");
      expect(name("arc", "https://rpc.mainnet.arc.io/")).to.equal("arc");
      // anvil --fork-url https://rpc.mainnet.arc.io: chain 5042, same genesis, but not Arc.
      expect(name("arc", "http://127.0.0.1:8545")).to.equal("arc-rehearsal");
      expect(name("arc", undefined)).to.equal("arc-rehearsal");
      expect(name("arc", "https://arc-mainnet.some-provider.io/v2/KEY")).to.equal("arc-rehearsal");
      expect(name("arc", "https://arc-mainnet.some-provider.io/v2/KEY", { ARC_RECORD_MAINNET: "1" })).to.equal("arc");
      expect(name("arc", "http://127.0.0.1:8545", { ARC_RECORD_MAINNET: "0" })).to.equal("arc-rehearsal");
      expect(name("hardhat", undefined)).to.equal("hardhat");
      expect(name("localhost", "http://127.0.0.1:8545", { ARC_RECORD_MAINNET: "1" })).to.equal("localhost");
      expect(c.recordName()).to.equal("hardhat"); // this in-process chain
      expect(path.basename(c.deploymentsFile("arc-rehearsal"))).to.equal("arc-rehearsal.json");
      expect(path.basename(c.safeBatchFile("studio-setup", "arc-rehearsal"))).to.equal("arc-rehearsal-studio-setup.safe.json");
    });

    it("keeps a run on arc through a fork's RPC out of arc.json, unless ARC_RECORD_MAINNET=1", async function () {
      const f = await fixture();
      const { network } = require("hardhat");
      const saved = { name: network.name, url: network.config.url };
      const files = () => fs.readdirSync(process.env.DEPLOYMENTS_DIR).sort();
      // Pretend this chain is `--network arc` with ARC_RPC_URL pointing at a local anvil fork.
      network.name = "arc";
      network.config.url = "http://127.0.0.1:8545";
      try {
        const { out } = await capture(() => deployStaking.run({ ...f.base, notifier: f.notifier.address }));
        expect(out).to.include("counts as a rehearsal");
        expect(files()).to.deep.equal(["arc-rehearsal-staking-notifier.safe.json", "arc-rehearsal-staking-setup.safe.json", "arc-rehearsal.json"]);
        process.env.ARC_RECORD_MAINNET = "1";
        await quiet(() => deployStaking.run({ ...f.base, notifier: f.notifier.address }));
        expect(files()).to.include.members(["arc.json", "arc-staking-setup.safe.json", "arc-staking-notifier.safe.json"]);
      } finally {
        delete process.env.ARC_RECORD_MAINNET;
        network.name = saved.name;
        if (saved.url === undefined) delete network.config.url;
        else network.config.url = saved.url;
      }
    });

    it("refuses to redeploy a recorded contract before sending anything, unless forced", async function () {
      const f = await fixture();
      const { staking: first } = await quiet(() => deployStaking.run(f.base));
      const nonce = await nonceOf(f.deployer);
      await expect(quiet(() => deployStaking.run(f.base))).to.be.rejectedWith("SDOGEStaking is already recorded");
      expect(await nonceOf(f.deployer)).to.equal(nonce);

      const { result, out } = await capture(() => deployStaking.run({ ...f.base, force: true }));
      expect(out).to.include("FORCE_REDEPLOY=1");
      const rec = readRecord();
      expect(rec.contracts.SDOGEStaking.address).to.equal(await result.staking.getAddress());
      expect(rec.replaced).to.have.length(1);
      expect(rec.replaced[0]).to.include({
        name: "SDOGEStaking",
        address: await first.getAddress(),
        replacedBy: await result.staking.getAddress(),
      });
    });

    it("every deploy script refuses its contract once it's recorded", async function () {
      const f = await fixture();
      await deployAll(f);
      const nonce = await nonceOf(f.deployer);
      const again = [
        [() => deployStaking.run(f.base), "SDOGEStaking"],
        [() => deployCollectibles.run({ ...f.base, treasury: f.treasury.address, baseUri: "ipfs://bafymeta/", fetchImpl: okFetch }), "SDOGECollectibles"],
        [() => deployStudio.run({ ...f.base, treasury: f.treasury.address, ...pinnedStudio }), "SDOGEStudio"],
        [() => deployMarketplace.run({ ...f.base, feeRecipient: f.treasury.address }), "SDOGENFTMarketplace"],
      ];
      for (const [run, name] of again) await expect(quiet(run)).to.be.rejectedWith(`${name} is already recorded`);
      expect(await nonceOf(f.deployer)).to.equal(nonce);
    });

    it("refuses a record kept for another chain, before sending anything", async function () {
      const f = await fixture();
      writeRecord({ chainId: 5042, contracts: {} });
      const nonce = await nonceOf(f.deployer);
      await expect(quiet(() => deployStaking.run(f.base))).to.be.rejectedWith("is for chain 5042, not 31337");
      expect(await nonceOf(f.deployer)).to.equal(nonce);
    });
  });

  describe("inputs are checked before the first transaction", function () {
    it("staking: the NFT collection, the boosts and the notifier", async function () {
      const f = await fixture();
      const refuser = await (await ethers.getContractFactory("RevertingReceiver")).deploy();
      const nonce = await nonceOf(f.deployer);
      const bad = (extra) => quiet(() => deployStaking.run({ ...f.base, ...extra }));
      await expect(bad({ collection: undefined })).to.be.rejectedWith("No SDOGECollectibles in the record. Deploy it first");
      await expect(bad({ collection: DEAD })).to.be.rejectedWith(`SDOGECollectibles ${DEAD} has no contract code`);
      await expect(bad({ collection: f.base.sdoge })).to.be.rejectedWith("isn't SDOGECollectibles");
      const boosts = (tierBoostBps) => bad({ boostManifest: { tierBoostBps } });
      await expect(boosts({ og: 1000, rare: 2000, epic: 3000, legendary: 5001 })).to.be.rejectedWith(
        'tier "legendary" (design 2, Space Doge) needs a boost of 0-5000 bps'
      );
      await expect(boosts({ og: 1000 })).to.be.rejectedWith('tier "epic" (design 1, SWAT Doge)');
      await expect(bad({ notifier: ethers.ZeroAddress })).to.be.rejectedWith("the zero address");
      await expect(bad({ notifier: "0x0000000000000000000000000000000000000100" })).to.be.rejectedWith("a precompile or system address");
      await expect(bad({ notifier: "0x000000000000000000000000000000000000ffff" })).to.be.rejectedWith("a precompile or system address");
      await expect(bad({ notifier: "not-an-address" })).to.be.rejectedWith("is not an address");
      expect(await nonceOf(f.deployer)).to.equal(nonce);
      // The notifier only needs to be usable: it never receives USDC.
      const { staking } = await bad({ notifier: await refuser.getAddress() });
      expect(readBatch("staking-notifier").transactions[0].data).to.equal(encode(staking, "setNotifier", [await refuser.getAddress()]));
    });

    it("treasuries and fee recipients: nothing that would lose or refuse native USDC", async function () {
      const f = await fixture();
      const refuser = await (await ethers.getContractFactory("RevertingReceiver")).deploy();
      await quiet(() => deployCollectibles.run({ ...f.base, treasury: f.treasury.address, baseUri: "ipfs://bafymeta/", fetchImpl: okFetch }));
      await quiet(() => deployStudio.run({ ...f.base, treasury: f.treasury.address, ...pinnedStudio }));
      const nonce = await nonceOf(f.deployer);
      const bad = [
        [ethers.ZeroAddress, "the zero address"],
        [DEAD, "the burn address"],
        ["0x0000000000000000000000000000000000000001", "a precompile or system address"],
        ["0x000000000000000000000000000000000000ffff", "a precompile or system address"],
        [USDC_SYSTEM, "Arc's USDC system token"],
        [await refuser.getAddress(), "refuses native USDC"], // reverts in receive()
        [f.base.sdoge, "refuses native USDC"], // a contract with no receive() at all
      ];
      for (const [address, reason] of bad) {
        await expect(
          quiet(() => deployCollectibles.run({ ...f.base, treasury: address, baseUri: "ipfs://bafymeta/", fetchImpl: okFetch, force: true }))
        ).to.be.rejectedWith(reason);
        await expect(quiet(() => deployStudio.run({ ...f.base, treasury: address, ...pinnedStudio, force: true }))).to.be.rejectedWith(reason);
        await expect(quiet(() => deployMarketplace.run({ ...f.base, feeRecipient: address }))).to.be.rejectedWith(reason);
      }
      expect(await nonceOf(f.deployer)).to.equal(nonce);
      // A contract with a payable receive() is fine: the Safe itself.
      await quiet(() => deployMarketplace.run({ ...f.base, feeRecipient: f.base.owner }));
    });

    it("the recorded dependencies, the package manifest and the pool share", async function () {
      const f = await fixture();
      const token = f.base.sdoge;
      const otherToken = await (await ethers.getContractFactory("MockERC20")).deploy("Stable Doge", "SDOGE");
      const wrongPool = await (await ethers.getContractFactory("SDOGEStaking")).deploy(
        await otherToken.getAddress(),
        ethers.ZeroAddress,
        await f.safe.getAddress()
      );
      const entry = (address) => ({ address, txHash: ethers.ZeroHash, block: 1, args: [] });
      const nonce = await nonceOf(f.deployer);
      const studio = (extra = {}) => quiet(() => deployStudio.run({ ...f.base, treasury: f.treasury.address, ...pinnedStudio, ...extra }));
      const market = () => quiet(() => deployMarketplace.run({ ...f.base, feeRecipient: f.treasury.address }));

      writeRecord({ chainId: 31337, contracts: { SDOGEStaking: entry(f.other.address) } });
      await expect(studio()).to.be.rejectedWith(`SDOGEStaking ${f.other.address} has no contract code`);
      writeRecord({ chainId: 31337, contracts: { SDOGEStaking: entry(token) } });
      await expect(studio()).to.be.rejectedWith("doesn't answer stakingToken()");
      writeRecord({ chainId: 31337, contracts: { SDOGEStaking: entry(await wrongPool.getAddress()) } });
      await expect(studio()).to.be.rejectedWith(`stakes ${await otherToken.getAddress()}, not SDOGE`);

      writeRecord({ chainId: 31337, contracts: { SDOGEStudio: entry(f.other.address), SDOGECollectibles: entry(token) } });
      await expect(market()).to.be.rejectedWith(`SDOGEStudio ${f.other.address} has no contract code`);
      writeRecord({ chainId: 31337, contracts: { SDOGEStudio: entry(token), SDOGECollectibles: entry(token) } });
      await expect(market()).to.be.rejectedWith("doesn't answer communityCollection()");

      writeRecord({ chainId: 31337, contracts: {} });
      const manifest = (change) => ({ manifest: { ...studioManifest, communityContractURI: CONTRACT_URI, ...change } });
      const pkg = (p) => manifest({ packages: [{ name: "X", mints: 1, priceUsdc: "5", ...p }] });
      await expect(studio(pkg({ mints: 100_001 }))).to.be.rejectedWith("at most 100000 mints");
      await expect(studio(pkg({ priceUsdc: "0.001" }))).to.be.rejectedWith("the USDC price must be 0.01-1,000,000");
      await expect(studio(pkg({ priceSdoge: "0.5" }))).to.be.rejectedWith("the SDOGE price must be 1-1,000,000,000");
      await expect(studio(manifest({ packages: Array(21).fill({ name: "X", mints: 1, priceUsdc: "5" }) }))).to.be.rejectedWith("more than 20 packages");
      await expect(studio(manifest({ poolShareBps: 10_001 }))).to.be.rejectedWith("poolShareBps must be 0-10000");
      expect(await nonceOf(f.deployer)).to.equal(nonce);
    });
  });

  describe("staking", function () {
    it("deploys with the Safe as owner, records it, and batches the owner settings", async function () {
      const f = await fixture();
      const { staking } = await quiet(() => deployStaking.run({ ...f.base, notifier: f.notifier.address }));
      const safe = await f.safe.getAddress();
      expect(await staking.owner()).to.equal(safe);
      expect(await staking.boostCollection()).to.equal(f.base.collection);
      const rec = readRecord();
      expect(rec.chainId).to.equal(31337);
      expect(rec.contracts.SDOGEStaking.address).to.equal(await staking.getAddress());
      expect(rec.contracts.SDOGEStaking.args).to.deep.equal([f.base.sdoge, f.base.collection, safe]);
      const { tierBoostBps } = readRepoJson("nft/staking-boosts.json");
      const expected = Object.fromEntries(designs.map((d) => [String(d.id), tierBoostBps[d.tier]]));
      expect(rec.contracts.SDOGEStaking.settings).to.deep.equal({ notifier: f.notifier.address, designBoosts: expected });
      const batch = readBatch("staking-setup");
      expect(batch.transactions.length).to.equal(1); // the notifier waits in its own batch
      expect(await staking.designBoostBps(2)).to.equal(0);
      await execBatch(f.safe, batch);
      expect(await staking.notifier()).to.equal(ethers.ZeroAddress);
      await execBatch(f.safe, readBatch("staking-notifier"));
      expect(await staking.notifier()).to.equal(f.notifier.address);
      for (const d of designs) expect(await staking.designBoostBps(d.id)).to.equal(tierBoostBps[d.tier]);
      expect(await staking.designBoostBps(2)).to.equal(5000); // Space Doge, legendary
    });

    it("ties staking to the recorded SDOGECollectibles", async function () {
      const f = await fixture();
      const { collectibles } = await quiet(() =>
        deployCollectibles.run({ ...f.base, treasury: f.treasury.address, baseUri: "ipfs://bafymeta/", fetchImpl: okFetch })
      );
      const { staking } = await quiet(() => deployStaking.run({ ...f.base, collection: undefined }));
      expect(await staking.boostCollection()).to.equal(await collectibles.getAddress());
    });

    it("tells the operator to seed the pool before any reward period or revenue", async function () {
      const f = await fixture();
      const { out } = await capture(() => deployStaking.run(f.base));
      const seed = out.indexOf("opens a seed stake");
      const notify = out.indexOf("notifyRewardAmount()");
      const route = out.indexOf("route revenue");
      expect(seed).to.be.above(-1);
      expect(notify).to.be.above(seed);
      expect(route).to.be.above(notify);
      expect(out).to.include("before any revenue is routed to staking and before any reward period starts");
      expect(out).to.include("stake(4, <amount>, 31536000, 30000)");
      expect(out).to.include("notifySdogeRewards(<amount>)");
      expect(out).to.include("lockBoosts()");
      expect(out).to.not.include("notifyUnallocated");
    });
  });

  describe("collectibles", function () {
    it("requires a real, pinned base URI whose metadata matches the roster", async function () {
      const f = await fixture();
      const d = (baseUri, fetchImpl = okFetch) =>
        quiet(() => deployCollectibles.run({ ...f.base, treasury: f.treasury.address, baseUri, fetchImpl }));
      await expect(d(undefined)).to.be.rejectedWith("Set COLLECTIBLES_BASE_URI");
      await expect(d("ipfs://bafymeta")).to.be.rejectedWith('must end in "/"');
      await expect(d("https://stabledoge1.example/nft/metadata/")).to.be.rejectedWith('contains ".example"');
      await expect(d("ipfs://REPLACE_ME/")).to.be.rejectedWith('contains "REPLACE_ME"');
      await expect(d("ipfs://bafymeta/{id}/")).to.be.rejectedWith('contains "{id}"');
      await expect(d("http://insecure/")).to.be.rejectedWith("must start with ipfs:// or https://");
      // The contract's own rule: printable ASCII, no spaces, at most 512 bytes.
      await expect(d("ipfs://bafy meta/")).to.be.rejectedWith("printable ASCII with no spaces");
      await expect(d("ipfs://bafymetä/")).to.be.rejectedWith("printable ASCII with no spaces");
      await expect(d("ipfs://bafy\tmeta/")).to.be.rejectedWith("printable ASCII with no spaces");
      await expect(d(`ipfs://${"a".repeat(505)}/`)).to.be.rejectedWith("at most 512");
      const placeholder = async () => ({ ok: true, json: async () => ({ name: "SWAT Doge", image: "ipfs://REPLACE_ME/swat-doge.jpg" }) });
      await expect(d("ipfs://bafymeta/", placeholder)).to.be.rejectedWith("has no real image yet");
      const wrongName = async () => ({ ok: true, json: async () => ({ name: "Astronaut Doge", image: "ipfs://x.png" }) });
      await expect(d("ipfs://bafymeta/", wrongName)).to.be.rejectedWith('expected "SWAT Doge"');
      const { collectibles } = await d(`ipfs://${"a".repeat(504)}/`); // exactly 512 bytes
      expect(await collectibles.uri.staticCall(1).catch(() => "none")).to.equal("none"); // no designs yet
    });

    it("creates the designs closed, checks them against the manifest, then opens them", async function () {
      const f = await fixture();
      const { collectibles } = await quiet(() =>
        deployCollectibles.run({ ...f.base, treasury: f.treasury.address, baseUri: "ipfs://bafymeta/", fetchImpl: okFetch })
      );
      const { result: create, out: createOut } = await capture(() => setupDesigns.run({ expectedChainId: LOCAL }));
      expect(create.batch.transactions.length).to.equal(12);
      for (const d of designs) expect(createOut).to.include(`design ${d.id} ${d.name}: reserved ${d.reserved} of ${d.maxSupply}`);
      expect(createOut).to.include("a design's reserve can never be raised once it's created");
      await expect(quiet(() => setupDesigns.run({ expectedChainId: LOCAL, open: true }))).to.be.rejectedWith(
        "aren't created yet"
      );
      await execBatch(f.safe, create);
      const d2 = await collectibles.designs(2);
      expect(d2.name).to.equal("Space Doge");
      expect(d2.priceWei).to.equal(ethers.parseEther(designs[1].priceUsdc));
      expect(d2.publicMintOpen).to.equal(false);

      expect(await quiet(() => setupDesigns.run({ expectedChainId: LOCAL }))).to.equal(null); // all match
      const { result: open, out: openOut } = await capture(() => setupDesigns.run({ expectedChainId: LOCAL, open: true }));
      expect(openOut).to.include("Execute this batch only after the site is live");
      expect(open.batch.meta.description).to.include("execute only once the site is live and the sale is announced");
      expect(open.batch.transactions.length).to.equal(12);
      await execBatch(f.safe, open);
      expect((await collectibles.designs(12)).publicMintOpen).to.equal(true);
    });

    it("stops on any on-chain design that differs from the manifest", async function () {
      const f = await fixture();
      const { collectibles } = await quiet(() =>
        deployCollectibles.run({ ...f.base, treasury: f.treasury.address, baseUri: "ipfs://bafymeta/", fetchImpl: okFetch })
      );
      const data = collectibles.interface.encodeFunctionData("createDesign", [1, "SWAT Doge", 300, ethers.parseEther("45"), 0]);
      await f.safe.exec(await collectibles.getAddress(), data);
      await expect(quiet(() => setupDesigns.run({ expectedChainId: LOCAL }))).to.be.rejectedWith(
        "design 1 (SWAT Doge) on-chain has price 45.0 USDC"
      );
    });

    it("locks every supply and the collection, then freezes the metadata, through the Safe", async function () {
      const f = await fixture();
      const { collectibles } = await quiet(() =>
        deployCollectibles.run({ ...f.base, treasury: f.treasury.address, baseUri: "ipfs://bafymeta/", fetchImpl: okFetch })
      );
      await expect(quiet(() => setupDesigns.run({ expectedChainId: LOCAL, lock: true }))).to.be.rejectedWith("aren't created yet");
      await execBatch(f.safe, await quiet(() => setupDesigns.run({ expectedChainId: LOCAL })));
      await expect(quiet(() => setupDesigns.run({ expectedChainId: LOCAL, open: true, lock: true }))).to.be.rejectedWith(
        "separate batches"
      );

      const { result: lock, out } = await capture(() => setupDesigns.run({ expectedChainId: LOCAL, lock: true }));
      expect(out).to.include("this batch is one-way");
      expect(path.basename(lock.file)).to.equal("hardhat-collectibles-lock.safe.json");
      const fns = lock.batch.transactions.map((tx) => collectibles.interface.parseTransaction({ data: tx.data }).name);
      expect(fns).to.deep.equal([...Array(12).fill("lockSupply"), "lockCollection", "freezeMetadata"]);
      await execBatch(f.safe, lock);
      expect(await collectibles.collectionLocked()).to.equal(true);
      expect(await collectibles.metadataFrozen()).to.equal(true);
      for (const d of designs) expect((await collectibles.designs(d.id)).supplyLocked).to.equal(true);
      expect(await quiet(() => setupDesigns.run({ expectedChainId: LOCAL, lock: true }))).to.equal(null);

      const exec = (fn, args) => f.safe.exec(collectibles.target, encode(collectibles, fn, args));
      await expect(exec("createDesign", [13, "Extra Doge", 10, ethers.parseEther("1"), 0])).to.be.revertedWith("collection is locked");
      await expect(exec("setURI", ["ipfs://elsewhere/"])).to.be.revertedWith("metadata is frozen");
      await expect(exec("increaseSupply", [1, 1000])).to.be.revertedWith("supply is locked");
      // Locked designs can still be opened for sale.
      const open = await quiet(() => setupDesigns.run({ expectedChainId: LOCAL, open: true }));
      expect(open.batch.transactions.length).to.equal(12);
    });
  });

  describe("studio and marketplace", function () {
    it("deploys the Studio with the manifest's packages and routes revenue to staking via the Safe", async function () {
      const f = await fixture();
      const { staking } = await quiet(() => deployStaking.run(f.base));
      const { studio } = await quiet(() => deployStudio.run({ ...f.base, treasury: f.treasury.address, ...pinnedStudio }));
      const p = await studio.getPackages();
      expect(p.map((x) => Number(x.mints))).to.deep.equal([1, 10, 100, 1000]);
      expect(p[0].priceWei).to.equal(ethers.parseEther("5"));
      expect(p[0].priceSdoge).to.equal(ethers.parseEther("1000000"));
      expect(p[3].priceWei).to.equal(ethers.parseEther("100"));
      expect(p[3].priceSdoge).to.equal(0);
      await execBatch(f.safe, readBatch("studio-setup"));
      expect(await studio.rewardsPool()).to.equal(await staking.getAddress());
      expect(await studio.poolShareBps()).to.equal(5000);
    });

    it("rejects bad package manifests", async function () {
      const f = await fixture();
      const bad = (packages) =>
        quiet(() =>
          deployStudio.run({ ...f.base, treasury: f.treasury.address, manifest: { packages, poolShareBps: 0 }, allowEmptyContractUri: true })
        );
      await expect(bad([])).to.be.rejectedWith("has no packages");
      await expect(bad([{ name: "X", mints: 1, priceUsdc: "5.0000001" }])).to.be.rejectedWith("at most 6 decimals");
      await expect(bad([{ name: "X", mints: 1, priceUsdc: null, priceSdoge: null }])).to.be.rejectedWith("has no price");
      await expect(bad([{ name: "X", mints: 0.5, priceUsdc: "5" }])).to.be.rejectedWith("mints must be a whole number");
    });

    it("requires a pinned Community Art contractURI, unless ALLOW_EMPTY_CONTRACT_URI", async function () {
      const f = await fixture();
      const d = (uri, extra = {}) =>
        quiet(() =>
          deployStudio.run({
            ...f.base,
            treasury: f.treasury.address,
            manifest: { ...studioManifest, communityContractURI: uri },
            fetchImpl: contractFetch,
            ...extra,
          })
        );
      const nonce = await nonceOf(f.deployer);
      await expect(d("")).to.be.rejectedWith("nft/studio.json has no communityContractURI");
      await expect(d(undefined)).to.be.rejectedWith("ALLOW_EMPTY_CONTRACT_URI=1");
      await expect(d("ipfs://bafy community.json")).to.be.rejectedWith("printable ASCII with no spaces");
      await expect(d("http://stabledoge.io/community.json")).to.be.rejectedWith("must start with ipfs:// or https://");
      await expect(d(`ipfs://${"a".repeat(506)}`)).to.be.rejectedWith("at most 512");
      await expect(d("ipfs://REPLACE_ME/community.json")).to.be.rejectedWith('contains "REPLACE_ME"');
      const missing = async () => ({ ok: false, status: 404 });
      await expect(d(CONTRACT_URI, { fetchImpl: missing })).to.be.rejectedWith(
        "Could not load https://ipfs.io/ipfs/bafycommunity/collection.json: HTTP 404"
      );
      const notMetadata = async () => ({ ok: true, json: async () => ({ image: "ipfs://x.png" }) });
      await expect(d(CONTRACT_URI, { fetchImpl: notMetadata })).to.be.rejectedWith('has no "name"');
      expect(await nonceOf(f.deployer)).to.equal(nonce);

      const { result, out } = await capture(() =>
        deployStudio.run({ ...f.base, treasury: f.treasury.address, allowEmptyContractUri: true })
      );
      expect(out).to.include("The Safe can set it later with setCommunityContractURI(uri)");
      const blank = await ethers.getContractAt("SDOGEStudioCollection", await result.studio.communityCollection());
      expect(await blank.contractURI()).to.equal("");

      const { studio } = await d(CONTRACT_URI, { force: true });
      const community = await ethers.getContractAt("SDOGEStudioCollection", await studio.communityCollection());
      expect(await community.contractURI()).to.equal(CONTRACT_URI);
    });

    it("deploys the marketplace against the recorded Studio and Collectibles", async function () {
      const f = await fixture();
      await expect(quiet(() => deployMarketplace.run({ ...f.base, feeRecipient: f.treasury.address }))).to.be.rejectedWith(
        "Deploy the Studio and the Collectibles first"
      );
      const { staking } = await quiet(() => deployStaking.run(f.base));
      const { studio } = await quiet(() => deployStudio.run({ ...f.base, treasury: f.treasury.address, ...pinnedStudio }));
      const { collectibles } = await quiet(() =>
        deployCollectibles.run({ ...f.base, treasury: f.treasury.address, baseUri: "ipfs://bafymeta/", fetchImpl: okFetch })
      );
      const { marketplace } = await quiet(() => deployMarketplace.run({ ...f.base, feeRecipient: f.treasury.address }));
      expect(await marketplace.studio()).to.equal(await studio.getAddress());
      expect(await marketplace.collectibles()).to.equal(await collectibles.getAddress());
      await execBatch(f.safe, readBatch("marketplace-setup"));
      expect(await marketplace.rewardsPool()).to.equal(await staking.getAddress());
    });
  });

  describe("verify-deployment", function () {
    it("passes a good deployment, before and after revenue is routed to staking", async function () {
      const f = await fixture();
      await deployAll(f);
      expect(await check(f)).to.deep.equal([]);
      await execBatch(f.safe, readBatch("studio-setup"));
      await execBatch(f.safe, readBatch("marketplace-setup"));
      const { result: problems, out } = await capture(() =>
        verify({ file: recordFile(), provider: ethers.provider, sdoge: f.base.sdoge, expectedOwner: f.base.owner })
      );
      expect(problems).to.deep.equal([]);
      expect(out).to.match(/SDOGEStudio\s+rewardsPool\s+ok/);
      expect(out).to.match(/SDOGENFTMarketplace\s+rewardsPool\s+ok/);
      expect(out).to.match(/SDOGECollectibles\s+uri\s+ok\s+ipfs:\/\/bafymeta\/1\.json/);
      expect(out).to.include("(Safe, 2-of-2)");
      expect(out).to.include("All checks passed.");
    });

    it("flags rewards started before the owner's seed stake", async function () {
      const f = await fixture();
      const d = await deployAll(f);
      await execBatch(f.safe, readBatch("studio-setup"));
      await execBatch(f.safe, readBatch("marketplace-setup"));
      expect(await check(f)).to.deep.equal([]);
      await f.safe.exec(d.staking.target, encode(d.staking, "notifyRewardAmount", []), { value: ethers.parseEther("7") });
      expect(await check(f)).to.deep.equal([
        "SDOGEStaking seed stake: rewards have started, but the owner has no open stake: the seed stake must come first",
      ]);
      // the Safe's seed stake: then it's fine
      const amount = ethers.parseEther("1000");
      await f.sdoge.mint(f.safe.target, amount);
      await f.safe.exec(f.sdoge.target, encode(f.sdoge, "approve", [d.staking.target, amount]));
      await f.safe.exec(d.staking.target, encode(d.staking, "stake", [4, amount, 365 * 86400, 30000]));
      expect(await check(f)).to.deep.equal([]);
    });

    it("flags a contract wired to the wrong thing", async function () {
      const f = await fixture();
      const d = await deployAll(f);
      await execBatch(f.safe, readBatch("studio-setup"));
      await execBatch(f.safe, readBatch("marketplace-setup"));
      const strayPool = await (await ethers.getContractFactory("SDOGEStaking")).deploy(f.base.sdoge, ethers.ZeroAddress, f.base.owner);
      await f.safe.exec(d.studio.target, encode(d.studio, "setRewardsPool", [await strayPool.getAddress(), 5000]));
      await f.safe.exec(d.marketplace.target, encode(d.marketplace, "setFeeRecipient", [f.other.address]));
      await f.safe.exec(d.marketplace.target, encode(d.marketplace, "setFeeBps", [300]));
      await f.safe.exec(d.staking.target, encode(d.staking, "setNotifier", [ethers.ZeroAddress]));
      await f.safe.exec(d.staking.target, encode(d.staking, "setDesignBoosts", [[2], [100]]));
      await f.safe.exec(d.collectibles.target, encode(d.collectibles, "setTreasury", [f.other.address]));
      const problems = await check(f);
      expect(problems.map((p) => p.split(":")[0])).to.have.members([
        "SDOGEStudio rewardsPool",
        "SDOGENFTMarketplace feeRecipient",
        "SDOGENFTMarketplace feeBps",
        "SDOGEStaking notifier",
        "SDOGEStaking designBoostBps",
        "SDOGECollectibles treasury",
      ]);
      expect(problems).to.include(
        "SDOGEStaking designBoostBps: design 2 is 100 on-chain, the record says 5000 (the staking-setup Safe batch sets it)"
      );
      expect(problems.join("\n")).to.include(`${await strayPool.getAddress()} on-chain, but the recorded SDOGEStaking is`);
      expect(problems).to.include(
        `SDOGEStaking notifier: ${ethers.ZeroAddress} on-chain, but the record says ${f.notifier.address} (the staking-notifier Safe batch sets it, after the seed stake and the first rewards)`
      );
      // A fee the Safe changed on purpose passes once it's expected.
      expect((await check(f, { feeBps: 300 })).join("\n")).to.not.include("feeBps");
    });

    it("flags missing code, a deploy transaction that doesn't match, and a record from a fork", async function () {
      const f = await fixture();
      await deployAll(f);
      const good = readRecord();
      const rec = JSON.parse(JSON.stringify(good));
      rec.contracts.SDOGEStudio.address = f.other.address; // nothing deployed there
      rec.contracts.SDOGECollectibles.block += 1;
      // Another contract's deployment, in its block.
      rec.contracts.SDOGEStaking.txHash = good.contracts.SDOGENFTMarketplace.txHash;
      rec.contracts.SDOGEStaking.block = good.contracts.SDOGENFTMarketplace.block;
      rec.contracts.SDOGENFTMarketplace.txHash = ethers.hexlify(ethers.randomBytes(32)); // mined on a fork only
      writeRecord(rec);
      const text = (await check(f)).join("\n");
      expect(text).to.include(`SDOGEStudio code: ${f.other.address} has no contract code`);
      expect(text).to.match(/SDOGECollectibles deploy tx: 0x[0-9a-f]{64}: it's in block \d+, the record says \d+/);
      expect(text).to.include(
        `SDOGEStaking deploy tx: ${good.contracts.SDOGENFTMarketplace.txHash}: ` +
          `it created ${good.contracts.SDOGENFTMarketplace.address}, not ${good.contracts.SDOGEStaking.address}`
      );
      expect(text).to.include(`SDOGENFTMarketplace deploy tx: ${rec.contracts.SDOGENFTMarketplace.txHash} isn't on this chain`);
      expect(text).to.include(`SDOGENFTMarketplace studio: ${good.contracts.SDOGEStudio.address} on-chain, but the recorded SDOGEStudio is ${f.other.address}`);

      writeRecord({ ...good, chainId: 5042 });
      expect((await check(f)).join("\n")).to.include("record chain id: the RPC is chain 31337, the record is for chain 5042");
    });

    it("flags an owner that isn't the expected Safe with 2+ signers, or a pending ownership transfer", async function () {
      const f = await fixture();
      const d = await deployAll(f);
      const solo = await f.soloSafe.getAddress();
      const notTheSafe = await check(f, { expectedOwner: solo });
      expect(notTheSafe).to.have.length(4);
      expect(notTheSafe.join("\n")).to.include(`not the Safe ${solo} (SAFE_ADDRESS)`);
      await f.safe.exec(d.staking.target, encode(d.staking, "transferOwnership", [f.other.address]));
      expect(await check(f)).to.deep.equal([`SDOGEStaking pendingOwner: an ownership transfer to ${f.other.address} is waiting to be accepted`]);

      const g = await fixture();
      await quiet(() => deployStaking.run({ ...g.base, owner: g.treasury.address, allowEoa: true }));
      // A plain-wallet owner sends the setup batch itself.
      for (const tx of readBatch("staking-setup").transactions) await g.treasury.sendTransaction({ to: tx.to, data: tx.data });
      expect(await check(g)).to.deep.equal([`SDOGEStaking owner: ${g.treasury.address} (a plain wallet: a single key, not a Safe)`]);
      expect(await check(g, { allowEoa: true })).to.deep.equal([]);
    });

    it("reads the RPC one request at a time, never batched, and retries -32005", async function () {
      const seen = [];
      let inFlight = 0;
      let maxInFlight = 0;
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          maxInFlight = Math.max(maxInFlight, ++inFlight);
          const msg = JSON.parse(body);
          seen.push(msg);
          const reply = Array.isArray(msg)
            ? msg.map((m) => ({ jsonrpc: "2.0", id: m.id, error: { code: -32005, message: "batch too large" } }))
            : seen.length === 1
              ? { jsonrpc: "2.0", id: msg.id, error: { code: -32005, message: "request limit reached" } }
              : { jsonrpc: "2.0", id: msg.id, result: "0x6000" };
          setTimeout(() => {
            inFlight--;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(reply));
          }, 10);
        });
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const rpc = arcProvider(`http://127.0.0.1:${server.address().port}`, { gapMs: 5 });
      try {
        const addresses = [1, 2, 3].map((i) => ethers.zeroPadValue(ethers.toBeHex(0x10000 + i), 20));
        expect(await Promise.all(addresses.map((a) => rpc.getCode(a)))).to.deep.equal(["0x6000", "0x6000", "0x6000"]);
        expect((await rpc.getNetwork()).chainId).to.equal(5042n);
        expect(seen.some(Array.isArray)).to.equal(false);
        expect(maxInFlight).to.equal(1);
        expect(seen.map((m) => m.method)).to.deep.equal(Array(4).fill("eth_getCode")); // one retried, no eth_chainId
      } finally {
        rpc.destroy();
        server.close();
      }
    });
  });

  describe("sync-frontend", function () {
    const tempArcJs = () => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sdoge-arcjs-")), "arc.js");
      fs.copyFileSync(path.join(__dirname, "..", "..", "assets", "js", "arc.js"), file);
      return file;
    };

    it("writes arc.js only once the deployment verifies on-chain", async function () {
      const f = await fixture();
      const d = await deployAll(f);
      const arcJs = tempArcJs();
      const before = fs.readFileSync(arcJs, "utf8");
      const opts = { expectedChainId: LOCAL, provider: ethers.provider, sdoge: f.base.sdoge, log: () => {} };
      await f.safe.exec(d.marketplace.target, encode(d.marketplace, "setFeeRecipient", [f.other.address]));
      await expect(quiet(() => sync(recordFile(), arcJs, opts))).to.be.rejectedWith(
        "hardhat.json failed verification (1 problem(s), listed above), so arc.js was not changed."
      );
      expect(fs.readFileSync(arcJs, "utf8")).to.equal(before);

      await f.safe.exec(d.marketplace.target, encode(d.marketplace, "setFeeRecipient", [f.treasury.address]));
      expect(await quiet(() => sync(recordFile(), arcJs, opts))).to.have.length(4);
      const after = fs.readFileSync(arcJs, "utf8");
      for (const [key, contract] of Object.entries({ staking: d.staking, collectibles: d.collectibles, studio: d.studio, marketplace: d.marketplace })) {
        expect(after).to.include(`  ${key}: '${await contract.getAddress()}',`);
      }
    });

    it("takes an injected verifier, refuses another chain's record, and SKIP_VERIFY skips the check", async function () {
      const f = await fixture();
      const { staking } = await quiet(() => deployStaking.run(f.base));
      const arcJs = tempArcJs();
      const before = fs.readFileSync(arcJs, "utf8");
      let asked;
      const failing = async (opts) => {
        asked = opts;
        return ["SDOGEStaking deploy tx: 0xabc isn't on this chain"];
      };
      await expect(quiet(() => sync(recordFile(), arcJs, { expectedChainId: LOCAL, verifier: failing }))).to.be.rejectedWith(
        "failed verification"
      );
      expect(asked.record.contracts.SDOGEStaking.address).to.equal(await staking.getAddress());
      await expect(quiet(() => sync(recordFile(), arcJs, { verifier: failing }))).to.be.rejectedWith("not Arc (5042)");
      expect(fs.readFileSync(arcJs, "utf8")).to.equal(before);

      const changed = await quiet(() => sync(recordFile(), arcJs, { expectedChainId: LOCAL, skipVerify: true }));
      expect(changed).to.deep.equal([`staking = ${await staking.getAddress()}`]);
    });
  });
});
