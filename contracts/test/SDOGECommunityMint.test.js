const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const DEAD = "0x000000000000000000000000000000000000dEaD";
const MAX = ethers.MaxUint256;

async function deployFixture() {
  const [owner, alice, bob, stranger] = await ethers.getSigners();
  const sdoge = await (await ethers.getContractFactory("MockERC20")).deploy("Stable Doge", "SDOGE");
  const nft = await (await ethers.getContractFactory("SDOGECommunityMint")).deploy(
    await sdoge.getAddress(),
    owner.address
  );
  for (const u of [alice, bob]) {
    await sdoge.mint(u.address, E("10000000"));
    await sdoge.connect(u).approve(await nft.getAddress(), E("1000000"));
  }
  return { owner, alice, bob, stranger, sdoge, nft };
}

describe("SDOGECommunityMint", function () {
  describe("deployment", function () {
    it("sets the token, owner and the 1,000,000 SDOGE default burn", async function () {
      const { owner, sdoge, nft } = await deployFixture();
      expect(await nft.sdoge()).to.equal(await sdoge.getAddress());
      expect(await nft.owner()).to.equal(owner.address);
      expect(await nft.burnAmount()).to.equal(E("1000000"));
      expect(await nft.name()).to.equal("SDOGE Community Art");
    });

    it("refuses a token with no code or without 18 decimals", async function () {
      const { owner } = await deployFixture();
      const F = await ethers.getContractFactory("SDOGECommunityMint");
      await expect(F.deploy(owner.address, owner.address)).to.be.revertedWith("token has no code");
      const six = await (await ethers.getContractFactory("MockToken6")).deploy();
      await expect(F.deploy(await six.getAddress(), owner.address)).to.be.revertedWith("token must have 18 decimals");
    });
  });

  describe("minting", function () {
    it("burns the SDOGE to dEaD, mints the NFT with its URI, and emits Minted", async function () {
      const { alice, sdoge, nft } = await deployFixture();
      await expect(nft.connect(alice).mint("ipfs://bafy/alice.json", E("1000000")))
        .to.emit(nft, "Minted")
        .withArgs(1, alice.address, "ipfs://bafy/alice.json", E("1000000"));
      expect(await nft.ownerOf(1)).to.equal(alice.address);
      expect(await nft.tokenURI(1)).to.equal("ipfs://bafy/alice.json");
      expect(await sdoge.balanceOf(DEAD)).to.equal(E("1000000"));
      expect(await sdoge.balanceOf(await nft.getAddress())).to.equal(0);
    });

    it("assigns sequential ids", async function () {
      const { alice, bob, nft } = await deployFixture();
      await nft.connect(alice).mint("ipfs://a", MAX);
      await nft.connect(bob).mint("ipfs://b", MAX);
      expect(await nft.ownerOf(2)).to.equal(bob.address);
      expect(await nft.nextTokenId()).to.equal(3);
    });

    it("never charges more than the caller's limit", async function () {
      const { owner, alice, sdoge, nft } = await deployFixture();
      await sdoge.mint(alice.address, E("50000000"));
      await sdoge.connect(alice).approve(await nft.getAddress(), MAX); // even with a max approval
      await nft.connect(owner).setBurnAmount(E("50000000"));
      await expect(nft.connect(alice).mint("ipfs://a", E("1000000"))).to.be.revertedWith(
        "burn amount is above your limit"
      );
      const before = await sdoge.balanceOf(alice.address);
      await nft.connect(alice).mint("ipfs://a", E("50000000"));
      expect(before - (await sdoge.balanceOf(alice.address))).to.equal(E("50000000"));
    });

    it("only accepts well-formed URIs (printable ASCII, no spaces, up to 512 bytes)", async function () {
      const { alice, nft } = await deployFixture();
      const bad = "uri must be printable ASCII without spaces";
      await expect(nft.connect(alice).mint("", MAX)).to.be.revertedWith("uri must be 1-512 bytes");
      await expect(nft.connect(alice).mint("ipfs://has space", MAX)).to.be.revertedWith(bad);
      await expect(nft.connect(alice).mint("ipfs://ünicode", MAX)).to.be.revertedWith(bad);
      await expect(nft.connect(alice).mint("ipfs://x‮", MAX)).to.be.revertedWith(bad); // bidi override
      await expect(nft.connect(alice).mint("ipfs://x\n", MAX)).to.be.revertedWith(bad);
      // invalid UTF-8 sent as raw calldata
      const data = nft.interface.encodeFunctionData("mint", ["ipfs://x", MAX]).replace(
        "697066733a2f2f78", // "ipfs://x"
        "fffe66733a2f2f78"
      );
      await expect(alice.sendTransaction({ to: await nft.getAddress(), data })).to.be.revertedWith(bad);
      await expect(nft.connect(alice).mint("ipfs://" + "a".repeat(506), MAX)).to.be.revertedWith(
        "uri must be 1-512 bytes"
      );
      await nft.connect(alice).mint("ipfs://" + "a".repeat(505), MAX);
    });

    it("reverts without enough approval or balance", async function () {
      const { stranger, sdoge, nft } = await deployFixture();
      await expect(nft.connect(stranger).mint("ipfs://a", MAX)).to.be.reverted;
      await sdoge.connect(stranger).approve(await nft.getAddress(), MAX);
      await expect(nft.connect(stranger).mint("ipfs://a", MAX)).to.be.reverted;
      expect(await nft.nextTokenId()).to.equal(1);
    });

    it("the URI is set before the receiver hook runs", async function () {
      const { sdoge, nft } = await deployFixture();
      const reader = await (await ethers.getContractFactory("UriReadingReceiver")).deploy();
      await sdoge.mint(await reader.getAddress(), E("1000000"));
      await reader.mintVia(await nft.getAddress(), await sdoge.getAddress(), "ipfs://bafy/seen.json");
      expect(await reader.seenUri()).to.equal("ipfs://bafy/seen.json");
    });

    it("blocks a reentrant mint() from the ERC-721 receive hook", async function () {
      const { sdoge, nft } = await deployFixture();
      const attacker = await (await ethers.getContractFactory("ReentrantMinter")).deploy();
      const a = await attacker.getAddress();
      await attacker.setTarget(await nft.getAddress());
      await sdoge.mint(a, E("10000000"));
      await attacker.approveToken(await sdoge.getAddress(), await nft.getAddress());
      await expect(attacker.attackMint("ipfs://first.json")).to.be.revertedWithCustomError(
        nft,
        "ReentrancyGuardReentrantCall"
      );
      expect(await nft.nextTokenId()).to.equal(1);
    });
  });

  describe("setBurnAmount", function () {
    it("lets the owner change it within 1,000-100,000,000 SDOGE", async function () {
      const { owner, nft } = await deployFixture();
      await expect(nft.connect(owner).setBurnAmount(E("2000000")))
        .to.emit(nft, "BurnAmountUpdated")
        .withArgs(E("1000000"), E("2000000"));
      await expect(nft.connect(owner).setBurnAmount(2_000_000n)).to.be.revertedWith("burn amount out of range"); // no decimals
      await expect(nft.connect(owner).setBurnAmount(E("999"))).to.be.revertedWith("burn amount out of range");
      await expect(nft.connect(owner).setBurnAmount(E("100000001"))).to.be.revertedWith("burn amount out of range");
      await expect(nft.connect(owner).setBurnAmount(MAX)).to.be.revertedWith("burn amount out of range");
    });

    it("only the owner can change it; ownership is two-step and can't be renounced", async function () {
      const { owner, alice, nft } = await deployFixture();
      await expect(nft.connect(alice).setBurnAmount(E("2000000"))).to.be.revertedWithCustomError(
        nft,
        "OwnableUnauthorizedAccount"
      );
      await expect(nft.connect(owner).renounceOwnership()).to.be.revertedWith("renounce disabled");
      await nft.connect(owner).transferOwnership(alice.address);
      await nft.connect(alice).acceptOwnership();
      expect(await nft.owner()).to.equal(alice.address);
    });

    it("the owner can't move or change anyone's NFT", async function () {
      const { owner, alice, nft } = await deployFixture();
      await nft.connect(alice).mint("ipfs://a", MAX);
      await expect(nft.connect(owner).transferFrom(alice.address, owner.address, 1)).to.be.revertedWithCustomError(
        nft,
        "ERC721InsufficientApproval"
      );
    });
  });
});
