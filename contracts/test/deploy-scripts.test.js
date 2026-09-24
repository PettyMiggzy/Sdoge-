// Runs the real deploy scripts against the in-process chain, with a MockSafe as the owner.
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("hardhat");

const deployStaking = require("../scripts/deploy-staking");
const deployCollectibles = require("../scripts/deploy-collectibles");
const setupDesigns = require("../scripts/setup-designs");
const deployStudio = require("../scripts/deploy-studio");
const deployMarketplace = require("../scripts/deploy-marketplace");

const LOCAL = 31337n;
const { designs } = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "nft", "designs.json"), "utf8"));

// Serves the 12 metadata files the way a pinned folder would.
const okFetch = async (url) => {
  const id = Number(url.match(/(\d+)\.json$/)[1]);
  return { ok: true, json: async () => ({ name: designs[id - 1].name, image: `ipfs://bafyimages/${id}.png` }) };
};

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

async function fixture() {
  process.env.DEPLOYMENTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sdoge-deploy-"));
  const [deployer, s1, s2, treasury] = await ethers.getSigners();
  const Safe = await ethers.getContractFactory("MockSafe");
  const safe = await Safe.deploy(2, [s1.address, s2.address]);
  const soloSafe = await Safe.deploy(1, [s1.address]);
  const sdoge = await (await ethers.getContractFactory("MockERC20")).deploy("Stable Doge", "SDOGE");
  const base = { expectedChainId: LOCAL, owner: await safe.getAddress(), sdoge: await sdoge.getAddress() };
  return { deployer, treasury, safe, soloSafe, sdoge, base };
}

