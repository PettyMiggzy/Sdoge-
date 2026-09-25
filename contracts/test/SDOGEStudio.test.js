const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { PACKAGES } = require("./helpers/studio");

const E = (n) => ethers.parseEther(String(n));
const DEAD = "0x000000000000000000000000000000000000dEaD";

async function deployFixture() {
  const [owner, alice, bob, carol, treasury, stranger] = await ethers.getSigners();
  const sdoge = await (await ethers.getContractFactory("MockERC20")).deploy("Stable Doge", "SDOGE");
  const studio = await (await ethers.getContractFactory("SDOGEStudio")).deploy(
    owner.address,
    await sdoge.getAddress(),
    treasury.address,
    PACKAGES,
    "ipfs://bafy/community.json"
  );
  const community = await ethers.getContractAt("SDOGEStudioCollection", await studio.communityCollection());
  const staking = await (await ethers.getContractFactory("SDOGEStaking")).deploy(
    await sdoge.getAddress(),
    ethers.ZeroAddress,
    owner.address
  );
  for (const u of [alice, bob]) {
    await sdoge.mint(u.address, E("10000000"));
    await sdoge.connect(u).approve(await studio.getAddress(), ethers.MaxUint256);
  }
  return { owner, alice, bob, carol, treasury, stranger, sdoge, studio, community, staking };
}

const bal = (a) => ethers.provider.getBalance(a);

async function createCollection(f, who = f.alice, opts = {}) {
  const { name = "Alice Club", symbol = "ACLUB", maxSupply = 0, royaltyTo = ethers.ZeroAddress, royaltyBps = 500 } = opts;
  const addr = await f.studio
    .connect(who)
    .createCollection.staticCall(name, symbol, maxSupply, royaltyTo, royaltyBps, "");
  await f.studio.connect(who).createCollection(name, symbol, maxSupply, royaltyTo, royaltyBps, "");
  return ethers.getContractAt("SDOGEStudioCollection", addr);
}

