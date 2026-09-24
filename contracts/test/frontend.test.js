// The site's real scripts (assets/js) against the real contracts on the in-process chain.
const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { loadPage } = require("./helpers/fe-harness");
const { deployStudio, newCollection } = require("./helpers/studio");

const E = (n) => ethers.parseEther(String(n));
const ROOT = path.join(__dirname, "..", "..");
const { designs } = JSON.parse(fs.readFileSync(path.join(ROOT, "nft", "designs.json"), "utf8"));
const studioManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "nft", "studio.json"), "utf8"));
const hex = (n) => ethers.toQuantity(n);

async function deployAll({ designNames } = {}) {
  const [owner, alice, bob, carol, treasury] = await ethers.getSigners();
  const sdoge = await (await ethers.getContractFactory("MockERC20")).deploy("Stable Doge", "SDOGE");
  const staking = await (await ethers.getContractFactory("SDOGEStaking")).deploy(await sdoge.getAddress(), owner.address);
  const collectibles = await (await ethers.getContractFactory("SDOGECollectibles")).deploy(owner.address, "ipfs://meta/", treasury.address);
  for (const d of designs) {
    const name = designNames?.[d.id] ?? d.name;
    await collectibles.createDesign(d.id, name, d.maxSupply, E(d.priceUsdc), d.reserved);
    await collectibles.setPublicMint(d.id, true);
  }
  const { studio, community } = await deployStudio(owner, sdoge, treasury);
  const marketplace = await (await ethers.getContractFactory("SDOGENFTMarketplace")).deploy(
    owner.address,
    await studio.getAddress(),
    await collectibles.getAddress(),
    treasury.address
  );
  for (const u of [alice, bob, carol]) await sdoge.mint(u.address, E("10000000"));
  const contracts = {
    token: await sdoge.getAddress(),
    staking: await staking.getAddress(),
    collectibles: await collectibles.getAddress(),
    studio: await studio.getAddress(),
    marketplace: await marketplace.getAddress(),
  };
  return { owner, alice, bob, carol, treasury, sdoge, staking, collectibles, studio, community, marketplace, contracts };
}

const page = (f, files, who, extra = {}) =>
  loadPage({ files, contracts: f.contracts, hreProvider: network.provider, account: who.address, ...extra });
const NFT_PAGE = ["arc.js", "wallet.js", "nft.js", "marketplace.js"];
const STUDIO_PAGE = ["arc.js", "wallet.js", "studio.js"];
const STAKING_PAGE = ["arc.js", "staking.js"];