// Executes a written Safe batch through the MockSafe.
async function execBatch(safe, result) {
  for (const tx of result.batch.transactions) await safe.exec(tx.to, tx.data);
}

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
      await quiet(() => deployStaking.run({ ...f.base, owner: solo, allowLowThreshold: true }));
    });

    it("refuse a token that isn't SDOGE", async function () {
      const f = await fixture();
      const other = await (await ethers.getContractFactory("MockERC20")).deploy("Other", "OTHER");
      const otherAddress = await other.getAddress();
      await expect(quiet(() => deployStaking.run({ ...f.base, sdoge: otherAddress }))).to.be.rejectedWith(
        "not the 18-decimal SDOGE token"
      );
    });
  });

  describe("staking", function () {
    it("deploys with the Safe as owner, records it, and batches the owner settings", async function () {
      const f = await fixture();
      const { staking } = await quiet(() =>
        deployStaking.run({ ...f.base, tokenSink: f.treasury.address, notifier: f.treasury.address })
      );
      expect(await staking.owner()).to.equal(await f.safe.getAddress());
      const rec = JSON.parse(fs.readFileSync(path.join(process.env.DEPLOYMENTS_DIR, "hardhat.json"), "utf8"));
      expect(rec.chainId).to.equal(31337);
      expect(rec.contracts.SDOGEStaking.address).to.equal(await staking.getAddress());
      const batch = JSON.parse(fs.readFileSync(path.join(process.env.DEPLOYMENTS_DIR, "hardhat-staking-setup.safe.json"), "utf8"));
      expect(batch.transactions.length).to.equal(2);
      for (const tx of batch.transactions) await f.safe.exec(tx.to, tx.data);
      expect(await staking.tokenSink()).to.equal(f.treasury.address);
      expect(await staking.notifier()).to.equal(f.treasury.address);
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
      const placeholder = async () => ({ ok: true, json: async () => ({ name: "SWAT Doge", image: "ipfs://REPLACE_ME/swat-doge.jpg" }) });
      await expect(d("ipfs://bafymeta/", placeholder)).to.be.rejectedWith("has no real image yet");
      const wrongName = async () => ({ ok: true, json: async () => ({ name: "Astronaut Doge", image: "ipfs://x.png" }) });
      await expect(d("ipfs://bafymeta/", wrongName)).to.be.rejectedWith('expected "SWAT Doge"');
      const { collectibles } = await d("ipfs://bafymeta/");
      expect(await collectibles.uri.staticCall(1).catch(() => "none")).to.equal("none"); // no designs yet
    });

    it("creates the designs closed, checks them against the manifest, then opens them", async function () {
      const f = await fixture();
      const { collectibles } = await quiet(() =>
        deployCollectibles.run({ ...f.base, treasury: f.treasury.address, baseUri: "ipfs://bafymeta/", fetchImpl: okFetch })
      );
      const create = await quiet(() => setupDesigns.run({ expectedChainId: LOCAL }));
      expect(create.batch.transactions.length).to.equal(12);
      await expect(quiet(() => setupDesigns.run({ expectedChainId: LOCAL, open: true }))).to.be.rejectedWith(
        "aren't created yet"
      );
      await execBatch(f.safe, create);
      const d2 = await collectibles.designs(2);
      expect(d2.name).to.equal("Space Doge");
      expect(d2.priceWei).to.equal(ethers.parseEther(designs[1].priceUsdc));
      expect(d2.publicMintOpen).to.equal(false);

      expect(await quiet(() => setupDesigns.run({ expectedChainId: LOCAL }))).to.equal(null); // all match
      const open = await quiet(() => setupDesigns.run({ expectedChainId: LOCAL, open: true }));
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
  });

  describe("studio and marketplace", function () {
    it("deploys the Studio with the manifest's packages and routes revenue to staking via the Safe", async function () {
      const f = await fixture();
      const { staking } = await quiet(() => deployStaking.run(f.base));
      const { studio } = await quiet(() => deployStudio.run({ ...f.base, treasury: f.treasury.address }));
      const p = await studio.getPackages();
      expect(p.map((x) => Number(x.mints))).to.deep.equal([1, 10, 100, 1000]);
      expect(p[0].priceWei).to.equal(ethers.parseEther("5"));
      expect(p[0].priceSdoge).to.equal(ethers.parseEther("1000000"));
      expect(p[3].priceWei).to.equal(ethers.parseEther("100"));
      expect(p[3].priceSdoge).to.equal(0);
      const batch = JSON.parse(fs.readFileSync(path.join(process.env.DEPLOYMENTS_DIR, "hardhat-studio-setup.safe.json"), "utf8"));
      for (const tx of batch.transactions) await f.safe.exec(tx.to, tx.data);
      expect(await studio.rewardsPool()).to.equal(await staking.getAddress());
      expect(await studio.poolShareBps()).to.equal(5000);
    });

    it("rejects bad package manifests", async function () {
      const f = await fixture();
      const bad = (packages) =>
        quiet(() => deployStudio.run({ ...f.base, treasury: f.treasury.address, manifest: { packages, poolShareBps: 0 } }));
      await expect(bad([])).to.be.rejectedWith("has no packages");
      await expect(bad([{ name: "X", mints: 1, priceUsdc: "5.0000001" }])).to.be.rejectedWith("at most 6 decimals");
      await expect(bad([{ name: "X", mints: 1, priceUsdc: null, priceSdoge: null }])).to.be.rejectedWith("has no price");
      await expect(bad([{ name: "X", mints: 0.5, priceUsdc: "5" }])).to.be.rejectedWith("mints must be a whole number");
    });

    it("deploys the marketplace against the recorded Studio and Collectibles", async function () {
      const f = await fixture();
      await expect(quiet(() => deployMarketplace.run({ ...f.base, feeRecipient: f.treasury.address }))).to.be.rejectedWith(
        "Deploy the Studio and the Collectibles first"
      );
      const { staking } = await quiet(() => deployStaking.run(f.base));
      const { studio } = await quiet(() => deployStudio.run({ ...f.base, treasury: f.treasury.address }));
      const { collectibles } = await quiet(() =>
        deployCollectibles.run({ ...f.base, treasury: f.treasury.address, baseUri: "ipfs://bafymeta/", fetchImpl: okFetch })
      );
      const { marketplace } = await quiet(() => deployMarketplace.run({ ...f.base, feeRecipient: f.treasury.address }));
      expect(await marketplace.studio()).to.equal(await studio.getAddress());
      expect(await marketplace.collectibles()).to.equal(await collectibles.getAddress());
      const batch = JSON.parse(fs.readFileSync(path.join(process.env.DEPLOYMENTS_DIR, "hardhat-marketplace-setup.safe.json"), "utf8"));
      for (const tx of batch.transactions) await f.safe.exec(tx.to, tx.data);
      expect(await marketplace.rewardsPool()).to.equal(await staking.getAddress());
    });
  });
});
