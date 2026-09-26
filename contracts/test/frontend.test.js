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
  const collectibles = await (await ethers.getContractFactory("SDOGECollectibles")).deploy(owner.address, "ipfs://meta/", treasury.address);
  for (const d of designs) {
    const name = designNames?.[d.id] ?? d.name;
    await collectibles.createDesign(d.id, name, d.maxSupply, E(d.priceUsdc), d.reserved);
    await collectibles.setPublicMint(d.id, true);
  }
  const staking = await (await ethers.getContractFactory("SDOGEStaking")).deploy(
    await sdoge.getAddress(),
    await collectibles.getAddress(),
    owner.address
  );
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
// A collection card on the Studio page, as far as collectionAction reads it.
const cardStub = (values) => ({ querySelector: (sel) => ({ value: values[sel.match(/data-f="(\w+)"/)[1]] ?? "" }) });
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

  describe("pages", function () {
    // Copy that's only true before launch must be marked, so the page's script swaps it out once
    // the contract is live (or is text the script replaces itself).
    it("preview-only copy is marked data-preview-copy or data-js-managed", function () {
      const PREVIEW = /not deployed|preview UI|placeholders|not live|working preview/i;
      const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
      let checked = 0;
      for (const file of ["nft.html", "staking.html", "studio.html"]) {
        const html = fs.readFileSync(path.join(ROOT, file), "utf8");
        const open = []; // elements enclosing the current text
        let inScript = false;
        const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
        for (let m; (m = re.exec(html)); ) {
          if (m[0].startsWith("<!--")) continue;
          if (m[2]) {
            const tag = m[2].toLowerCase();
            if (tag === "script" || tag === "style") inScript = !m[1];
            if (m[1]) {
              const i = open.map((e) => e.tag).lastIndexOf(tag);
              if (i >= 0) open.length = i;
            } else if (!VOID.has(tag) && !m[3].trim().endsWith("/")) {
              open.push({ tag, attrs: m[3] });
            }
          } else if (!inScript && PREVIEW.test(m[4])) {
            checked += 1;
            const marked = open.some((e) => /data-preview-copy|data-js-managed/.test(e.attrs));
            expect(marked, `${file}: "${m[4].trim().slice(0, 70)}"`).to.equal(true);
          }
        }
      }
      expect(checked).to.be.greaterThan(4);
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

    it("preview mode shows each design's placeholder staking boost from nft/staking-boosts.json", async function () {
      const [a] = await ethers.getSigners();
      const p = await loadPage({ files: ["arc.js", "wallet.js", "nft.js"], hreProvider: network.provider, account: a.address });
      const { tierBoostBps } = JSON.parse(fs.readFileSync(path.join(ROOT, "nft", "staking-boosts.json"), "utf8"));
      expect(JSON.parse(p.run("JSON.stringify(PREVIEW_BOOST_BPS)"))).to.deep.equal(tierBoostBps);
      p.run("renderGrid()");
      const html = p.el("nftGrid").innerHTML;
      expect(html).to.include("Token #2");
      expect(html).to.include(`+${tierBoostBps.legendary / 100}% staking boost`); // Space Doge
    });

    it("live: shows the boost the staking contract gives each design, and none it doesn't give", async function () {
      const f = await deployAll();
      await f.staking.setDesignBoosts([2, 6], [5000, 1250]);
      const p = await page(f, NFT_PAGE, f.alice);
      await p.run("loadDesignBoosts()");
      expect(p.run("designBoost[2]")).to.equal(5000);
      expect(p.run("designBoost[1]")).to.equal(0);
      const html = p.el("nftGrid").innerHTML;
      expect(html).to.include("+50% staking boost");
      expect(html).to.include("+12.5% staking boost");
      expect(html.match(/staking boost/g)).to.have.length(2); // no placeholder for the rest
    });

    it("a price change after the page loaded stops the mint until it's seen", async function () {
      const f = await deployAll();
      const p = await page(f, NFT_PAGE, f.alice);
      await p.run("loadLiveDesignData()");
      await f.collectibles.setPublicMint(1, false); // a price only changes while the sale is closed
      await f.collectibles.setPrice(1, E("45"));
      await f.collectibles.setPublicMint(1, true);
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
      await f.marketplace.connect(f.alice).updatePrice(1, E("60"), 1000, 1000);
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
      await f.marketplace.connect(f.carol).listERC721(await art.getAddress(), 1, E("5"), 1000, 1000);
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

    it("every listing stays reachable: Mine and Community read the indexes, All pages with Load more", async function () {
      const f = await deployAll();
      const junk = await newCollection(f.studio, f.carol, { name: "Junk", symbol: "JUNK", royaltyBps: 0 });
      await f.studio.grantCredits(f.carol.address, 55);
      await junk.connect(f.carol).mintBatch(f.carol.address, 55);
      await junk.connect(f.carol).setApprovalForAll(await f.marketplace.getAddress(), true);
      for (let id = 1; id <= 55; id++) {
        await f.marketplace.connect(f.carol).listERC721(await junk.getAddress(), id, E("1000000"), 1000, 1000);
      }
      await f.studio.grantCredits(f.alice.address, 1);
      await f.studio.connect(f.alice).mintCommunity("ipfs://bafy/alice.json");
      await f.community.connect(f.alice).approve(await f.marketplace.getAddress(), 1);
      await f.marketplace.connect(f.alice).listERC721(await f.community.getAddress(), 1, E("5"), 1000, 1000); // #56

      const alice = await page(f, NFT_PAGE, f.alice);
      await alice.run("connectWallet()");
      alice.run("marketActiveFilter = 'mine'");
      await alice.run("loadListings()");
      expect(alice.el("marketListings").innerHTML).to.include('data-market-cancel="56"');

      const bob = await page(f, NFT_PAGE, f.bob);
      await bob.run("loadListings()");
      expect(bob.el("marketListings").innerHTML).to.not.include("Community Art #1");
      expect(bob.el("marketListings").innerHTML).to.include("data-market-more");
      await bob.run("loadMoreListings()");
      expect(bob.el("marketListings").innerHTML).to.include("Community Art #1");
      bob.run("marketActiveFilter = 'community'");
      await bob.run("loadListings()");
      expect(bob.el("marketListings").innerHTML).to.include("Community Art #1");
      expect(bob.el("marketListings").innerHTML).to.not.include("data-market-more");
    });

    it("one collection's listings on their own page (?collection=0x...)", async function () {
      const f = await deployAll();
      const art = await newCollection(f.studio, f.carol, { name: "Carol Art", symbol: "CART" });
      await f.studio.grantCredits(f.carol.address, 2);
      await art.connect(f.carol).mintBatch(f.carol.address, 2);
      await art.connect(f.carol).setApprovalForAll(await f.marketplace.getAddress(), true);
      await f.marketplace.connect(f.carol).listERC721(await art.getAddress(), 1, E("5"), 1000, 1000);
      await f.collectibles.connect(f.alice).mint(1, 1, { value: E("40") });
      await f.collectibles.connect(f.alice).setApprovalForAll(await f.marketplace.getAddress(), true);
      await f.marketplace.connect(f.alice).listERC1155(await f.collectibles.getAddress(), 1, 1, E("50"), 1000);
      const p = await page(f, NFT_PAGE, f.bob, { search: `?collection=${await art.getAddress()}` });
      await p.ready();
      const html = p.el("marketListings").innerHTML;
      expect(html).to.include("Listings from Carol Art");
      expect(html).to.include("Carol Art #1");
      expect(html).to.not.include("SWAT Doge");
    });

    it("the listing confirm quotes the live fee and royalty with the net, and the listing can't take more", async function () {
      const f = await deployAll();
      const art = await newCollection(f.studio, f.carol, { name: "Carol Art", symbol: "CART", royaltyBps: 500 });
      await f.studio.grantCredits(f.carol.address, 1);
      await art.connect(f.carol).mintBatch(f.alice.address, 1);
      const p = await page(f, NFT_PAGE, f.alice);
      await p.run("loadListings()");
      await f.marketplace.setFeeBps(300); // raised after the page loaded
      p.el("marketCollection").value = "creator";
      p.el("marketCollectionAddress").value = await art.getAddress();
      p.el("marketTokenId").value = "1";
      p.el("marketPrice").value = "100";
      await p.run("listNft()");
      expect(p.confirms.at(-1)).to.match(/Marketplace fee 3% \+ creator royalty 5%: you receive 92 USDC/);
      const l = await f.marketplace.getListing(1);
      expect([l.feeBps, l.royaltyBps]).to.deep.equal([300n, 500n]);
    });

    it("Change price asks first, shows the net, and warns on a big drop", async function () {
      const { f, seller } = await listed(); // 2 x SWAT Doge at 50 USDC each
      await seller.run("connectWallet()");
      seller.answers.prompt.push("20");
      seller.answers.confirm.push(false);
      await seller.run("repriceListing('1')");
      expect(seller.confirms.at(-1)).to.match(/from 50 to 20 USDC each/);
      expect(seller.confirms.at(-1)).to.match(/you receive 19.6 USDC each/);
      expect(seller.confirms.at(-1)).to.match(/Careful: that's 60% below the current price/);
      expect((await f.marketplace.getListing(1)).pricePerUnit).to.equal(E("50"));
      seller.answers.prompt.push("45");
      await seller.run("repriceListing('1')");
      expect((await f.marketplace.getListing(1)).pricePerUnit).to.equal(E("45"));
    });

    it("proceeds a wallet can't receive go to an address it picks", async function () {
      const f = await deployAll();
      const refuser = await (await ethers.getContractFactory("RevertingReceiver")).deploy();
      const rAddr = await refuser.getAddress();
      const art = await newCollection(f.studio, f.carol, { name: "Carol Art", symbol: "CART", royaltyBps: 0 });
      await f.studio.grantCredits(f.carol.address, 1);
      await art.connect(f.carol).airdrop([rAddr]);
      const seller = await ethers.getImpersonatedSigner(rAddr);
      await network.provider.send("hardhat_setBalance", [rAddr, ethers.toQuantity(E("10"))]);
      await art.connect(seller).approve(await f.marketplace.getAddress(), 1);
      await f.marketplace.connect(seller).listERC721(await art.getAddress(), 1, E("10"), 1000, 1000);
      await f.marketplace.connect(f.bob).buy(1, 1, { value: E("10") });
      expect(await f.marketplace.proceeds(rAddr)).to.equal(E("9.8"));

      const p = await loadPage({ files: NFT_PAGE, contracts: f.contracts, hreProvider: network.provider, account: rAddr });
      await p.run("connectWallet()");
      await p.run("loadListings()");
      expect(p.el("marketListings").innerHTML).to.include("Sale proceeds waiting for you: 9.8 USDC");
      const before = await ethers.provider.getBalance(f.carol.address);
      p.answers.prompt.push(f.carol.address);
      await p.run("withdrawMarketProceeds()");
      expect((await ethers.provider.getBalance(f.carol.address)) - before).to.equal(E("9.8"));
      expect(await f.marketplace.proceeds(rAddr)).to.equal(0);
    });

    it("says where the fee goes, checked against this site's staking contract", async function () {
      const f = await deployAll();
      await f.marketplace.setRewardsPool(await f.staking.getAddress());
      const p = await page(f, NFT_PAGE, f.bob);
      await p.run("loadListings()");
      expect(p.el("marketStatus").textContent).to.match(/goes to the \$SDOGE staking reward pool/);
      await f.marketplace.setRewardsPool(await f.studio.getAddress());
      const p2 = await page(f, NFT_PAGE, f.bob);
      await p2.run("loadListings()");
      expect(p2.el("marketStatus").textContent).to.match(/which is not this site's staking contract/);
    });

    it("loads a dozen creator listings through Arc's public-RPC rate limit", async function () {
      this.timeout(120000);
      const f = await deployAll();
      for (let i = 0; i < 12; i++) {
        const art = await newCollection(f.studio, f.carol, { name: `Club ${i}`, symbol: `C${i}`, royaltyBps: 0 });
        await f.studio.grantCredits(f.carol.address, 1);
        await art.connect(f.carol).mintBatch(f.carol.address, 1);
        await art.connect(f.carol).approve(await f.marketplace.getAddress(), 1);
        await f.marketplace.connect(f.carol).listERC721(await art.getAddress(), 1, E("5"), 1000, 1000);
      }
      const p = await page(f, NFT_PAGE, f.bob, { rpc: "limited" });
      try {
        await p.run("loadListings()");
        const html = p.el("marketListings").innerHTML;
        for (let i = 0; i < 12; i++) expect(html).to.include(`Club ${i} #1`);
        expect(p.rpcStats.batchSizes.every((n) => n === 1)).to.equal(true); // never batched
        expect(p.rpcStats.limitedInBatch).to.equal(0);
      } finally {
        await p.close();
      }
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

    async function managedClub(f, { drop } = {}) {
      await f.studio.connect(f.alice).buyCredits(1, 10, f.alice.address, { value: E("20") });
      const club = await newCollection(f.studio, f.alice, { name: "Doge Club", symbol: "DCLUB" });
      await club.connect(f.alice).setBaseURI("ipfs://bafyclub/", ".json");
      if (drop) await club.connect(f.alice).setDrop(...drop);
      const p = await page(f, STUDIO_PAGE, f.alice);
      await p.ready();
      await p.run("connectWallet()");
      await p.run("loadMyCollections()");
      return { club, addr: await club.getAddress(), p };
    }
    const act = (p, addr, action, values = {}) => {
      p.ctx.__card = cardStub(values);
      return p.run(`collectionAction('${addr}', '${action}', __card, { dataset: {} })`);
    };

    it("the drop form shows the saved schedule and price, and a one-field edit keeps them", async function () {
      const f = await deployAll();
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      const start = now + 3 * 86400;
      const end = start + 86400;
      const { club, addr, p } = await managedClub(f, { drop: [E("1500"), 2, start, end] });
      const html = p.el("myCollections").innerHTML;
      const startValue = p.run(`inputFromUnix(${start})`);
      const endValue = p.run(`inputFromUnix(${end})`);
      expect(html).to.include(`data-f="price" value="1500"`);
      expect(html).to.include(`value="${startValue}"`);
      expect(html).to.include(`value="${endValue}"`);
      expect(html).to.match(/Drop closed: 1,500 USDC each, 2 per wallet, starts .+, ends /);
      await act(p, addr, "setDrop", { price: "1500", perWallet: "1", start: startValue, end: endValue });
      const d = await club.drop();
      expect([d.priceWei, d.maxPerWallet, d.start, d.end]).to.deep.equal([E("1500"), 1n, BigInt(start), BigInt(end)]);
      expect(p.confirms.length).to.equal(0); // nothing removed, nothing to confirm
    });

    it("clearing a drop's schedule asks first", async function () {
      const f = await deployAll();
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      const { club, addr, p } = await managedClub(f, { drop: [E("5"), 0, now + 86400, now + 2 * 86400] });
      p.answers.confirm.push(false);
      await act(p, addr, "setDrop", { price: "5", perWallet: "0", start: "", end: "" });
      expect(p.confirms.at(-1)).to.match(/removes the drop's start time.*removes the drop's end time/);
      expect((await club.drop()).start).to.equal(BigInt(now + 86400));
    });

    it("warns when a drop is cheaper than a credit, and a free drop needs a cap", async function () {
      const f = await deployAll();
      const { club, addr, p } = await managedClub(f);
      await act(p, addr, "setDrop", { price: "0", perWallet: "1" });
      expect(p.alerts.at(-1)).to.match(/A free drop needs a supply cap/);
      p.answers.confirm.push(false);
      await act(p, addr, "setDrop", { price: "0.05", perWallet: "1" });
      expect(p.confirms.at(-1)).to.match(/below what a credit costs you \(0.1 USDC at best\)/);
      expect(await club.dropConfigured()).to.equal(false);
    });

    it("opening a drop confirms the SAVED terms and refuses unsaved edits", async function () {
      const f = await deployAll();
      const { club, addr, p } = await managedClub(f);
      await act(p, addr, "toggleDrop", { price: "2", perWallet: "5" });
      expect(p.alerts.at(-1)).to.match(/Save the drop terms first/);
      await act(p, addr, "setDrop", { price: "2", perWallet: "5" });
      await act(p, addr, "toggleDrop", { price: "25", perWallet: "2" }); // typed, not saved
      expect(p.alerts.at(-1)).to.match(/aren't the saved ones/);
      expect((await club.drop()).open).to.equal(false);
      await act(p, addr, "toggleDrop", { price: "2", perWallet: "5" });
      expect(p.confirms.at(-1)).to.match(/Open the drop with the saved terms\?\n\n2 USDC each, 5 per wallet/);
      expect(p.confirms.at(-1)).to.match(/No supply cap/);
      expect((await club.drop()).open).to.equal(true);
    });

    it("mints and airdrops refuse SDOGE contracts and ask before other contracts", async function () {
      const f = await deployAll();
      const { club, addr, p } = await managedClub(f);
      await act(p, addr, "airdrop", { airdrop: `${f.bob.address}\n${f.contracts.staking}` });
      expect(p.alerts.at(-1)).to.match(/is one of the SDOGE contracts/);
      const other = await (await ethers.getContractFactory("RevertingReceiver")).deploy();
      p.answers.confirm.push(false);
      await act(p, addr, "mintBatch", { to: await other.getAddress(), qty: "1" });
      expect(p.confirms.at(-1)).to.match(/This address is a contract/);
      expect(await club.totalMinted()).to.equal(0);
      await act(p, addr, "airdrop", { airdrop: `${f.bob.address}\n${f.carol.address}` });
      expect(await club.totalMinted()).to.equal(2);
    });

    it("mintWithURIs takes at most 50 URIs and 6,000 characters per transaction", async function () {
      const f = await deployAll();
      const { club, addr, p } = await managedClub(f);
      await act(p, addr, "mintWithURIs", { to: f.alice.address, uris: Array(51).fill("ipfs://x").join("\n") });
      expect(p.alerts.at(-1)).to.match(/Enter 1-50 URIs/);
      const long = "ipfs://" + "a".repeat(200);
      await act(p, addr, "mintWithURIs", { to: f.alice.address, uris: Array(30).fill(long).join("\n") });
      expect(p.alerts.at(-1)).to.match(/add up to 6,210 characters/);
      await act(p, addr, "mintWithURIs", { to: f.alice.address, uris: "ipfs://a.json\nipfs://b.json" });
      expect(await club.totalMinted()).to.equal(2);
    });

    it("freezing needs a base URI and shows where token 1 points", async function () {
      const f = await deployAll();
      await f.studio.connect(f.alice).buyCredits(1, 10, f.alice.address, { value: E("20") });
      const bare = await newCollection(f.studio, f.alice, { name: "Bare", symbol: "BARE" });
      const p = await page(f, STUDIO_PAGE, f.alice);
      await p.ready();
      await p.run("connectWallet()");
      await act(p, await bare.getAddress(), "freeze");
      expect(p.alerts.at(-1)).to.match(/Save a base URI first/);
      await bare.connect(f.alice).setBaseURI("ipfs://bafybare/", ".json");
      await act(p, await bare.getAddress(), "freeze");
      expect(p.confirms.at(-1)).to.match(/Token 1 points at ipfs:\/\/bafybare\/1.json/);
      expect(await bare.metadataFrozen()).to.equal(true);
    });

    it("a collection handed over to you can be managed here", async function () {
      const f = await deployAll();
      const club = await newCollection(f.studio, f.alice, { name: "Handed Over", symbol: "HAND" });
      await club.connect(f.alice).transferOwnership(f.bob.address);
      await club.connect(f.bob).acceptOwnership();
      const p = await page(f, STUDIO_PAGE, f.bob);
      await p.ready();
      await p.run("connectWallet()");
      await p.run("loadMyCollections()");
      expect(p.el("myCollections").innerHTML).to.include("No collections yet");
      p.el("manageAddress").value = await club.getAddress();
      await p.run("manageCollection()");
      expect(p.el("myCollections").innerHTML).to.include("Handed Over");
      expect(p.el("myCollections").innerHTML).to.include('data-act="setDrop"');
      const alice = await page(f, STUDIO_PAGE, f.alice);
      await alice.ready();
      await alice.run("connectWallet()");
      await alice.run("loadMyCollections()");
      expect(alice.el("myCollections").innerHTML).to.include("You no longer own this collection");
    });

    it("a creator's collections all load through Arc's public-RPC rate limit", async function () {
      this.timeout(120000);
      const f = await deployAll();
      for (const [name, symbol] of [["One", "ONE"], ["Two", "TWO"], ["Three", "THREE"]]) {
        await newCollection(f.studio, f.alice, { name, symbol });
      }
      const p = await page(f, STUDIO_PAGE, f.alice, { rpc: "limited" });
      try {
        await p.ready();
        await p.run("connectWallet()");
        await p.run("loadMyCollections()");
        const html = p.el("myCollections").innerHTML;
        for (const name of ["One", "Two", "Three"]) expect(html).to.include(`${name} <span class="studio-note">`);
        expect(p.rpcStats.batchSizes.every((n) => n === 1)).to.equal(true);
      } finally {
        await p.close();
      }
    });

    it("shows the live share of credit sales that goes to stakers", async function () {
      const f = await deployAll();
      await f.studio.setRewardsPool(await f.staking.getAddress(), 5000);
      const p = await page(f, STUDIO_PAGE, f.alice);
      await p.ready();
      expect(p.el("studioShare").textContent).to.match(/^50% of every USDC credit sale is set aside for the \$SDOGE staking reward pool/);
    });

    it("the drop page shows the owner, where sales go, and what the owner can still change", async function () {
      const f = await deployAll();
      const { addr } = await managedClub(f, { drop: [E("2"), 0, 0, 0] });
      const p = await page(f, STUDIO_PAGE, f.bob, { search: `?drop=${addr}` });
      await p.ready();
      const badge = p.el("dropBadge").innerHTML;
      expect(badge).to.include(`owner <a href="${"http"}`);
      expect(badge).to.include("sales go to the owner");
      expect(badge).to.include("no supply cap: the owner can mint more at any time");
      expect(badge).to.include("metadata not frozen: the owner can still change it");
    });

    it("a drop shows paused when the creator is out of credits, and refuses non-Studio links", async function () {
      const f = await deployAll();
      const club = await newCollection(f.studio, f.alice, { name: "Empty Club", symbol: "EMPTY" });
      await club.connect(f.alice).setBaseURI("ipfs://bafyclub/", "");
      await club.connect(f.alice).setDrop(E("1"), 0, 0, 0);
      await club.connect(f.alice).setDropOpen(true);
      const p = await page(f, STUDIO_PAGE, f.bob, { search: `?drop=${await club.getAddress()}` });
      await p.ready();
      expect(p.el("dropInfo").textContent).to.include("Stopped for now: the creator is out of mint credits.");
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

    // A wallet whose own RPC for Arc is failing: every read ethers would send it errors out.
    const flakyWallet = (wallet, sendError) => ({
      async request({ method, params }) {
        if (method === "eth_sendTransaction" && sendError) throw sendError;
        if (["eth_requestAccounts", "eth_accounts", "eth_chainId", "eth_sendTransaction", "wallet_switchEthereumChain"].includes(method)) {
          return wallet.request({ method, params });
        }
        const err = new Error("Internal JSON-RPC error.");
        err.code = -32603;
        err.data = { code: -32005, message: "rate limit exceeded" };
        throw err;
      },
      on() {},
      removeListener() {},
    });

    it("stakes even when the wallet's own RPC is failing: the wallet only signs and sends", async function () {
      const f = await deployAll();
      const p = await page(f, STAKING_PAGE, f.alice);
      p.ctx.ethereum = flakyWallet(p.wallet);
      await p.ready();
      await p.run("loadTierDataFromChain()");
      expect(await p.run("connectWallet()")).to.equal(true);
      p.el("stakeAmount").value = "1000";
      await p.run("doStake()");
      expect(p.alerts).to.deep.equal([]);
      const [id] = await f.staking.getStakeIds(f.alice.address);
      expect((await f.staking.getStake(id)).amount).to.equal(E("1000"));
    });

    it("a wallet error it can't classify shows what the wallet said, not ethers' label", async function () {
      const f = await deployAll();
      const p = await page(f, STAKING_PAGE, f.alice);
      const refusal = new Error("Internal JSON-RPC error.");
      refusal.code = -32603;
      refusal.data = { code: -32000, message: "the wallet's node refused this transaction" };
      p.ctx.ethereum = flakyWallet(p.wallet, refusal);
      await p.ready();
      await p.run("loadTierDataFromChain()");
      expect(await p.run("connectWallet()")).to.equal(true);
      p.el("stakeAmount").value = "1000";
      await p.run("doStake()");
      expect(p.alerts.at(-1)).to.equal("Stake failed: the wallet's node refused this transaction");
      expect(p.run("arcErrorText({ code: 'UNKNOWN_ERROR', shortMessage: 'could not coalesce error', error: { message: 'rate limit exceeded' } })"))
        .to.equal("rate limit exceeded. Arc's connection was busy: wait a few seconds and try again");
    });

    it("refuses to stake on terms other than the contract's (a stale or wrong page)", async function () {
      const f = await deployAll();
      const p = await page(f, STAKING_PAGE, f.alice);
      await p.ready();
      await p.run("loadTierDataFromChain()");
      await p.run("connectWallet()");
      p.run("tierData[0] = { tier: 0, duration: 14n * 86400n, multiplierBps: 10000n }");
      p.el("stakeAmount").value = "1000";
      await p.run("doStake()");
      expect(p.alerts.at(-1)).to.match(/terms just changed/);
      expect((await f.staking.getStakeIds(f.alice.address)).length).to.equal(0);
    });

    it("connecting before the first chain read finishes still enables Stake", async function () {
      const f = await deployAll();
      const p = await page(f, STAKING_PAGE, f.alice);
      const loading = p.ready(); // starts the first read; connect without waiting for it
      expect(await p.run("connectWallet()")).to.equal(true);
      await loading;
      expect(p.el("connectOrStakeBtn").textContent).to.equal("Stake");
      expect(p.el("connectOrStakeBtn").disabled).to.equal(false);
    });

    // Space Doge (design 2) boosts stakes by +50%.
    async function nftStake(f) {
      await f.staking.setDesignBoosts([2], [5000]);
      await f.collectibles.connect(f.alice).mint(2, 1, { value: E("50") });
      const p = await page(f, STAKING_PAGE, f.alice);
      await p.ready();
      expect(await p.run("connectWallet()")).to.equal(true);
      expect(p.el("nftSelect").innerHTML).to.include("Space Doge (+50%)");
      p.el("nftSelect").value = "2";
      p.el("stakeAmount").value = "1000";
      await p.run("doStake()");
      return p;
    }

    it("stakes with an NFT boost in one NFT transfer: exact SDOGE approval, no blanket NFT approval", async function () {
      const f = await deployAll();
      const p = await nftStake(f);
      const [id] = await f.staking.getStakeIds(f.alice.address);
      const s = await f.staking.getStake(id);
      expect([s.amount, s.boostBps, s.holdsNft, s.nftId]).to.deep.equal([E("1000"), 5000n, true, 2n]);
      expect(s.weighted).to.equal(E("1500"));
      expect(await f.collectibles.balanceOf(await f.staking.getAddress(), 2)).to.equal(1);
      expect(await f.sdoge.allowance(f.alice.address, await f.staking.getAddress())).to.equal(0);
      const blanket = f.collectibles.interface.getFunction("setApprovalForAll").selector;
      expect(p.sent.some((tx) => String(tx.data).startsWith(blanket))).to.equal(false);
      expect(p.sent.every((tx) => tx.chainId === hex(31337))).to.equal(true);
      expect(p.el("myStakesList").innerHTML).to.include("Space Doge +50%");
      expect(p.el("overviewStaked").textContent).to.equal("1,000 SDOGE");
    });

    it("unstaking early says what stays with the stakers, and gives the NFT back", async function () {
      const f = await deployAll();
      const p = await nftStake(f);
      await p.run("exitStake(1n)");
      const asked = p.confirms.at(-1);
      expect(asked).to.include("Leaving now costs 150 SDOGE");
      expect(asked).to.include("stays in the pool for the stakers who stay");
      expect(asked).to.include("You would get back 850 SDOGE and your NFT");
      expect((await f.staking.getStake(1)).closed).to.equal(true);
      expect(await f.collectibles.balanceOf(f.alice.address, 2)).to.equal(1);
    });

    it("unstakes to up to 4 wallets: exact shares, and the NFT comes back to the staker", async function () {
      const f = await deployAll();
      const p = await nftStake(f); // 1,000 SDOGE for 7 days with Space Doge
      await network.provider.send("evm_increaseTime", [7 * 86400]);
      await network.provider.send("evm_mine");
      await new Promise((r) => setTimeout(r, 300)); // ethers answers repeated reads from a 250 ms cache
      const [dave, erin] = (await ethers.getSigners()).slice(5, 7);
      const before = await Promise.all([f.bob, f.carol, dave].map((w) => f.sdoge.balanceOf(w.address)));
      await p.run("openSplit(1n)");
      p.run(`splitState.rows = [{ addr: "${f.bob.address}", pct: "50" }, { addr: "${f.carol.address}", pct: "33.33" }, { addr: "${dave.address}", pct: "16.67" }]`);
      await p.run("submitSplit()");
      const asked = p.confirms.at(-1);
      expect(asked).to.include(`500 SDOGE to ${f.bob.address}`);
      expect(asked).to.include("no penalty");
      expect(asked).to.include("its NFT goes back to your own wallet");
      const after = await Promise.all([f.bob, f.carol, dave].map((w) => f.sdoge.balanceOf(w.address)));
      expect(after.map((a, i) => a - before[i])).to.deep.equal([E("500"), E("333.3"), E("166.7")]);
      expect((await f.staking.getStake(1)).closed).to.equal(true);
      expect(await f.collectibles.balanceOf(f.alice.address, 2)).to.equal(1);
      expect(p.sent.at(-1).chainId).to.equal(hex(31337));

      // a fifth wallet, or shares that don't add up to 100%, never reach the wallet
      const p2 = await page(f, STAKING_PAGE, f.alice);
      await p2.ready();
      expect(await p2.run("connectWallet()")).to.equal(true);
      const plan = (rows) => p2.run(`splitPlan(1000n * 10n ** 18n, 1000n * 10n ** 18n, 1500n, false, ${JSON.stringify(rows)})`);
      const w = (addr, pct) => ({ addr, pct });
      expect(plan([w(f.bob.address, "60"), w(f.carol.address, "30")]).error).to.match(/add up to 90%/);
      expect(plan([1, 2, 3, 4, 5].map(() => w(erin.address, "20"))).error).to.match(/1 to 4 wallets/);
      expect(plan([w("0x1234", "100")]).error).to.match(/isn't a wallet address/);
    });

    it("an early split takes the penalty off first, and every wallet gets its share of the rest", async function () {
      const f = await deployAll();
      const address = await f.staking.getAddress();
      await f.sdoge.connect(f.alice).approve(address, E("1000"));
      await f.staking.connect(f.alice).stake(0, E("1000"), 7 * 86400, 10000);
      const p = await page(f, STAKING_PAGE, f.alice);
      await p.ready();
      expect(await p.run("connectWallet()")).to.equal(true);
      await p.run("openSplit(1n)");
      p.el("splitAmount").value = "400"; // part of the stake
      p.run(`splitState.rows = [{ addr: "${f.bob.address}", pct: "75" }, { addr: "${f.carol.address}", pct: "25" }]`);
      const before = await Promise.all([f.bob, f.carol].map((w) => f.sdoge.balanceOf(w.address)));
      await p.run("submitSplit()");
      expect(p.confirms.at(-1)).to.include("60 SDOGE (15%) stays in the pool");
      const after = await Promise.all([f.bob, f.carol].map((w) => f.sdoge.balanceOf(w.address)));
      expect(after.map((a, i) => a - before[i])).to.deep.equal([E("255"), E("85")]); // 340 after the penalty
      const s = await f.staking.getStake(1);
      expect([s.amount, s.closed]).to.deep.equal([E("600"), false]);
    });

    it("shows the pool's real numbers and an APR from the live reward rates", async function () {
      const f = await deployAll();
      const address = await f.staking.getAddress();
      await f.sdoge.connect(f.alice).approve(address, E("1000"));
      await f.staking.connect(f.alice).stake(0, E("1000"), 7 * 86400, 10000);
      await f.sdoge.mint(f.owner.address, E("70"));
      await f.sdoge.connect(f.owner).approve(address, E("70"));
      await f.staking.connect(f.owner).notifySdogeRewards(E("70")); // 10 SDOGE a day
      const p = await page(f, STAKING_PAGE, f.bob);
      await p.ready();
      await p.run("liveLoad");
      expect(p.el("statTotalStaked").textContent).to.equal("1,000");
      expect(p.el("statStakers").textContent).to.equal("1");
      expect(p.el("statApr").textContent).to.equal("365%"); // 10 a day over 1,000 staked at 1.0x
      p.el("stakeAmount").value = "1000";
      p.run("updateEstimates()");
      // another 1,000 at 1.0x would share the stream half and half
      expect(p.el("estDaily").textContent).to.equal("5 SDOGE");
      expect(p.el("estApr").textContent).to.equal("182.5%");
    });
  });

  describe("owner.js", function () {
    const OWNER_PAGE = ["arc.js", "wallet.js", "owner.js"];
    const KEYS = ["collectibles", "staking", "studio", "marketplace"];
    const short = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;
    const ownerPage = async (f, who) => {
      const p = await page(f, OWNER_PAGE, who);
      await p.ready();
      expect(await p.run("connectWallet()")).to.equal(true);
      await p.run("loadOwnerState()");
      return p;
    };

    it("its Studio revenue share matches nft/studio.json", async function () {
      const [a] = await ethers.getSigners();
      const p = await loadPage({ files: OWNER_PAGE, hreProvider: network.provider, account: a.address });
      expect(p.run("OWNER_STUDIO_POOL_SHARE_BPS")).to.equal(BigInt(studioManifest.poolShareBps));
    });

    it("shows who owns each contract, and only the wallet it was offered to can accept it", async function () {
      const f = await deployAll();
      for (const c of [f.collectibles, f.staking, f.studio, f.marketplace]) await c.transferOwnership(f.alice.address);

      const bob = await ownerPage(f, f.bob);
      expect(bob.el("ownerList").innerHTML).to.include(`Offered to ${short(f.alice.address)}, waiting for that wallet to accept`);
      expect(bob.el("ownerList").innerHTML).to.not.include("data-accept");
      await bob.run("ownerAccept('staking')");
      expect(bob.alerts.at(-1)).to.match(/hasn't been offered to this wallet/);
      expect(bob.sent.length).to.equal(0);

      const p = await ownerPage(f, f.alice);
      for (const key of KEYS) expect(p.el("ownerList").innerHTML).to.include(`data-accept="${key}"`);
      // While one action runs, every button waits, and the page says why.
      p.run("setOwnerBusy(true)");
      expect(p.el("ownerList").innerHTML).to.include('data-accept="staking" disabled');
      expect(p.el("ownerNotice").textContent).to.match(/Working on it/);
      expect(await p.run("ownerAccept('staking')")).to.equal(false);
      expect(p.sent.length).to.equal(0);
      p.run("setOwnerBusy(false)");
      expect(p.el("ownerList").innerHTML).to.not.include("disabled");
      for (const key of KEYS) await p.run(`ownerAccept('${key}')`);
      expect(p.confirms[0]).to.include("Accept ownership of the NFT collection contract");
      for (const c of [f.collectibles, f.staking, f.studio, f.marketplace]) expect(await c.owner()).to.equal(f.alice.address);
      expect(p.el("ownerList").innerHTML.match(/You own it/g)).to.have.length(4);
      expect(p.sent.every((tx) => tx.chainId === hex(31337))).to.equal(true);
      await p.run("ownerAccept('staking')");
      expect(p.alerts.at(-1)).to.match(/already owns the Staking contract/);
    });

    it("lists the wallet's token approvals to swap apps and removes one", async function () {
      const f = await deployAll();
      const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
      await f.sdoge.connect(f.alice).approve(PERMIT2, ethers.MaxUint256);
      const p = await ownerPage(f, f.alice);
      await p.run("loadOwnerApprovals()");
      expect(p.el("ownerApprovals").innerHTML).to.include("SDOGE → Permit2 (used by swap apps)");
      expect(p.el("ownerApprovals").innerHTML).to.include("Unlimited");
      await p.run("ownerRevoke(0)");
      expect(p.confirms.at(-1)).to.include("Remove this wallet's SDOGE approval for Permit2");
      expect(await f.sdoge.allowance(f.alice.address, PERMIT2)).to.equal(0n);
      expect(p.el("ownerApprovals").innerHTML).to.include("Nothing to remove");
      expect(p.sent.every((tx) => tx.chainId === hex(31337))).to.equal(true);
    });

    it("starts rewards only after the owner's seed stake, then sends revenue to the stakers", async function () {
      const f = await deployAll();
      const staking = await f.staking.getAddress();
      const p = await ownerPage(f, f.owner);
      expect(p.el("ownerStartSdoge").disabled).to.equal(true);
      p.el("ownerSdogeAmount").value = "70";
      await p.run("ownerStartSdogeRewards()");
      expect(p.alerts.at(-1)).to.match(/Make the seed stake first/);
      await p.run("ownerRoute('studio')");
      expect(p.alerts.at(-1)).to.match(/Start rewards first/);
      expect(p.sent.length).to.equal(0);

      // The seed stake: 365 days, from the owner.
      await f.sdoge.mint(f.owner.address, E("1070"));
      await f.sdoge.connect(f.owner).approve(staking, E("1000"));
      await f.staking.connect(f.owner).stake(4, E("1000"), 365 * 86400, 30000);
      await p.run("loadOwnerState()");
      expect(p.el("stepSeedState").textContent).to.equal(`Done: 1 open stake(s) from ${short(f.owner.address)}`);
      expect(p.el("ownerStartSdoge").disabled).to.equal(false);
      await p.run("ownerStartSdogeRewards()");
      expect(p.confirms.at(-1)).to.equal("Stream 70 SDOGE to the stakers over the next 7 days? This starts rewards.");
      expect(await f.staking.rewardsStarted()).to.equal(true);
      expect(await f.sdoge.allowance(f.owner.address, staking)).to.equal(0);
      p.el("ownerUsdcAmount").value = "1.5";
      await p.run("ownerStartUsdcRewards()");
      expect(p.confirms.at(-1)).to.include("It adds to the stream that is running.");
      expect(await f.staking.periodFinish()).to.be.greaterThan(0n);
      expect(await ethers.provider.getBalance(staking)).to.equal(E("1.5"));

      await p.run("ownerRoute('studio')");
      await p.run("ownerRoute('marketplace')");
      expect(await f.studio.rewardsPool()).to.equal(staking);
      expect(await f.studio.poolShareBps()).to.equal(5000n);
      expect(await f.marketplace.rewardsPool()).to.equal(staking);
      expect(p.el("stepRevenueState").textContent).to.equal("Studio: 50% of credit sales · Marketplace fees: to the stakers");
      expect([p.el("ownerRouteStudio").disabled, p.el("ownerRouteMarket").disabled]).to.deep.equal([true, true]);
      const sentSoFar = p.sent.length;
      await p.run("ownerRoute('marketplace')");
      expect(p.alerts.at(-1)).to.match(/Already done: the Marketplace contract already sends to the stakers/);
      expect(p.sent.length).to.equal(sentSoFar);
      expect(p.sent.every((tx) => tx.chainId === hex(31337))).to.equal(true);

      // Anyone else can look, not act.
      const bob = await ownerPage(f, f.bob);
      bob.el("ownerSdogeAmount").value = "1";
      await bob.run("ownerStartSdogeRewards()");
      expect(bob.alerts.at(-1)).to.match(/Only the staking contract.s owner can start rewards/);
      expect(bob.sent.length).to.equal(0);
    });
  });
});