describe("SDOGEStudio", function () {
  describe("deployment", function () {
    it("sets the packages, treasury and the shared Community Art collection", async function () {
      const f = await deployFixture();
      expect(await f.studio.owner()).to.equal(f.owner.address);
      expect(await f.studio.treasury()).to.equal(f.treasury.address);
      expect(await f.studio.packageCount()).to.equal(4);
      const p = await f.studio.getPackages();
      expect(p.map((x) => Number(x.mints))).to.deep.equal([1, 10, 100, 1000]);
      expect(p[3].priceWei).to.equal(E("100"));
      expect(p[0].priceSdoge).to.equal(E("1000000"));
      expect(p.every((x) => x.active)).to.equal(true);

      const c = await f.studio.communityCollection();
      expect(await f.community.name()).to.equal("SDOGE Community Art");
      expect(await f.community.symbol()).to.equal("SDOGEART");
      expect(await f.community.owner()).to.equal(await f.studio.getAddress());
      expect(await f.community.isCommunity()).to.equal(true);
      expect(await f.community.contractURI()).to.equal("ipfs://bafy/community.json");
      expect(await f.studio.isCollection(c)).to.equal(true);
      expect(await f.studio.verified(c)).to.equal(true);
      expect(await f.studio.collectionCount()).to.equal(1);
    });

    it("refuses a token with no code or without 18 decimals, and a zero treasury", async function () {
      const f = await deployFixture();
      const S = await ethers.getContractFactory("SDOGEStudio");
      await expect(S.deploy(f.owner.address, f.owner.address, f.treasury.address, [], "")).to.be.revertedWith(
        "token has no code"
      );
      const six = await (await ethers.getContractFactory("MockToken6")).deploy();
      await expect(S.deploy(f.owner.address, await six.getAddress(), f.treasury.address, [], "")).to.be.revertedWith(
        "token must have 18 decimals"
      );
      await expect(S.deploy(f.owner.address, await f.sdoge.getAddress(), ethers.ZeroAddress, [], "")).to.be.revertedWith(
        "treasury is zero address"
      );
    });

    it("the collection implementation and every clone can't be initialized again", async function () {
      const f = await deployFixture();
      const impl = await ethers.getContractAt("SDOGEStudioCollection", await f.studio.collectionImplementation());
      const init = (c) => c.initialize(f.stranger.address, "X", "X", 0, ethers.ZeroAddress, 0, "", true);
      await expect(init(impl)).to.be.revertedWithCustomError(impl, "InvalidInitialization");
      await expect(init(f.community.connect(f.stranger))).to.be.revertedWithCustomError(impl, "InvalidInitialization");
      expect(await impl.owner()).to.equal(ethers.ZeroAddress);
      expect(await impl.studio()).to.equal(await f.studio.getAddress());
    });

    it("a clone of the implementation made outside the Studio can't be set up", async function () {
      const f = await deployFixture();
      const cloner = await (await ethers.getContractFactory("RogueCloner")).deploy();
      await expect(cloner.cloneAndInit(await f.studio.collectionImplementation(), f.stranger.address)).to.be.revertedWith(
        "studio only"
      );
    });
  });

  describe("packages", function () {
    it("the owner can add, change and pause packages within the price rules", async function () {
      const f = await deployFixture();
      const s = f.studio.connect(f.owner);
      await expect(s.addPackage(50, E("10"), E("200000")))
        .to.emit(f.studio, "PackageAdded")
        .withArgs(4, 50, E("10"), E("200000"));
      await expect(s.updatePackage(4, 60, E("12"), 0)).to.emit(f.studio, "PackageUpdated").withArgs(4, 60, E("12"), 0);
      await expect(s.setPackageActive(4, false)).to.emit(f.studio, "PackageActiveSet").withArgs(4, false);
      expect((await f.studio.getPackage(4)).active).to.equal(false);
      await expect(s.updatePackage(9, 1, E("1"), 0)).to.be.revertedWith("no such package");
      await expect(s.setPackageActive(9, true)).to.be.revertedWith("no such package");
    });

    it("rejects packages with no price, bad units or silly sizes", async function () {
      const f = await deployFixture();
      const add = (...a) => f.studio.connect(f.owner).addPackage(...a);
      await expect(add(0, E("1"), 0)).to.be.revertedWith("mints out of range");
      await expect(add(100_001, E("1"), 0)).to.be.revertedWith("mints out of range");
      await expect(add(1, 0, 0)).to.be.revertedWith("a package needs a price");
      const usdc = "USDC price must be 0.01-1,000,000 in whole micro-USDC (18 decimals)";
      await expect(add(1, 5_000_000n, 0)).to.be.revertedWith(usdc); // "5 USDC" in 6 decimals
      await expect(add(1, E("5") + 1n, 0)).to.be.revertedWith(usdc);
      await expect(add(1, E("1000001"), 0)).to.be.revertedWith(usdc);
      const sd = "SDOGE price must be 1-1,000,000,000 SDOGE (18 decimals)";
      await expect(add(1, 0, 1_000_000n)).to.be.revertedWith(sd); // "1M SDOGE" without decimals
      await expect(add(1, 0, E("1000000001"))).to.be.revertedWith(sd);
      for (let i = 4; i < 20; i++) await add(1, E("1"), 0);
      await expect(add(1, E("1"), 0)).to.be.revertedWith("too many packages");
    });

    it("only the owner manages packages", async function () {
      const f = await deployFixture();
      const s = f.studio.connect(f.stranger);
      for (const call of [() => s.addPackage(1, E("1"), 0), () => s.updatePackage(0, 1, E("1"), 0), () => s.setPackageActive(0, false)]) {
        await expect(call()).to.be.revertedWithCustomError(f.studio, "OwnableUnauthorizedAccount");
      }
    });
  });

  describe("buying credits", function () {
    it("with USDC: exact price, credited to any address", async function () {
      const f = await deployFixture();
      await expect(f.studio.connect(f.alice).buyCredits(3, 1000, f.bob.address, { value: E("100") }))
        .to.emit(f.studio, "CreditsBought")
        .withArgs(f.alice.address, f.bob.address, 3, 1000, E("100"), 0);
      expect(await f.studio.credits(f.bob.address)).to.equal(1000);
      expect(await f.studio.credits(f.alice.address)).to.equal(0);
      expect(await bal(await f.studio.getAddress())).to.equal(E("100"));
      await expect(f.studio.connect(f.alice).buyCredits(0, 1, f.alice.address, { value: E("4.99") })).to.be.revertedWith(
        "incorrect payment"
      );
      await expect(f.studio.connect(f.alice).buyCredits(0, 1, ethers.ZeroAddress, { value: E("5") })).to.be.revertedWith(
        "bad recipient"
      );
      await expect(f.studio.connect(f.alice).buyCredits(7, 1, f.alice.address, { value: E("5") })).to.be.revertedWith(
        "no such package"
      );
    });

    it("a package change landing first can't shortchange the buyer", async function () {
      const f = await deployFixture();
      await f.studio.connect(f.owner).updatePackage(3, 500, E("100"), 0);
      await expect(f.studio.connect(f.alice).buyCredits(3, 1000, f.alice.address, { value: E("100") })).to.be.revertedWith(
        "package changed"
      );
      await f.studio.connect(f.owner).setPackageActive(3, false);
      await expect(f.studio.connect(f.alice).buyCredits(3, 500, f.alice.address, { value: E("100") })).to.be.revertedWith(
        "package not for sale"
      );
    });

    it("with SDOGE: burns the price to dEaD, never more than the buyer's limit", async function () {
      const f = await deployFixture();
      const before = await f.sdoge.balanceOf(f.alice.address);
      await expect(f.studio.connect(f.alice).buyCreditsWithSdoge(0, 1, E("1000000"), f.alice.address))
        .to.emit(f.studio, "CreditsBought")
        .withArgs(f.alice.address, f.alice.address, 0, 1, 0, E("1000000"));
      expect(await f.sdoge.balanceOf(DEAD)).to.equal(E("1000000"));
      expect(before - (await f.sdoge.balanceOf(f.alice.address))).to.equal(E("1000000"));
      expect(await f.sdoge.balanceOf(await f.studio.getAddress())).to.equal(0);
      expect(await f.studio.credits(f.alice.address)).to.equal(1);

      await f.studio.connect(f.owner).updatePackage(0, 1, E("5"), E("2000000"));
      await expect(f.studio.connect(f.alice).buyCreditsWithSdoge(0, 1, E("1000000"), f.alice.address)).to.be.revertedWith(
        "price is above your limit"
      );
      await expect(f.studio.connect(f.alice).buyCreditsWithSdoge(3, 1000, E("1000000"), f.alice.address)).to.be.revertedWith(
        "not sold for SDOGE"
      );
      await expect(f.studio.connect(f.carol).buyCreditsWithSdoge(0, 1, E("2000000"), f.carol.address)).to.be.reverted; // no SDOGE
    });

    it("a SDOGE-only package can't be bought with USDC", async function () {
      const f = await deployFixture();
      await f.studio.connect(f.owner).addPackage(5, 0, E("3000000"));
      await expect(f.studio.connect(f.alice).buyCredits(4, 5, f.alice.address, { value: 0 })).to.be.revertedWith(
        "not sold for USDC"
      );
    });

    it("the owner can grant credits, within bounds", async function () {
      const f = await deployFixture();
      await expect(f.studio.connect(f.owner).grantCredits(f.bob.address, 250))
        .to.emit(f.studio, "CreditsGranted")
        .withArgs(f.bob.address, 250);
      expect(await f.studio.credits(f.bob.address)).to.equal(250);
      await expect(f.studio.connect(f.owner).grantCredits(f.bob.address, 0)).to.be.revertedWith("amount out of range");
      await expect(f.studio.connect(f.owner).grantCredits(f.bob.address, 100_001)).to.be.revertedWith(
        "amount out of range"
      );
      await expect(f.studio.connect(f.owner).grantCredits(ethers.ZeroAddress, 1)).to.be.revertedWith("bad recipient");
      await expect(f.studio.connect(f.bob).grantCredits(f.bob.address, 1)).to.be.revertedWithCustomError(
        f.studio,
        "OwnableUnauthorizedAccount"
      );
    });

    it("only Studio collections can spend credits", async function () {
      const f = await deployFixture();
      await f.studio.connect(f.owner).grantCredits(f.alice.address, 5);
      await expect(f.studio.connect(f.bob).spendCredits(f.alice.address, 5)).to.be.revertedWith("collections only");
      await expect(f.studio.connect(f.alice).spendCredits(f.alice.address, 1)).to.be.revertedWith("collections only");
    });
  });

  describe("Community Art: mint your own 1-of-1", function () {
    it("one credit mints a token with your URI, owned by you", async function () {
      const f = await deployFixture();
      await f.studio.connect(f.alice).buyCredits(0, 1, f.alice.address, { value: E("5") });
      await expect(f.studio.connect(f.alice).mintCommunity("ipfs://bafy/alice.json"))
        .to.emit(f.studio, "CreditsSpent")
        .withArgs(f.alice.address, await f.community.getAddress(), 1);
      expect(await f.community.ownerOf(1)).to.equal(f.alice.address);
      expect(await f.community.tokenURI(1)).to.equal("ipfs://bafy/alice.json");
      expect(await f.studio.credits(f.alice.address)).to.equal(0);
      await expect(f.studio.connect(f.alice).mintCommunity("ipfs://bafy/again.json")).to.be.revertedWith(
        "not enough mint credits"
      );
    });

    it("burning SDOGE for a credit is the old 1,000,000 SDOGE community mint", async function () {
      const f = await deployFixture();
      await f.studio.connect(f.alice).buyCreditsWithSdoge(0, 1, E("1000000"), f.alice.address);
      await f.studio.connect(f.alice).mintCommunity("ipfs://bafy/alice.json");
      expect(await f.community.ownerOf(1)).to.equal(f.alice.address);
      expect(await f.sdoge.balanceOf(DEAD)).to.equal(E("1000000"));
    });

    it("only accepts well-formed URIs (printable ASCII, no spaces, up to 512 bytes)", async function () {
      const f = await deployFixture();
      await f.studio.connect(f.owner).grantCredits(f.alice.address, 10);
      const m = (u) => f.studio.connect(f.alice).mintCommunity(u);
      const bad = "uri must be 1-512 printable ASCII characters, no spaces";
      for (const u of ["", "ipfs://has space", "ipfs://ünicode", "ipfs://x‮", "ipfs://x\n", "ipfs://" + "a".repeat(506)]) {
        await expect(m(u)).to.be.revertedWith(bad);
      }
      await m("ipfs://" + "a".repeat(505));
      expect(await f.studio.credits(f.alice.address)).to.equal(9); // failed mints cost nothing
    });

    it("the URI is set before the receiver hook runs", async function () {
      const f = await deployFixture();
      const reader = await (await ethers.getContractFactory("UriReadingReceiver")).deploy();
      await f.studio.connect(f.owner).grantCredits(await reader.getAddress(), 1);
      await reader.mintVia(await f.studio.getAddress(), "ipfs://bafy/seen.json");
      expect(await reader.seenUri()).to.equal("ipfs://bafy/seen.json");
    });

    it("blocks a reentrant mint from the ERC-721 receive hook", async function () {
      const f = await deployFixture();
      const attacker = await (await ethers.getContractFactory("ReentrantMinter")).deploy();
      await attacker.setTarget(await f.studio.getAddress(), 1);
      await f.studio.connect(f.owner).grantCredits(await attacker.getAddress(), 5);
      await expect(attacker.attackCommunity("ipfs://first.json")).to.be.revertedWithCustomError(
        f.studio,
        "ReentrancyGuardReentrantCall"
      );
      expect(await f.community.totalMinted()).to.equal(0);
      expect(await f.studio.credits(await attacker.getAddress())).to.equal(5);
    });

    it("nobody, the team included, can mint into it directly or change anyone's token", async function () {
      const f = await deployFixture();
      await f.studio.connect(f.owner).grantCredits(f.alice.address, 1);
      await f.studio.connect(f.alice).mintCommunity("ipfs://bafy/alice.json");
      await expect(f.community.connect(f.owner).mintCommunity(f.owner.address, "ipfs://x")).to.be.revertedWith("studio only");
      const c = f.community.connect(f.owner);
      for (const call of [
        () => c.mintBatch(f.owner.address, 1),
        () => c.airdrop([f.owner.address]),
        () => c.setBaseURI("ipfs://evil/", ""),
        () => c.setDropOpen(true),
        () => c.transferOwnership(f.owner.address),
      ]) {
        await expect(call()).to.be.revertedWithCustomError(f.community, "OwnableUnauthorizedAccount");
      }
      await expect(c.transferFrom(f.alice.address, f.owner.address, 1)).to.be.revertedWithCustomError(
        f.community,
        "ERC721InsufficientApproval"
      );
      expect(await f.community.tokenURI(1)).to.equal("ipfs://bafy/alice.json");
    });
  });

  describe("creator collections", function () {
    it("anyone can create their own collection; they own it", async function () {
      const f = await deployFixture();
      const tx = f.studio.connect(f.alice).createCollection("Alice Club", "ACLUB", 1000, ethers.ZeroAddress, 500, "ipfs://c.json");
      await expect(tx).to.emit(f.studio, "CollectionCreated");
      const [addr] = await f.studio.collectionsOf(f.alice.address);
      const c = await ethers.getContractAt("SDOGEStudioCollection", addr);
      expect(await c.owner()).to.equal(f.alice.address);
      expect(await c.name()).to.equal("Alice Club");
      expect(await c.symbol()).to.equal("ACLUB");
      expect(await c.maxSupply()).to.equal(1000);
      expect(await c.payout()).to.equal(f.alice.address);
      expect(await c.isCommunity()).to.equal(false);
      expect(await c.studio()).to.equal(await f.studio.getAddress());
      const [receiver, amount] = await c.royaltyInfo(1, E("100"));
      expect(receiver).to.equal(f.alice.address); // zero receiver means the creator
      expect(amount).to.equal(E("5"));
      expect(await f.studio.isCollection(addr)).to.equal(true);
      expect(await f.studio.verified(addr)).to.equal(false);
    });

    it("validates the name, symbol and royalty", async function () {
      const f = await deployFixture();
      const mk = (n, s, bps = 0) => f.studio.connect(f.alice).createCollection(n, s, 0, ethers.ZeroAddress, bps, "");
      await expect(mk("", "X")).to.be.revertedWith("name must be 1-64 printable ASCII characters");
      await expect(mk("x".repeat(65), "X")).to.be.revertedWith("name must be 1-64 printable ASCII characters");
      await expect(mk("Doge‮Club", "X")).to.be.revertedWith("name must be 1-64 printable ASCII characters");
      await expect(mk("Club", "A B")).to.be.revertedWith("symbol must be 1-16 printable ASCII characters, no spaces");
      await expect(mk("Club", "")).to.be.revertedWith("symbol must be 1-16 printable ASCII characters, no spaces");
      await expect(mk("Club", "X", 1001)).to.be.revertedWith("royalty above 10%");
      await mk("My Doge Club", "DOGE", 1000);
    });

    it("lists collections per creator and in pages", async function () {
      const f = await deployFixture();
      await createCollection(f, f.alice, { name: "A1" });
      await createCollection(f, f.bob, { name: "B1" });
      await createCollection(f, f.alice, { name: "A2" });
      expect((await f.studio.collectionsOf(f.alice.address)).length).to.equal(2);
      expect(await f.studio.collectionCount()).to.equal(4); // + Community Art
      const page = await f.studio.getCollections(1, 2);
      expect(page.length).to.equal(2);
      expect(await (await ethers.getContractAt("SDOGEStudioCollection", page[0])).name()).to.equal("A1");
      expect((await f.studio.getCollections(3, 10)).length).to.equal(1);
      expect((await f.studio.getCollections(9, 10)).length).to.equal(0);
    });

    it("the owner can mark real projects Verified, and only Studio collections", async function () {
      const f = await deployFixture();
      const c = await createCollection(f);
      await expect(f.studio.connect(f.owner).setVerified(await c.getAddress(), true))
        .to.emit(f.studio, "VerifiedSet")
        .withArgs(await c.getAddress(), true);
      expect(await f.studio.verified(await c.getAddress())).to.equal(true);
      await expect(f.studio.connect(f.owner).setVerified(f.stranger.address, true)).to.be.revertedWith(
        "not a Studio collection"
      );
      await expect(f.studio.connect(f.alice).setVerified(await c.getAddress(), false)).to.be.revertedWithCustomError(
        f.studio,
        "OwnableUnauthorizedAccount"
      );
    });

    it("the Verified badge belongs to the owner it was given to and lapses if the collection changes hands", async function () {
      const f = await deployFixture();
      const c = await createCollection(f);
      const addr = await c.getAddress();
      await f.studio.connect(f.owner).setVerified(addr, true);
      expect(await f.studio.verifiedOwner(addr)).to.equal(f.alice.address);
      await c.connect(f.alice).transferOwnership(f.bob.address);
      expect(await f.studio.verified(addr)).to.equal(true); // still Alice's until Bob accepts
      await c.connect(f.bob).acceptOwnership();
      expect(await f.studio.verified(addr)).to.equal(false);
      await f.studio.connect(f.owner).setVerified(addr, true); // the team can verify the new owner
      expect(await f.studio.verified(addr)).to.equal(true);
      await expect(f.studio.connect(f.owner).setVerified(addr, false)).to.emit(f.studio, "VerifiedSet").withArgs(addr, false);
      expect(await f.studio.verified(addr)).to.equal(false);
      expect(await f.studio.verified(f.stranger.address)).to.equal(false);
      expect(await f.studio.verified(await f.community.getAddress())).to.equal(true);
    });

    it("a royalty can't be pointed at the collection itself or the Studio", async function () {
      const f = await deployFixture();
      const c = await createCollection(f);
      const bad = "bad royalty receiver";
      await expect(c.connect(f.alice).setRoyalty(await c.getAddress(), 500)).to.be.revertedWith(bad);
      await expect(c.connect(f.alice).setRoyalty(await f.studio.getAddress(), 500)).to.be.revertedWith(bad);
      await expect(
        f.studio.connect(f.alice).createCollection("X Club", "X", 0, await f.studio.getAddress(), 500, "")
      ).to.be.revertedWith(bad);
    });

    it("the owner can update Community Art's collection metadata, and nothing else in it", async function () {
      const f = await deployFixture();
      await expect(f.studio.connect(f.owner).setCommunityContractURI("ipfs://bafy/community-v2.json")).to.emit(
        f.community,
        "ContractURIUpdated"
      );
      expect(await f.community.contractURI()).to.equal("ipfs://bafy/community-v2.json");
      await expect(f.studio.connect(f.owner).setCommunityContractURI("bad uri")).to.be.revertedWith(
        "uri must be 1-512 printable ASCII characters, no spaces"
      );
      await expect(f.studio.connect(f.alice).setCommunityContractURI("ipfs://x")).to.be.revertedWithCustomError(
        f.studio,
        "OwnableUnauthorizedAccount"
      );
      await expect(f.community.connect(f.owner).setCommunityContractURI("ipfs://x")).to.be.revertedWith("studio only");
      const c = await createCollection(f);
      await expect(c.connect(f.alice).setCommunityContractURI("ipfs://x")).to.be.revertedWith("studio only");
    });
  });

  describe("revenue", function () {
    it("anyone can send it out: the pool's share to staking, the rest to the treasury", async function () {
      const f = await deployFixture();
      await f.studio.connect(f.owner).setRewardsPool(await f.staking.getAddress(), 5000);
      await f.studio.connect(f.alice).buyCredits(3, 1000, f.alice.address, { value: E("100") });
      await f.studio.connect(f.bob).buyCredits(0, 1, f.bob.address, { value: E("5") });
      const t0 = await bal(f.treasury.address);
      await expect(f.studio.connect(f.stranger).withdraw()).to.emit(f.studio, "Withdrawn").withArgs(E("52.5"), E("52.5"));
      expect(await f.staking.unallocatedUsdc()).to.equal(E("52.5"));
      expect((await bal(f.treasury.address)) - t0).to.equal(E("52.5"));
      expect(await bal(await f.studio.getAddress())).to.equal(0);
      await expect(f.studio.withdraw()).to.be.revertedWith("nothing to withdraw");
    });

    it("with no pool set, everything goes to the treasury", async function () {
      const f = await deployFixture();
      await f.studio.connect(f.alice).buyCredits(1, 10, f.alice.address, { value: E("20") });
      const t0 = await bal(f.treasury.address);
      await f.studio.withdraw();
      expect((await bal(f.treasury.address)) - t0).to.equal(E("20"));
    });

    it("validates the pool and the share", async function () {
      const f = await deployFixture();
      const s = f.studio.connect(f.owner);
      await expect(s.setRewardsPool(f.stranger.address, 5000)).to.be.revertedWith("pool must be a contract");
      await expect(s.setRewardsPool(ethers.ZeroAddress, 1)).to.be.revertedWith("no pool to share with");
      await expect(s.setRewardsPool(await f.staking.getAddress(), 10_001)).to.be.revertedWith("share above 100%");
      await expect(s.setRewardsPool(await f.staking.getAddress(), 10_000))
        .to.emit(f.studio, "RewardsPoolUpdated")
        .withArgs(await f.staking.getAddress(), 10_000);
      await s.setRewardsPool(ethers.ZeroAddress, 0);
      await expect(f.studio.connect(f.alice).setRewardsPool(ethers.ZeroAddress, 0)).to.be.revertedWithCustomError(
        f.studio,
        "OwnableUnauthorizedAccount"
      );
    });

    it("the pool's share is set aside at each sale; a later share change doesn't touch it", async function () {
      const f = await deployFixture();
      const pool = await f.staking.getAddress();
      await f.studio.connect(f.alice).buyCredits(1, 10, f.alice.address, { value: E("20") }); // no pool yet
      expect(await f.studio.poolOwed()).to.equal(0);
      await f.studio.connect(f.owner).setRewardsPool(pool, 5000);
      await f.studio.connect(f.alice).buyCredits(0, 1, f.alice.address, { value: E("5") });
      expect(await f.studio.poolOwed()).to.equal(E("2.5"));
      await f.studio.connect(f.owner).setRewardsPool(pool, 0);
      await f.studio.connect(f.alice).buyCredits(0, 1, f.alice.address, { value: E("5") });
      expect(await f.studio.poolOwed()).to.equal(E("2.5"));
      await f.studio.connect(f.alice).buyCreditsWithSdoge(0, 1, E("1000000"), f.alice.address); // burned, not revenue
      const t0 = await bal(f.treasury.address);
      await expect(f.studio.withdraw()).to.emit(f.studio, "Withdrawn").withArgs(E("2.5"), E("27.5"));
      expect(await f.staking.unallocatedUsdc()).to.equal(E("2.5"));
      expect((await bal(f.treasury.address)) - t0).to.equal(E("27.5"));
      expect(await f.studio.poolOwed()).to.equal(0);
    });

    it("a pool or treasury that refuses USDC doesn't block the other; its share waits", async function () {
      const f = await deployFixture();
      const refuser = await (await ethers.getContractFactory("RevertingReceiver")).deploy();
      const noContribute = await f.sdoge.getAddress(); // a contract without contributeUSDC
      await f.studio.connect(f.owner).setRewardsPool(noContribute, 5000);
      await f.studio.connect(f.alice).buyCredits(1, 10, f.alice.address, { value: E("20") });
      const t0 = await bal(f.treasury.address);
      await expect(f.studio.connect(f.stranger).withdraw())
        .to.emit(f.studio, "PayoutFailed")
        .withArgs(noContribute, E("10"))
        .and.to.emit(f.studio, "Withdrawn")
        .withArgs(0, E("10"));
      expect((await bal(f.treasury.address)) - t0).to.equal(E("10"));
      expect(await f.studio.poolOwed()).to.equal(E("10"));
      await expect(f.studio.withdraw()).to.be.revertedWith("nothing could be paid");

      // the pool works again, but now the treasury refuses: the pool is paid all it's owed
      await f.studio.connect(f.owner).setRewardsPool(await f.staking.getAddress(), 5000);
      await f.studio.connect(f.owner).setTreasury(await refuser.getAddress());
      await f.studio.connect(f.alice).buyCredits(0, 1, f.alice.address, { value: E("5") });
      await expect(f.studio.withdraw())
        .to.emit(f.studio, "PayoutFailed")
        .withArgs(await refuser.getAddress(), E("2.5"))
        .and.to.emit(f.studio, "Withdrawn")
        .withArgs(E("12.5"), 0);
      expect(await f.staking.unallocatedUsdc()).to.equal(E("12.5"));
      expect(await bal(await f.studio.getAddress())).to.equal(E("2.5"));

      await f.studio.connect(f.owner).setTreasury(f.treasury.address);
      await expect(f.studio.withdraw()).to.emit(f.studio, "Withdrawn").withArgs(0, E("2.5"));
      expect(await bal(await f.studio.getAddress())).to.equal(0);
      await expect(f.studio.withdraw()).to.be.revertedWith("nothing to withdraw");
      await expect(f.studio.connect(f.owner).setTreasury(ethers.ZeroAddress)).to.be.revertedWith("treasury is zero address");
    });

    it("turning the pool off keeps what it's owed set aside for the next pool", async function () {
      const f = await deployFixture();
      await f.studio.connect(f.owner).setRewardsPool(await f.staking.getAddress(), 5000);
      await f.studio.connect(f.alice).buyCredits(0, 1, f.alice.address, { value: E("5") });
      await f.studio.connect(f.owner).setRewardsPool(ethers.ZeroAddress, 0);
      await expect(f.studio.withdraw()).to.emit(f.studio, "Withdrawn").withArgs(0, E("2.5"));
      await expect(f.studio.withdraw()).to.be.revertedWith("nothing could be paid");
      expect(await bal(await f.studio.getAddress())).to.equal(E("2.5"));
      await f.studio.connect(f.owner).setRewardsPool(await f.staking.getAddress(), 1000);
      await expect(f.studio.withdraw()).to.emit(f.studio, "Withdrawn").withArgs(E("2.5"), 0);
      expect(await f.staking.unallocatedUsdc()).to.equal(E("2.5"));
    });

    it("takes plain USDC transfers (e.g. from Community Art's withdraw) and sends them to the treasury", async function () {
      const f = await deployFixture();
      await f.alice.sendTransaction({ to: await f.studio.getAddress(), value: E("1") });
      await network.provider.send("hardhat_setBalance", [await f.community.getAddress(), ethers.toQuantity(E("2"))]);
      await expect(f.community.withdraw())
        .to.emit(f.community, "Withdrawn")
        .withArgs(await f.studio.getAddress(), E("2"));
      const t0 = await bal(f.treasury.address);
      await f.studio.withdraw();
      expect((await bal(f.treasury.address)) - t0).to.equal(E("3"));
    });

    it("USDC forced in (e.g. through the 0x3600 ERC-20 view) goes out with the revenue", async function () {
      const f = await deployFixture();
      await network.provider.send("hardhat_setBalance", [await f.studio.getAddress(), ethers.toQuantity(E("3"))]);
      const t0 = await bal(f.treasury.address);
      await f.studio.withdraw();
      expect((await bal(f.treasury.address)) - t0).to.equal(E("3"));
    });
  });

  describe("ownership", function () {
    it("moves in two steps and can't be renounced", async function () {
      const f = await deployFixture();
      await expect(f.studio.connect(f.owner).renounceOwnership()).to.be.revertedWith("renounce disabled");
      await f.studio.connect(f.owner).transferOwnership(f.alice.address);
      expect(await f.studio.owner()).to.equal(f.owner.address);
      await f.studio.connect(f.alice).acceptOwnership();
      expect(await f.studio.owner()).to.equal(f.alice.address);
    });
  });
});
