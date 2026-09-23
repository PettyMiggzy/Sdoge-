const { expect } = require("chai");
const { ethers } = require("hardhat");

const BASE_URI = "https://example.com/sdoge-nft/metadata/";

async function deployFixture() {
  const [owner, alice, bob] = await ethers.getSigners();

  const Collectibles = await ethers.getContractFactory("SDOGECollectibles");
  const nft = await Collectibles.deploy(owner.address, BASE_URI);

  return { owner, alice, bob, nft };
}

describe("SDOGECollectibles", function () {
  describe("creating designs", function () {
    it("creates a design with the given name, max supply, and price", async function () {
      const { owner, nft } = await deployFixture();

      await expect(nft.connect(owner).createDesign("SWAT Doge", 100, ethers.parseEther("5")))
        .to.emit(nft, "DesignCreated")
        .withArgs(1, "SWAT Doge", 100, ethers.parseEther("5"));

      const d = await nft.designs(1);
      expect(d.name).to.equal("SWAT Doge");
      expect(d.maxSupply).to.equal(100);
      expect(d.minted).to.equal(0);
      expect(d.priceWei).to.equal(ethers.parseEther("5"));
      expect(d.exists).to.equal(true);
    });

    it("assigns sequential design IDs", async function () {
      const { owner, nft } = await deployFixture();
      await nft.connect(owner).createDesign("SWAT Doge", 100, 0);
      await nft.connect(owner).createDesign("Space Doge", 50, 0);
      expect((await nft.designs(1)).name).to.equal("SWAT Doge");
      expect((await nft.designs(2)).name).to.equal("Space Doge");
    });

    it("rejects a max supply of 0", async function () {
      const { owner, nft } = await deployFixture();
      await expect(nft.connect(owner).createDesign("Broken Doge", 0, 0)).to.be.revertedWith(
        "max supply must be > 0"
      );
    });

    it("only the owner can create a design", async function () {
      const { alice, nft } = await deployFixture();
      await expect(nft.connect(alice).createDesign("Rogue Doge", 100, 0)).to.be.revertedWithCustomError(
        nft,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("minting", function () {
    it("mints for the correct native USDC payment and tracks minted count", async function () {
      const { owner, alice, nft } = await deployFixture();
      await nft.connect(owner).createDesign("SWAT Doge", 100, ethers.parseEther("5"));

      await nft.connect(alice).mint(1, 3, { value: ethers.parseEther("15") });

      expect(await nft.balanceOf(alice.address, 1)).to.equal(3);
      expect((await nft.designs(1)).minted).to.equal(3);
      expect(await nft.remainingSupply(1)).to.equal(97);
    });

    it("rejects incorrect payment", async function () {
      const { owner, alice, nft } = await deployFixture();
      await nft.connect(owner).createDesign("SWAT Doge", 100, ethers.parseEther("5"));

      await expect(
        nft.connect(alice).mint(1, 2, { value: ethers.parseEther("5") }) // should be 10
      ).to.be.revertedWith("incorrect payment");
    });

    it("rejects minting 0 or past max supply", async function () {
      const { owner, alice, nft } = await deployFixture();
      await nft.connect(owner).createDesign("Limited Doge", 2, 0);

      await expect(nft.connect(alice).mint(1, 0)).to.be.revertedWith("cannot mint 0");
      await expect(nft.connect(alice).mint(1, 3)).to.be.revertedWith("exceeds max supply");

      await nft.connect(alice).mint(1, 2);
      await expect(nft.connect(alice).mint(1, 1)).to.be.revertedWith("exceeds max supply");
    });

    it("rejects minting a design that doesn't exist", async function () {
      const { alice, nft } = await deployFixture();
      await expect(nft.connect(alice).mint(999, 1)).to.be.revertedWith("no such design");
    });

    it("lets the owner mint for free, still bounded by max supply", async function () {
      const { owner, alice, nft } = await deployFixture();
      await nft.connect(owner).createDesign("Giveaway Doge", 5, ethers.parseEther("10"));

      await nft.connect(owner).ownerMint(1, alice.address, 5);
      expect(await nft.balanceOf(alice.address, 1)).to.equal(5);

      await expect(nft.connect(owner).ownerMint(1, alice.address, 1)).to.be.revertedWith(
        "exceeds max supply"
      );
    });

    it("only the owner can call ownerMint", async function () {
      const { owner, alice, bob, nft } = await deployFixture();
      await nft.connect(owner).createDesign("SWAT Doge", 100, 0);
      await expect(nft.connect(alice).ownerMint(1, bob.address, 1)).to.be.revertedWithCustomError(
        nft,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("supply and price management", function () {
    it("lets the owner increase (never decrease) a design's max supply", async function () {
      const { owner, nft } = await deployFixture();
      await nft.connect(owner).createDesign("SWAT Doge", 100, 0);

      await expect(nft.connect(owner).increaseSupply(1, 200))
        .to.emit(nft, "DesignSupplyIncreased")
        .withArgs(1, 200);
      expect((await nft.designs(1)).maxSupply).to.equal(200);

      await expect(nft.connect(owner).increaseSupply(1, 200)).to.be.revertedWith(
        "can only increase max supply"
      );
      await expect(nft.connect(owner).increaseSupply(1, 50)).to.be.revertedWith(
        "can only increase max supply"
      );
    });

    it("rejects increasing supply for a design that doesn't exist", async function () {
      const { owner, nft } = await deployFixture();
      await expect(nft.connect(owner).increaseSupply(999, 100)).to.be.revertedWith("no such design");
    });

    it("only the owner can increase supply", async function () {
      const { owner, alice, nft } = await deployFixture();
      await nft.connect(owner).createDesign("SWAT Doge", 100, 0);
      await expect(nft.connect(alice).increaseSupply(1, 200)).to.be.revertedWithCustomError(
        nft,
        "OwnableUnauthorizedAccount"
      );
    });

    it("lets the owner update a design's price", async function () {
      const { owner, nft } = await deployFixture();
      await nft.connect(owner).createDesign("SWAT Doge", 100, ethers.parseEther("5"));

      await expect(nft.connect(owner).setPrice(1, ethers.parseEther("10")))
        .to.emit(nft, "DesignPriceUpdated")
        .withArgs(1, ethers.parseEther("10"));
      expect((await nft.designs(1)).priceWei).to.equal(ethers.parseEther("10"));
    });

    it("only the owner can update price", async function () {
      const { owner, alice, nft } = await deployFixture();
      await nft.connect(owner).createDesign("SWAT Doge", 100, 0);
      await expect(nft.connect(alice).setPrice(1, ethers.parseEther("10"))).to.be.revertedWithCustomError(
        nft,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("admin: URI and withdrawals", function () {
    it("resolves uri(id) to <baseURI><id>.json", async function () {
      const { nft } = await deployFixture();
      expect(await nft.uri(1)).to.equal("https://example.com/sdoge-nft/metadata/1.json");
      expect(await nft.uri(42)).to.equal("https://example.com/sdoge-nft/metadata/42.json");
    });

    it("only the owner can update the base URI", async function () {
      const { owner, alice, nft } = await deployFixture();
      await expect(
        nft.connect(alice).setURI("https://new.example.com/metadata/")
      ).to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount");

      await nft.connect(owner).setURI("https://new.example.com/metadata/");
      expect(await nft.uri(1)).to.equal("https://new.example.com/metadata/1.json");
    });

    it("lets the owner withdraw accumulated native USDC to any address", async function () {
      const { owner, alice, nft } = await deployFixture();
      await nft.connect(owner).createDesign("SWAT Doge", 100, ethers.parseEther("5"));
      await nft.connect(alice).mint(1, 2, { value: ethers.parseEther("10") });

      const treasury = ethers.Wallet.createRandom().address;
      await nft.connect(owner).withdraw(treasury);
      expect(await ethers.provider.getBalance(treasury)).to.equal(ethers.parseEther("10"));
    });

    it("rejects withdrawing to the zero address, and from a non-owner", async function () {
      const { owner, alice, nft } = await deployFixture();
      await expect(nft.connect(owner).withdraw(ethers.ZeroAddress)).to.be.revertedWith(
        "cannot withdraw to zero address"
      );
      await expect(nft.connect(alice).withdraw(alice.address)).to.be.revertedWithCustomError(
        nft,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("standard ERC-1155 behavior", function () {
    it("supports transferring minted tokens between wallets", async function () {
      const { owner, alice, bob, nft } = await deployFixture();
      await nft.connect(owner).createDesign("SWAT Doge", 100, 0);
      await nft.connect(owner).ownerMint(1, alice.address, 3);

      await nft.connect(alice).safeTransferFrom(alice.address, bob.address, 1, 2, "0x");

      expect(await nft.balanceOf(alice.address, 1)).to.equal(1);
      expect(await nft.balanceOf(bob.address, 1)).to.equal(2);
    });

    it("reports the ERC-1155 interface via supportsInterface", async function () {
      const { nft } = await deployFixture();
      expect(await nft.supportsInterface("0xd9b67a26")).to.equal(true); // IERC1155
    });
  });
});
