const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));

async function deployFixture() {
  const [owner, alice, bob, treasury, stranger] = await ethers.getSigners();
  const Collectibles = await ethers.getContractFactory("SDOGECollectibles");
  const nft = await Collectibles.deploy(owner.address, "https://example.test/metadata/", treasury.address);
  return { owner, alice, bob, treasury, stranger, nft };
}

// SWAT Doge: cap 300 at 40 USDC, 20 reserved for giveaways, opened for sale.
async function withOpenDesign() {
  const f = await deployFixture();
  await f.nft.connect(f.owner).createDesign(1, "SWAT Doge", 300, E("40"), 20);
  await f.nft.connect(f.owner).setPublicMint(1, true);
  return f;
}

describe("SDOGECollectibles", function () {
  describe("creating designs", function () {
    it("creates a closed design with the given terms", async function () {
      const { owner, nft } = await deployFixture();
      await expect(nft.connect(owner).createDesign(1, "SWAT Doge", 300, E("40"), 20))
        .to.emit(nft, "DesignCreated")
        .withArgs(1, "SWAT Doge", 300, E("40"), 20);
      const d = await nft.designs(1);
      expect(d.name).to.equal("SWAT Doge");
      expect(d.maxSupply).to.equal(300);
      expect(d.priceWei).to.equal(E("40"));
      expect(d.reserved).to.equal(20);
      expect(d.exists).to.equal(true);
      expect(d.publicMintOpen).to.equal(false);
      expect(await nft.nextDesignId()).to.equal(2);
    });

    it("requires the expected id, so a stray or repeated call can't shift the roster", async function () {
      const { owner, nft } = await deployFixture();
      await expect(nft.connect(owner).createDesign(2, "Space Doge", 200, E("50"), 0)).to.be.revertedWith(
        "unexpected design id"
      );
      await nft.connect(owner).createDesign(1, "SWAT Doge", 300, E("40"), 0);
      await expect(nft.connect(owner).createDesign(1, "SWAT Doge", 300, E("40"), 0)).to.be.revertedWith(
        "unexpected design id"
      );
    });

    it("validates supply, reserve, name and price", async function () {
      const { owner, nft } = await deployFixture();
      const c = (...a) => nft.connect(owner).createDesign(1, ...a);
      await expect(c("X", 0, E("1"), 0)).to.be.revertedWith("max supply must be > 0");
      await expect(c("X", 10, E("1"), 11)).to.be.revertedWith("reserve exceeds max supply");
      await expect(c("", 10, E("1"), 0)).to.be.revertedWith("name required");
      await expect(c("X", 10, 20_000_000n, 0)).to.be.revertedWith("price below 0.01 USDC (prices use 18 decimals)");
      await expect(c("X", 10, E("1") + 1n, 0)).to.be.revertedWith("price must be whole micro-USDC");
      await c("Giveaway Doge", 10, 0, 10); // price 0 = giveaway-only design
    });

    it("only the owner creates designs, and not after the collection is locked", async function () {
      const { owner, alice, nft } = await deployFixture();
      await expect(nft.connect(alice).createDesign(1, "X", 1, E("1"), 0)).to.be.revertedWithCustomError(
        nft,
        "OwnableUnauthorizedAccount"
      );
      await nft.connect(owner).lockCollection();
      await expect(nft.connect(owner).createDesign(1, "X", 1, E("1"), 0)).to.be.revertedWith("collection is locked");
    });
  });

  describe("public minting", function () {
    it("is closed until the owner opens it", async function () {
      const { owner, alice, nft } = await deployFixture();
      await nft.connect(owner).createDesign(1, "SWAT Doge", 300, E("40"), 0);
      await expect(nft.connect(alice).mint(1, 1, { value: E("40") })).to.be.revertedWith("public mint closed");
      await nft.connect(owner).setPublicMint(1, true);
      await nft.connect(alice).mint(1, 1, { value: E("40") });
      expect(await nft.balanceOf(alice.address, 1)).to.equal(1);
      await nft.connect(owner).setPublicMint(1, false);
      await expect(nft.connect(alice).mint(1, 1, { value: E("40") })).to.be.revertedWith("public mint closed");
    });

    it("a price-0 design can never be minted publicly", async function () {
      const { owner, alice, nft } = await deployFixture();
      await nft.connect(owner).createDesign(1, "Giveaway Doge", 500, 0, 500);
      await expect(nft.connect(owner).setPublicMint(1, true)).to.be.revertedWith("set a price first");
      await expect(nft.connect(alice).mint(1, 500)).to.be.revertedWith("public mint closed");
    });

    it("setting the price to 0 closes an open sale", async function () {
      const { owner, alice, nft } = await withOpenDesign();
      await nft.connect(owner).setPrice(1, 0);
      expect((await nft.designs(1)).publicMintOpen).to.equal(false);
      await expect(nft.connect(alice).mint(1, 1)).to.be.revertedWith("public mint closed");
    });

    it("mints for exactly the price and counts it", async function () {
      const { alice, nft } = await withOpenDesign();
      await expect(nft.connect(alice).mint(1, 3, { value: E("119") })).to.be.revertedWith("incorrect payment");
      await expect(nft.connect(alice).mint(1, 0)).to.be.revertedWith("cannot mint 0");
      await expect(nft.connect(alice).mint(1, 3, { value: E("120") }))
        .to.emit(nft, "Minted")
        .withArgs(1, alice.address, 3);
      expect((await nft.designs(1)).minted).to.equal(3);
      await expect(nft.connect(alice).mint(9, 1, { value: E("40") })).to.be.revertedWith("no such design");
    });

    it("public mints can't eat into the giveaway reserve", async function () {
      const { alice, nft } = await withOpenDesign();
      await ethers.provider.send("hardhat_setBalance", [alice.address, ethers.toQuantity(E("100000"))]);
      expect(await nft.publicSupplyLeft(1)).to.equal(280);
      await expect(nft.connect(alice).mint(1, 281, { value: E("40") * 281n })).to.be.revertedWith(
        "exceeds max supply"
      );
      await nft.connect(alice).mint(1, 280, { value: E("40") * 280n });
      expect(await nft.publicSupplyLeft(1)).to.equal(0);
    });
  });

  describe("owner mints and the reserve", function () {
    it("the owner mints free, but only from the reserve", async function () {
      const { owner, bob, nft } = await withOpenDesign();
      await nft.connect(owner).ownerMint(1, bob.address, 20);
      expect(await nft.balanceOf(bob.address, 1)).to.equal(20);
      await expect(nft.connect(owner).ownerMint(1, bob.address, 1)).to.be.revertedWith("exceeds the reserve");
      await expect(nft.connect(bob).ownerMint(1, bob.address, 1)).to.be.revertedWithCustomError(
        nft,
        "OwnableUnauthorizedAccount"
      );
    });

    it("unused reserve can be released to the public, never grown", async function () {
      const { owner, nft } = await withOpenDesign();
      await nft.connect(owner).ownerMint(1, owner.address, 5);
      await expect(nft.connect(owner).releaseReserve(1, 16)).to.be.revertedWith("more than the unused reserve");
      await nft.connect(owner).releaseReserve(1, 15);
      expect(await nft.publicSupplyLeft(1)).to.equal(295);
      await expect(nft.connect(owner).ownerMint(1, owner.address, 1)).to.be.revertedWith("exceeds the reserve");
    });

    it("an airdrop skips recipients that can't take the NFT instead of failing", async function () {
      const { owner, alice, bob, nft } = await withOpenDesign();
      const noHooks = await (await ethers.getContractFactory("MockERC20")).deploy("No", "HOOKS");
      await expect(nft.connect(owner).ownerMintBatch(1, [alice.address, await noHooks.getAddress(), bob.address], [1, 1, 2]))
        .to.emit(nft, "AirdropSkipped")
        .withArgs(1, await noHooks.getAddress(), 1);
      expect(await nft.balanceOf(alice.address, 1)).to.equal(1);
      expect(await nft.balanceOf(bob.address, 1)).to.equal(2);
      expect((await nft.designs(1)).ownerMinted).to.equal(3);
      await expect(nft.connect(owner).mintForBatch(1, owner.address, 1)).to.be.revertedWith("internal");
    });
  });

  describe("supply and price", function () {
    it("the cap can grow until locked, never shrink", async function () {
      const { owner, nft } = await withOpenDesign();
      await expect(nft.connect(owner).increaseSupply(1, 300)).to.be.revertedWith("can only increase max supply");
      await nft.connect(owner).increaseSupply(1, 400);
      await nft.connect(owner).lockSupply(1);
      await expect(nft.connect(owner).increaseSupply(1, 500)).to.be.revertedWith("supply is locked");
      expect((await nft.designs(1)).supplyLocked).to.equal(true);
    });

    it("prices follow the same unit rules", async function () {
      const { owner, nft } = await withOpenDesign();
      await expect(nft.connect(owner).setPrice(1, 40_000_000n)).to.be.revertedWith(
        "price below 0.01 USDC (prices use 18 decimals)"
      );
      await expect(nft.connect(owner).setPrice(1, E("45")))
        .to.emit(nft, "DesignPriceUpdated")
        .withArgs(1, E("45"));
    });
  });

  describe("metadata", function () {
    it("resolves uri(id) for designs that exist", async function () {
      const { nft } = await withOpenDesign();
      expect(await nft.uri(1)).to.equal("https://example.test/metadata/1.json");
      await expect(nft.uri(2)).to.be.revertedWith("no such design");
    });

    it("tells marketplaces to refresh on a URI change, and can be frozen", async function () {
      const { owner, nft } = await withOpenDesign();
      await expect(nft.connect(owner).setURI("ipfs://bafy/")).to.emit(nft, "BatchMetadataUpdate").withArgs(1, 1);
      expect(await nft.uri(1)).to.equal("ipfs://bafy/1.json");
      await nft.connect(owner).freezeMetadata();
      await expect(nft.connect(owner).setURI("https://evil.example/")).to.be.revertedWith("metadata is frozen");
    });
  });

  describe("revenue", function () {
    it("anyone can send mint revenue to the treasury, and only there", async function () {
      const { owner, alice, treasury, stranger, nft } = await withOpenDesign();
      await nft.connect(alice).mint(1, 2, { value: E("80") });
      const before = await ethers.provider.getBalance(treasury.address);
      await nft.connect(stranger).withdraw();
      expect((await ethers.provider.getBalance(treasury.address)) - before).to.equal(E("80"));
      await expect(nft.connect(stranger).withdraw()).to.be.revertedWith("nothing to withdraw");
      await expect(nft.connect(stranger).setTreasury(stranger.address)).to.be.revertedWithCustomError(
        nft,
        "OwnableUnauthorizedAccount"
      );
      await expect(nft.connect(owner).setTreasury(ethers.ZeroAddress)).to.be.revertedWith("treasury is zero address");
    });

    it("ownership moves in two steps and can't be renounced", async function () {
      const { owner, alice, nft } = await deployFixture();
      await expect(nft.connect(owner).renounceOwnership()).to.be.revertedWith("renounce disabled");
      await nft.connect(owner).transferOwnership(alice.address);
      await nft.connect(alice).acceptOwnership();
      expect(await nft.owner()).to.equal(alice.address);
    });
  });

  describe("standard ERC-1155 behaviour", function () {
    it("transfers between wallets and reports its interfaces", async function () {
      const { alice, bob, nft } = await withOpenDesign();
      await nft.connect(alice).mint(1, 2, { value: E("80") });
      await nft.connect(alice).safeTransferFrom(alice.address, bob.address, 1, 1, "0x");
      expect(await nft.balanceOf(bob.address, 1)).to.equal(1);
      expect(await nft.supportsInterface("0xd9b67a26")).to.equal(true); // ERC-1155
    });
  });
});