describe("front end (assets/js)", function () {
  describe("manifests", function () {
    it("nft.js's ROSTER matches nft/designs.json and the metadata files", async function () {
      const [a] = await ethers.getSigners();
      const p = await loadPage({ files: ["arc.js", "wallet.js", "nft.js"], hreProvider: network.provider, account: a.address });
      const roster = JSON.parse(p.run("JSON.stringify(ROSTER)"));
      expect(roster.length).to.equal(designs.length);
      roster.forEach((r, i) => {
        const d = designs[i];
        expect([r.designId, r.name, r.file, r.video, r.tier, String(r.priceUsdc), r.maxSupply]).to.deep.equal([
          d.id, d.name, d.file, d.video, d.tier, d.priceUsdc, d.maxSupply,
        ]);
        const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "nft", "metadata", `${d.id}.json`), "utf8"));
        expect(meta.name).to.equal(r.name);
      });
    });

    it("studio.js's preview packages match nft/studio.json", async function () {
      const [a] = await ethers.getSigners();
      const p = await loadPage({ files: STUDIO_PAGE, hreProvider: network.provider, account: a.address });
      const preview = JSON.parse(p.run("JSON.stringify(PREVIEW_PACKAGES, (k, v) => typeof v === 'bigint' ? v.toString() : v)"));
      expect(preview.map((x) => [x.mints, x.priceWei, x.priceSdoge])).to.deep.equal(
        studioManifest.packages.map((m) => [
          String(m.mints),
          E(m.priceUsdc).toString(),
          m.priceSdoge == null ? "0" : E(m.priceSdoge).toString(),
        ])
      );
    });
  });

  describe("arc.js", function () {
    it("only reloads for a network or account change once a signer is in use", async function () {
      const f = await deployAll();
      const p = await page(f, NFT_PAGE, f.alice);
      p.wallet.emit("chainChanged", "0x1");
      p.wallet.emit("accountsChanged", [f.alice.address]);
      expect(p.reloads()).to.equal(0); // connecting itself mustn't reload mid-click
      expect(await p.run("connectWallet()")).to.equal(true);
      p.wallet.emit("accountsChanged", [f.alice.address.toLowerCase()]);
      expect(p.reloads()).to.equal(0);
      p.wallet.emit("accountsChanged", [f.bob.address]);
      expect(p.reloads()).to.equal(1);
      p.wallet.emit("chainChanged", "0x1");
      expect(p.reloads()).to.equal(2);
    });
  });

  describe("nft.js: the 12 designs", function () {
    it("preview mode sends nothing", async function () {
      const [a] = await ethers.getSigners();
      const p = await loadPage({ files: ["arc.js", "wallet.js", "nft.js"], hreProvider: network.provider, account: a.address });
      await p.run("mint(1)");
      expect(p.alerts[0]).to.match(/Not live yet/);
      expect(p.sent.length).to.equal(0);
    });

    it("live: reads each design and mints at exactly the on-chain price, pinned to the chain", async function () {
      const f = await deployAll();
      const p = await page(f, NFT_PAGE, f.alice);
      await p.run("loadLiveDesignData()");
      expect(p.run("designState[1].status")).to.equal("open");
      expect(p.el("nftGrid").innerHTML).to.include("$40 USDC");
      await p.run("mint(1)");
      expect(await f.collectibles.balanceOf(f.alice.address, 1)).to.equal(1);
      const tx = p.sent.at(-1);
      expect(tx.value).to.equal(hex(E("40")));
      expect(tx.chainId).to.equal(hex((await ethers.provider.getNetwork()).chainId));
    });

    it("a design whose on-chain name doesn't match the art can't be minted", async function () {
      const f = await deployAll({ designNames: { 2: "Astronaut Doge" } });
      const p = await page(f, NFT_PAGE, f.alice);
      await p.run("loadLiveDesignData()");
      expect(p.run("designState[2].status")).to.equal("unavailable");
      await p.run("mint(2)");
      expect(p.alerts.at(-1)).to.match(/can't be minted right now/);
      expect(p.sent.length).to.equal(0);
    });

    it("a price change after the page loaded stops the mint until it's seen", async function () {
      const f = await deployAll();
      const p = await page(f, NFT_PAGE, f.alice);
      await p.run("loadLiveDesignData()");
      await f.collectibles.setPrice(1, E("45"));
      await p.run("mint(1)");
      expect(p.alerts.at(-1)).to.match(/price just changed to 45 USDC/);
      expect(p.sent.length).to.equal(0);
      await p.run("mint(1)");
      expect(p.sent.at(-1).value).to.equal(hex(E("45")));
    });
  });

  describe("marketplace.js", function () {
    async function listed() {
      const f = await deployAll();
      await f.collectibles.connect(f.alice).mint(1, 3, { value: E("120") });
      const seller = await page(f, NFT_PAGE, f.alice);
      await seller.run("loadListings()");
      seller.el("marketCollection").value = "collectibles";
      seller.el("marketTokenId").value = "1";
      seller.el("marketAmount").value = "2";
      seller.el("marketPrice").value = "50";
      await seller.run("listNft()");
      return { f, seller };
    }

    it("lists through escrow after a confirm, and shows the listing with its design name", async function () {
      const { f, seller } = await listed();
      expect(seller.confirms[0]).to.match(/List 2 x SWAT Doge \(Collectibles design #1\) for 50 USDC each/);
      expect(await f.collectibles.balanceOf(await f.marketplace.getAddress(), 1)).to.equal(2);
      const buyer = await page(f, NFT_PAGE, f.bob);
      await buyer.run("loadListings()");
      const html = buyer.el("marketListings").innerHTML;
      expect(html).to.include("SWAT Doge (Collectibles design #1)");
      expect(html).to.include("50 USDC each");
      expect(buyer.el("marketStatus").textContent).to.match(/Fee: 2% of each sale goes to the treasury/);
    });

    it("buys at the listed price, and stops if the price changed since it was shown", async function () {
      const { f } = await listed();
      const buyer = await page(f, NFT_PAGE, f.bob);
      await buyer.run("loadListings()");
      await buyer.run("buyListing('1')");
      expect(await f.collectibles.balanceOf(f.bob.address, 1)).to.equal(1);
      await f.marketplace.connect(f.alice).updatePrice(1, E("60"));
      await buyer.run("buyListing('1')");
      expect(buyer.alerts.at(-1)).to.match(/price just changed to 60 USDC/);
      expect(await f.collectibles.balanceOf(f.bob.address, 1)).to.equal(1);
    });

    it("rejects prices below 0.01 USDC or with more than 6 decimals", async function () {
      const f = await deployAll();
      await f.collectibles.connect(f.alice).mint(1, 1, { value: E("40") });
      const p = await page(f, NFT_PAGE, f.alice);
      await p.run("loadListings()");
      p.el("marketCollection").value = "collectibles";
      p.el("marketTokenId").value = "1";
      for (const price of ["0.001", "1.1234567", "-1", "1e3"]) {
        p.el("marketPrice").value = price;
        await p.run("listNft()");
        expect(p.alerts.at(-1)).to.match(/at least 0.01 USDC, with up to 6 decimals/);
      }
      expect(p.sent.length).to.equal(0);
    });

    it("sellers see their listings under Mine and can cancel them", async function () {
      const { f, seller } = await listed();
      seller.run("marketActiveFilter = 'mine'");
      await seller.run("loadListings()");
      expect(seller.el("marketListings").innerHTML).to.include("data-market-cancel=\"1\"");
      await seller.run("cancelMarketListing('1')");
      expect(await f.collectibles.balanceOf(f.alice.address, 1)).to.equal(3);
    });

    it("creator collections are labelled unverified and their names escaped", async function () {
      const f = await deployAll();
      const art = await newCollection(f.studio, f.carol, { name: "<img src=x onerror=alert(1)>", symbol: "XSS" });
      await f.studio.grantCredits(f.carol.address, 1);
      await art.connect(f.carol).mintBatch(f.carol.address, 1);
      await art.connect(f.carol).approve(await f.marketplace.getAddress(), 1);
      await f.marketplace.connect(f.carol).listERC721(await art.getAddress(), 1, E("5"));
      const p = await page(f, NFT_PAGE, f.bob);
      await p.run("loadListings()");
      const html = p.el("marketListings").innerHTML;
      expect(html).to.include("&lt;img src=x onerror=alert(1)&gt; #1");
      expect(html).to.not.include("<img src=x");
      expect(html).to.include("Unverified creator collection");
      expect(html).to.include("creator royalty up to 5%");
      await f.studio.setVerified(await art.getAddress(), true);
      const p2 = await page(f, NFT_PAGE, f.bob);
      await p2.run("loadListings()");
      expect(p2.el("marketListings").innerHTML).to.include(">Verified<");
    });

    it("refuses to run against a marketplace bound to other contracts", async function () {
      const f = await deployAll();
      const other = await (await ethers.getContractFactory("SDOGECollectibles")).deploy(f.owner.address, "ipfs://x/", f.treasury.address);
      const p = await loadPage({
        files: NFT_PAGE,
        contracts: { ...f.contracts, collectibles: await other.getAddress() },
        hreProvider: network.provider,
        account: f.bob.address,
      });
      await p.run("loadListings()");
      expect(p.el("marketListings").innerHTML).to.include("Marketplace unavailable");
      expect(p.el("marketListBtn").disabled).to.equal(true);
    });
  });

  describe("studio.js", function () {
    it("preview mode shows the launch packages and sends nothing", async function () {
      const [a] = await ethers.getSigners();
      const p = await loadPage({ files: STUDIO_PAGE, hreProvider: network.provider, account: a.address });
      await p.ready();
      expect(p.el("studioStatus").textContent).to.equal("Not live yet · preview");
      const html = p.el("packageGrid").innerHTML;
      expect(html).to.include("1,000 mints");
      expect(html).to.include("0.1 USDC per mint");
      expect(html).to.include("or burn 1,000,000 SDOGE");
      await p.run("buyPackage(0, 'usdc')");
      expect(p.sent.length).to.equal(0);
    });

    it("buys a package with USDC at exactly its price", async function () {
      const f = await deployAll();
      const p = await page(f, STUDIO_PAGE, f.alice);
      await p.ready();
      await p.run("buyPackage(3, 'usdc')");
      expect(await f.studio.credits(f.alice.address)).to.equal(1000);
      expect(p.sent.at(-1).value).to.equal(hex(E("100")));
    });

    it("stops if the package changed since it was shown", async function () {
      const f = await deployAll();
      const p = await page(f, STUDIO_PAGE, f.alice);
      await p.ready();
      await f.studio.updatePackage(3, 500, E("100"), 0);
      await p.run("buyPackage(3, 'usdc')");
      expect(p.alerts.at(-1)).to.match(/package just changed/);
      expect(p.sent.length).to.equal(0);
    });

    it("burns SDOGE for credits with an exact approval, after a confirm", async function () {
      const f = await deployAll();
      const p = await page(f, STUDIO_PAGE, f.alice);
      await p.ready();
      await p.run("buyPackage(0, 'sdoge')");
      expect(p.confirms.at(-1)).to.match(/Burn 1,000,000 SDOGE for 1 mint credit/);
      expect(await f.studio.credits(f.alice.address)).to.equal(1);
      expect(await f.sdoge.balanceOf("0x000000000000000000000000000000000000dEaD")).to.equal(E("1000000"));
      expect(await f.sdoge.allowance(f.alice.address, await f.studio.getAddress())).to.equal(0);
    });

    it("mints a 1-of-1 with its metadata stored on-chain", async function () {
      const f = await deployAll();
      await f.studio.grantCredits(f.alice.address, 1);
      const p = await page(f, STUDIO_PAGE, f.alice);
      await p.ready();
      p.el("cmName").value = "My Doge";
      p.el("cmDescription").value = "Much art — wow";
      p.el("cmImage").value = "ipfs://bafyimage/doge.png";
      await p.run("mintCommunityArt()");
      expect(await f.community.ownerOf(1)).to.equal(f.alice.address);
      const uri = await f.community.tokenURI(1);
      expect(uri.startsWith("data:application/json;base64,")).to.equal(true);
      const meta = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));
      expect(meta).to.deep.equal({ name: "My Doge", description: "Much art — wow", image: "ipfs://bafyimage/doge.png" });
      expect(p.el("cmResult").innerHTML).to.include("Community Art #1");
    });

    it("won't mint without a credit, a proper image link, or metadata that fits", async function () {
      const f = await deployAll();
      const p = await page(f, STUDIO_PAGE, f.alice);
      await p.ready();
      p.el("cmName").value = "My Doge";
      p.el("cmImage").value = "ipfs://bafyimage/doge.png";
      await p.run("mintCommunityArt()");
      expect(p.alerts.at(-1)).to.match(/need a mint credit/);
      await f.studio.grantCredits(f.alice.address, 1);
      p.el("cmImage").value = "javascript:alert(1)";
      await p.run("mintCommunityArt()");
      expect(p.alerts.at(-1)).to.match(/image link/);
      p.el("cmImage").value = "ipfs://bafyimage/doge.png";
      p.el("cmDescription").value = "x".repeat(400);
      await p.run("mintCommunityArt()");
      expect(p.alerts.at(-1)).to.match(/too long to store on-chain/);
      expect(p.sent.length).to.equal(0);
    });

    it("creates a collection, mints into it with credits, and runs a public drop", async function () {
      const f = await deployAll();
      await f.studio.connect(f.alice).buyCredits(1, 10, f.alice.address, { value: E("20") });
      const p = await page(f, STUDIO_PAGE, f.alice);
      await p.ready();
      p.el("ccName").value = "Doge Club";
      p.el("ccSymbol").value = "DCLUB";
      p.el("ccMaxSupply").value = "100";
      p.el("ccRoyalty").value = "5";
      await p.run("createMyCollection()");
      const [addr] = await f.studio.collectionsOf(f.alice.address);
      const club = await ethers.getContractAt("SDOGEStudioCollection", addr);
      expect(await club.name()).to.equal("Doge Club");
      expect(await club.maxSupply()).to.equal(100);
      const [, royalty] = await club.royaltyInfo(1, 10000);
      expect(royalty).to.equal(500);

      const card = (values) => ({ querySelector: (sel) => ({ value: values[sel.match(/data-f="(\w+)"/)[1]] ?? "" }) });
      p.ctx.__card = card({ to: f.alice.address, qty: "3" });
      await p.run(`collectionAction('${addr}', 'mintBatch', __card, { dataset: {} })`);
      expect(await club.balanceOf(f.alice.address)).to.equal(3);
      p.ctx.__card = card({ base: "ipfs://bafyclub/", suffix: ".json" });
      await p.run(`collectionAction('${addr}', 'setBaseURI', __card, { dataset: {} })`);
      p.ctx.__card = card({ price: "2", perWallet: "5", start: "", end: "" });
      await p.run(`collectionAction('${addr}', 'setDrop', __card, { dataset: {} })`);
      await p.run(`collectionAction('${addr}', 'toggleDrop', __card, { dataset: {} })`);
      expect((await club.drop()).open).to.equal(true);

      const collector = await page(f, STUDIO_PAGE, f.bob, { search: `?drop=${addr}` });
      await collector.ready();
      expect(collector.el("dropTitle").textContent).to.equal("Doge Club (DCLUB)");
      expect(collector.el("dropInfo").textContent).to.match(/^2 USDC each · 3 \/ 100 minted · 5 per wallet/);
      expect(collector.el("dropBadge").innerHTML).to.include("Unverified creator collection");
      collector.el("dropQty").value = "2";
      await collector.run("mintFromDrop()");
      expect(await club.balanceOf(f.bob.address)).to.equal(2);
      expect(collector.sent.at(-1).value).to.equal(hex(E("4")));
      expect(await f.studio.credits(f.alice.address)).to.equal(5); // 10 - 3 - 2
    });

    it("a drop shows paused when the creator is out of credits, and refuses non-Studio links", async function () {
      const f = await deployAll();
      const club = await newCollection(f.studio, f.alice, { name: "Empty Club", symbol: "EMPTY" });
      await club.connect(f.alice).setBaseURI("ipfs://bafyclub/", "");
      await club.connect(f.alice).setDropOpen(true);
      const p = await page(f, STUDIO_PAGE, f.bob, { search: `?drop=${await club.getAddress()}` });
      await p.ready();
      expect(p.el("dropInfo").textContent).to.include("Paused: the creator is out of mint credits.");
      expect(p.el("dropMintBtn").disabled).to.equal(true);
      const fake = await page(f, STUDIO_PAGE, f.bob, { search: `?drop=${f.contracts.collectibles}` });
      await fake.ready();
      expect(fake.el("dropTitle").textContent).to.equal("Not a SDOGE Studio collection");
      expect(fake.el("dropMintBtn").disabled).to.equal(true);
    });
  });

  describe("staking.js", function () {
    it("stakes on the terms it shows, with an exact approval, pinned to the chain", async function () {
      const f = await deployAll();
      const p = await page(f, STAKING_PAGE, f.alice);
      await p.ready();
      await p.run("loadTierDataFromChain()");
      expect(await p.run("connectWallet()")).to.equal(true);
      p.el("stakeAmount").value = "1000";
      await p.run("doStake()");
      const [id] = await f.staking.getStakeIds(f.alice.address);
      const s = await f.staking.getStake(id);
      expect(s.amount).to.equal(E("1000"));
      expect(await f.sdoge.allowance(f.alice.address, await f.staking.getAddress())).to.equal(0);
      expect(p.sent.every((tx) => tx.chainId === hex(31337))).to.equal(true);
    });

    it("refuses to stake if the tier's terms changed after the page loaded", async function () {
      const f = await deployAll();
      const p = await page(f, STAKING_PAGE, f.alice);
      await p.ready();
      await p.run("loadTierDataFromChain()");
      await p.run("connectWallet()");
      await f.staking.setTierDuration(0, 14 * 86400);
      p.el("stakeAmount").value = "1000";
      await p.run("doStake()");
      expect(p.alerts.at(-1)).to.match(/terms just changed/);
      expect((await f.staking.getStakeIds(f.alice.address)).length).to.equal(0);
    });
  });
});
