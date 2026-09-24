const { expect } = require("chai");
const { ethers } = require("hardhat");

const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const DEFAULT_BURN_AMOUNT = ethers.parseEther("1000000");

async function deployFixture() {
  const [owner, alice, bob] = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const sdoge = await MockERC20.deploy("Mock SDOGE", "mSDOGE");

  const CommunityMint = await ethers.getContractFactory("SDOGECommunityMint");
  const nft = await CommunityMint.deploy(await sdoge.getAddress(), owner.address);

  // Fund alice/bob with plenty of SDOGE and pre-approve the mint contract,
  // since every real test here is about mint() itself, not allowance setup.
  for (const user of [alice, bob]) {
    await sdoge.mint(user.address, ethers.parseEther("10000000"));
    await sdoge.connect(user).approve(await nft.getAddress(), ethers.MaxUint256);
  }

  return { owner, alice, bob, sdoge, nft };
}

describe("SDOGECommunityMint", function () {
  describe("deployment", function () {
    it("sets the token, owner, and default burn amount", async function () {
      const { owner, sdoge, nft } = await deployFixture();
      expect(await nft.sdoge()).to.equal(await sdoge.getAddress());
      expect(await nft.owner()).to.equal(owner.address);
      expect(await nft.burnAmount()).to.equal(DEFAULT_BURN_AMOUNT);
      expect(await nft.name()).to.equal("SDOGE Community Art");
      expect(await nft.symbol()).to.equal("SDOGEART");
    });

    it("rejects the zero address as the token", async function () {
      const [owner] = await ethers.getSigners();
      const CommunityMint = await ethers.getContractFactory("SDOGECommunityMint");
      await expect(CommunityMint.deploy(ethers.ZeroAddress, owner.address)).to.be.revertedWith(
        "bad token address"
      );
    });
  });

  describe("minting", function () {
    it("burns the SDOGE, mints a unique NFT with the given URI, and emits Minted", async function () {
      const { alice, sdoge, nft } = await deployFixture();
      const uri = "ipfs://bafy.../alice-doge.json";

      const balanceBefore = await sdoge.balanceOf(alice.address);

      await expect(nft.connect(alice).mint(uri))
        .to.emit(nft, "Minted")
        .withArgs(1, alice.address, uri, DEFAULT_BURN_AMOUNT);

      expect(await sdoge.balanceOf(alice.address)).to.equal(balanceBefore - DEFAULT_BURN_AMOUNT);
      expect(await sdoge.balanceOf(BURN_ADDRESS)).to.equal(DEFAULT_BURN_AMOUNT);
      expect(await nft.ownerOf(1)).to.equal(alice.address);
      expect(await nft.tokenURI(1)).to.equal(uri);
    });

    it("assigns sequential token IDs across different minters", async function () {
      const { alice, bob, nft } = await deployFixture();
      await nft.connect(alice).mint("ipfs://one.json");
      await nft.connect(bob).mint("ipfs://two.json");
      await nft.connect(alice).mint("ipfs://three.json");

      expect(await nft.ownerOf(1)).to.equal(alice.address);
      expect(await nft.ownerOf(2)).to.equal(bob.address);
      expect(await nft.ownerOf(3)).to.equal(alice.address);
      expect(await nft.tokenURI(2)).to.equal("ipfs://two.json");
    });

    it("rejects an empty URI", async function () {
      const { alice, nft } = await deployFixture();
      await expect(nft.connect(alice).mint("")).to.be.revertedWith("empty uri");
    });

    it("reverts if the caller hasn't approved enough SDOGE", async function () {
      const { alice, sdoge, nft } = await deployFixture();
      await sdoge.connect(alice).approve(await nft.getAddress(), ethers.parseEther("1"));
      await expect(nft.connect(alice).mint("ipfs://x.json")).to.be.revertedWithCustomError(
        sdoge,
        "ERC20InsufficientAllowance"
      );
    });

    it("reverts if the caller doesn't have enough SDOGE, even with unlimited approval", async function () {
      const { owner, sdoge, nft } = await deployFixture();
      // owner never got any minted SDOGE in the fixture, but did not approve either -
      // approve first so the allowance check passes and the balance check is what fails.
      await sdoge.connect(owner).approve(await nft.getAddress(), ethers.MaxUint256);
      await expect(nft.connect(owner).mint("ipfs://x.json")).to.be.revertedWithCustomError(
        sdoge,
        "ERC20InsufficientBalance"
      );
    });

    it("charges whatever burnAmount is current at mint time", async function () {
      const { owner, alice, sdoge, nft } = await deployFixture();
      await nft.connect(owner).setBurnAmount(ethers.parseEther("500000"));

      const balanceBefore = await sdoge.balanceOf(alice.address);
      await nft.connect(alice).mint("ipfs://cheaper.json");
      expect(await sdoge.balanceOf(alice.address)).to.equal(balanceBefore - ethers.parseEther("500000"));
    });

    it("blocks a reentrant mint() call from the ERC-721 receive hook", async function () {
      const { sdoge, nft } = await deployFixture();

      const ReentrantMinter = await ethers.getContractFactory("ReentrantMinter");
      const attacker = await ReentrantMinter.deploy();
      const attackerAddr = await attacker.getAddress();

      await attacker.setTarget(await nft.getAddress());
      await sdoge.mint(attackerAddr, ethers.parseEther("10000000"));
      await attacker.approveToken(await sdoge.getAddress(), await nft.getAddress());

      // The outer mint() succeeds, but the reentrant call it triggers from
      // inside onERC721Received must hit nonReentrant and revert - which
      // reverts the whole outer transaction too (only one token ever mints).
      await expect(attacker.attackMint("ipfs://first.json")).to.be.reverted;
      expect(await nft.nextTokenId()).to.equal(1); // unchanged - nothing minted
    });
  });

  describe("setBurnAmount", function () {
    it("lets the owner update it and emits BurnAmountUpdated", async function () {
      const { owner, nft } = await deployFixture();
      await expect(nft.connect(owner).setBurnAmount(ethers.parseEther("2000000")))
        .to.emit(nft, "BurnAmountUpdated")
        .withArgs(DEFAULT_BURN_AMOUNT, ethers.parseEther("2000000"));
      expect(await nft.burnAmount()).to.equal(ethers.parseEther("2000000"));
    });

    it("rejects a zero amount", async function () {
      const { owner, nft } = await deployFixture();
      await expect(nft.connect(owner).setBurnAmount(0)).to.be.revertedWith("burn amount must be > 0");
    });

    it("only the owner can call it", async function () {
      const { alice, nft } = await deployFixture();
      await expect(nft.connect(alice).setBurnAmount(1)).to.be.revertedWithCustomError(
        nft,
        "OwnableUnauthorizedAccount"
      );
    });
  });
});
