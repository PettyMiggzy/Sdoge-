const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployStudio, newCollection } = require("./helpers/studio");

const E = (n) => ethers.parseEther(String(n));
const bal = (a) => ethers.provider.getBalance(a);

// Alice runs a project: her own collection, 1,000 credits bought with the 100 USDC package.
async function deployFixture() {
  const [owner, alice, bob, carol, treasury, stranger] = await ethers.getSigners();
  const sdoge = await (await ethers.getContractFactory("MockERC20")).deploy("Stable Doge", "SDOGE");
  const { studio } = await deployStudio(owner, sdoge, treasury);
  const club = await newCollection(studio, alice);
  await studio.connect(alice).buyCredits(3, 1000, alice.address, { value: E("100") });
  return { owner, alice, bob, carol, treasury, stranger, sdoge, studio, club };
}

// ...with a public drop: 2 USDC each, 3 per wallet, open now.
async function withDrop() {
  const f = await deployFixture();
  await f.club.connect(f.alice).setBaseURI("ipfs://bafy/club/", ".json");
  await f.club.connect(f.alice).setDrop(E("2"), 3, 0, 0);
  await f.club.connect(f.alice).setDropOpen(true);
  return f;
}

describe("SDOGEStudioCollection", function () {
  describe("owner mints (one credit each)", function () {
    it("mintBatch mints base-URI tokens and spends the owner's credits", async function () {
      const f = await deployFixture();
      await expect(f.club.connect(f.alice).mintBatch(f.bob.address, 200))
        .to.emit(f.studio, "CreditsSpent")
        .withArgs(f.alice.address, await f.club.getAddress(), 200);
      expect(await f.club.balanceOf(f.bob.address)).to.equal(200);
      expect(await f.club.ownerOf(200)).to.equal(f.bob.address);
      expect(await f.club.totalSupply()).to.equal(200);
      expect(await f.studio.credits(f.alice.address)).to.equal(800);
      await expect(f.club.connect(f.alice).mintBatch(f.bob.address, 201)).to.be.revertedWith("batch too large");
      await expect(f.club.connect(f.alice).mintBatch(f.bob.address, 0)).to.be.revertedWith("cannot mint 0");
    });

    it("mintWithURIs gives each token its own permanent URI", async function () {
      const f = await deployFixture();
      await f.club.connect(f.alice).mintWithURIs(f.alice.address, ["ipfs://bafy/a.json", "ipfs://bafy/b.json"]);
      expect(await f.club.tokenURI(1)).to.equal("ipfs://bafy/a.json");
      expect(await f.club.tokenURI(2)).to.equal("ipfs://bafy/b.json");
      await f.club.connect(f.alice).setBaseURI("ipfs://bafy/other/", ".json");
      expect(await f.club.tokenURI(1)).to.equal("ipfs://bafy/a.json"); // a base URI change never touches them
      expect(await f.studio.credits(f.alice.address)).to.equal(998);
      await expect(f.club.connect(f.alice).mintWithURIs(f.alice.address, ["ipfs://ok", "bad uri"])).to.be.revertedWith(
        "uri must be 1-512 printable ASCII characters, no spaces"
      );
      await expect(
        f.club.connect(f.alice).mintWithURIs(f.alice.address, Array(101).fill("ipfs://x"))
      ).to.be.revertedWith("batch too large");
    });

    it("airdrop sends one token to each recipient, even ones without receiver hooks", async function () {
      const f = await deployFixture();
      const noHooks = await (await ethers.getContractFactory("RevertingReceiver")).deploy();
      await f.club.connect(f.alice).airdrop([f.bob.address, f.carol.address, await noHooks.getAddress()]);
      expect(await f.club.ownerOf(1)).to.equal(f.bob.address);
      expect(await f.club.ownerOf(3)).to.equal(await noHooks.getAddress());
      await expect(f.club.connect(f.alice).airdrop([ethers.ZeroAddress])).to.be.revertedWithCustomError(
        f.club,
        "ERC721InvalidReceiver"
      );
    });

    it("needs enough credits, and only the owner mints", async function () {
      const f = await deployFixture();
      const empty = await newCollection(f.studio, f.bob, { name: "Bob Club", symbol: "BOB" });
      await expect(empty.connect(f.bob).mintBatch(f.bob.address, 1)).to.be.revertedWith("not enough mint credits");
      await expect(f.club.connect(f.bob).mintBatch(f.bob.address, 1)).to.be.revertedWithCustomError(
        f.club,
        "OwnableUnauthorizedAccount"
      );
      await f.club.connect(f.alice).mintBatch(f.alice.address, 200);
      await f.club.connect(f.alice).mintBatch(f.alice.address, 200);
      await f.club.connect(f.alice).mintBatch(f.alice.address, 200);
      await f.club.connect(f.alice).mintBatch(f.alice.address, 200);
      await f.club.connect(f.alice).mintBatch(f.alice.address, 200);
      expect(await f.club.totalSupply()).to.equal(1000); // the whole 100 USDC package
      await expect(f.club.connect(f.alice).mintBatch(f.alice.address, 1)).to.be.revertedWith("not enough mint credits");
    });
  });

  describe("supply cap", function () {
    it("can be set once, then only lowered, never below what's minted", async function () {
      const f = await deployFixture();
      await f.club.connect(f.alice).mintBatch(f.alice.address, 10);
      await expect(f.club.connect(f.alice).setMaxSupply(9)).to.be.revertedWith("cap below what's minted");
      await expect(f.club.connect(f.alice).setMaxSupply(0)).to.be.revertedWith("cap below what's minted");
      await expect(f.club.connect(f.alice).setMaxSupply(100)).to.emit(f.club, "MaxSupplySet").withArgs(100);
      await expect(f.club.connect(f.alice).setMaxSupply(101)).to.be.revertedWith("the cap can only go down");
      await f.club.connect(f.alice).setMaxSupply(12);
      await expect(f.club.connect(f.alice).mintBatch(f.alice.address, 3)).to.be.revertedWith("exceeds max supply");
      await f.club.connect(f.alice).mintBatch(f.alice.address, 2);
      expect(await f.studio.credits(f.alice.address)).to.equal(988); // the failed mint cost nothing
    });

    it("a cap given at creation holds from the start", async function () {
      const f = await deployFixture();
      const capped = await newCollection(f.studio, f.alice, { name: "Ten", symbol: "TEN", maxSupply: 10 });
      await expect(capped.connect(f.alice).mintBatch(f.alice.address, 11)).to.be.revertedWith("exceeds max supply");
      await capped.connect(f.alice).mintBatch(f.alice.address, 10);
    });
  });

  describe("metadata", function () {
    it("base-URI tokens resolve to base + id + suffix; unknown ids revert", async function () {
      const f = await deployFixture();
      await f.club.connect(f.alice).mintBatch(f.alice.address, 2);
      expect(await f.club.tokenURI(1)).to.equal(""); // not revealed yet
      await expect(f.club.connect(f.alice).setBaseURI("ipfs://bafy/club/", ".json"))
        .to.emit(f.club, "BatchMetadataUpdate")
        .withArgs(1, 2);
      expect(await f.club.tokenURI(2)).to.equal("ipfs://bafy/club/2.json");
      await expect(f.club.tokenURI(3)).to.be.revertedWithCustomError(f.club, "ERC721NonexistentToken");
    });

    it("validates URIs and freezes for good", async function () {
      const f = await deployFixture();
      await expect(f.club.connect(f.alice).setBaseURI("", "")).to.be.revertedWith(
        "uri must be 1-512 printable ASCII characters, no spaces"
      );
      await expect(f.club.connect(f.alice).setBaseURI("ipfs://x/", "a b")).to.be.revertedWith("bad suffix");
      await expect(f.club.connect(f.alice).setContractURI("ipfs://bafy/c.json")).to.emit(f.club, "ContractURIUpdated");
      await f.club.connect(f.alice).freezeMetadata();
      await expect(f.club.connect(f.alice).setBaseURI("ipfs://y/", "")).to.be.revertedWith("metadata is frozen");
      await expect(f.club.connect(f.alice).setContractURI("ipfs://y")).to.be.revertedWith("metadata is frozen");
      expect(await f.club.metadataFrozen()).to.equal(true);
    });
  });

  describe("royalties", function () {
    it("report ERC-2981, capped at 10%, and can be removed", async function () {
      const f = await deployFixture();
      expect(await f.club.supportsInterface("0x2a55205a")).to.equal(true); // ERC-2981
      expect(await f.club.supportsInterface("0x80ac58cd")).to.equal(true); // ERC-721
      expect(await f.club.supportsInterface("0x49064906")).to.equal(true); // ERC-4906
      await expect(f.club.connect(f.alice).setRoyalty(f.carol.address, 1001)).to.be.revertedWith("royalty above 10%");
      await f.club.connect(f.alice).setRoyalty(f.carol.address, 1000);
      const [to, amount] = await f.club.royaltyInfo(1, E("50"));
      expect([to, amount]).to.deep.equal([f.carol.address, E("5")]);
      await f.club.connect(f.alice).setRoyalty(ethers.ZeroAddress, 0);
      const [, none] = await f.club.royaltyInfo(1, E("50"));
      expect(none).to.equal(0);
    });
  });

  describe("public drop", function () {
    it("collectors mint at the drop price; each mint uses one of the owner's credits", async function () {
      const f = await withDrop();
      await expect(f.club.connect(f.bob).publicMint(2, { value: E("4") }))
        .to.emit(f.club, "PublicMint")
        .withArgs(f.bob.address, 1, 2, E("4"));
      expect(await f.club.balanceOf(f.bob.address)).to.equal(2);
      expect(await f.club.tokenURI(2)).to.equal("ipfs://bafy/club/2.json");
      expect(await f.studio.credits(f.alice.address)).to.equal(998);
      expect(await f.club.publicMinted(f.bob.address)).to.equal(2);
      expect(await bal(await f.club.getAddress())).to.equal(E("4"));
    });

    it("requires the exact payment and a sane quantity", async function () {
      const f = await withDrop();
      await expect(f.club.connect(f.bob).publicMint(1, { value: E("1.99") })).to.be.revertedWith("incorrect payment");
      await expect(f.club.connect(f.bob).publicMint(0)).to.be.revertedWith("mint 1-20 at a time");
      await expect(f.club.connect(f.bob).publicMint(21, { value: E("42") })).to.be.revertedWith("mint 1-20 at a time");
    });

    it("enforces the wallet limit and the supply cap", async function () {
      const f = await withDrop();
      await f.club.connect(f.bob).publicMint(3, { value: E("6") });
      await expect(f.club.connect(f.bob).publicMint(1, { value: E("2") })).to.be.revertedWith("wallet limit reached");
      await f.club.connect(f.alice).setMaxSupply(4);
      await expect(f.club.connect(f.carol).publicMint(2, { value: E("4") })).to.be.revertedWith("exceeds max supply");
      await f.club.connect(f.carol).publicMint(1, { value: E("2") });
    });

    it("stops when the owner runs out of credits", async function () {
      const f = await withDrop();
      await f.club.connect(f.alice).mintBatch(f.alice.address, 200);
      await f.club.connect(f.alice).mintBatch(f.alice.address, 200);
      await f.club.connect(f.alice).mintBatch(f.alice.address, 200);
      await f.club.connect(f.alice).mintBatch(f.alice.address, 200);
      await f.club.connect(f.alice).mintBatch(f.alice.address, 199);
      await f.club.connect(f.bob).publicMint(1, { value: E("2") }); // the last credit
      await expect(f.club.connect(f.carol).publicMint(1, { value: E("2") })).to.be.revertedWith("not enough mint credits");
    });

    it("respects open/closed and the start and end times", async function () {
      const f = await deployFixture();
      await expect(f.club.connect(f.alice).setDropOpen(true)).to.be.revertedWith("set a base URI first");
      await f.club.connect(f.alice).setBaseURI("ipfs://bafy/club/", "");
      const now = await time.latest();
      await f.club.connect(f.alice).setDrop(E("1"), 0, now + 100, now + 200);
      await expect(f.club.connect(f.bob).publicMint(1, { value: E("1") })).to.be.revertedWith("drop is closed");
      await f.club.connect(f.alice).setDropOpen(true);
      await expect(f.club.connect(f.bob).publicMint(1, { value: E("1") })).to.be.revertedWith("drop hasn't started");
      await time.increaseTo(now + 100);
      await f.club.connect(f.bob).publicMint(1, { value: E("1") });
      await time.increaseTo(now + 200);
      await expect(f.club.connect(f.bob).publicMint(1, { value: E("1") })).to.be.revertedWith("drop has ended");
    });

    it("validates the drop terms", async function () {
      const f = await deployFixture();
      const set = (...a) => f.club.connect(f.alice).setDrop(...a);
      const price = "price must be 0 or 0.01-1,000,000 USDC in whole micro-USDC (18 decimals)";
      await expect(set(2_000_000n, 0, 0, 0)).to.be.revertedWith(price); // "2 USDC" in 6 decimals
      await expect(set(E("2") + 1n, 0, 0, 0)).to.be.revertedWith(price);
      await expect(set(E("1000001"), 0, 0, 0)).to.be.revertedWith(price);
      await expect(set(E("1"), 0, 200, 100)).to.be.revertedWith("end must be after start");
      await expect(set(E("1"), 2n ** 32n, 0, 0)).to.be.revertedWith("wallet limit too large");
      await expect(set(E("1"), 0, 2n ** 40n, 0)).to.be.revertedWith("time out of range");
      await expect(f.club.connect(f.bob).setDrop(E("1"), 0, 0, 0)).to.be.revertedWithCustomError(
        f.club,
        "OwnableUnauthorizedAccount"
      );
    });

    it("a free drop: collectors pay nothing, the owner's credits still pay the platform", async function () {
      const f = await deployFixture();
      await f.club.connect(f.alice).setBaseURI("ipfs://bafy/club/", "");
      await f.club.connect(f.alice).setDrop(0, 1, 0, 0);
      await f.club.connect(f.alice).setDropOpen(true);
      await f.club.connect(f.bob).publicMint(1);
      expect(await f.studio.credits(f.alice.address)).to.equal(999);
    });

    it("contract minters need the receiver hook, and can't re-enter", async function () {
      const f = await withDrop();
      const noHooks = await (await ethers.getContractFactory("RevertingReceiver")).deploy();
      const attacker = await (await ethers.getContractFactory("ReentrantMinter")).deploy();
      await attacker.setTarget(await f.club.getAddress(), 2);
      await expect(attacker.attackDrop(1, { value: E("2") })).to.be.revertedWithCustomError(
        f.club,
        "ReentrancyGuardReentrantCall"
      );
      expect(await f.club.totalSupply()).to.equal(0);
      // a contract without onERC721Received can't take a drop token
      const signer = await ethers.getImpersonatedSigner(await noHooks.getAddress());
      await ethers.provider.send("hardhat_setBalance", [await noHooks.getAddress(), ethers.toQuantity(E("10"))]);
      await expect(f.club.connect(signer).publicMint(1, { value: E("2") })).to.be.revertedWithCustomError(
        f.club,
        "ERC721InvalidReceiver"
      );
    });
  });

  describe("sales payout", function () {
    it("anyone can send drop sales to the payout address", async function () {
      const f = await withDrop();
      await f.club.connect(f.bob).publicMint(3, { value: E("6") });
      await f.club.connect(f.alice).setPayout(f.carol.address);
      const before = await bal(f.carol.address);
      await expect(f.club.connect(f.stranger).withdraw()).to.emit(f.club, "Withdrawn").withArgs(f.carol.address, E("6"));
      expect((await bal(f.carol.address)) - before).to.equal(E("6"));
      await expect(f.club.withdraw()).to.be.revertedWith("nothing to withdraw");
      await expect(f.club.connect(f.alice).setPayout(ethers.ZeroAddress)).to.be.revertedWith("payout is zero address");
    });

    it("a payout address that refuses USDC can be replaced; nothing is lost", async function () {
      const f = await withDrop();
      const refuser = await (await ethers.getContractFactory("RevertingReceiver")).deploy();
      await f.club.connect(f.bob).publicMint(1, { value: E("2") });
      await f.club.connect(f.alice).setPayout(await refuser.getAddress());
      await expect(f.club.withdraw()).to.be.revertedWith("payout failed");
      await f.club.connect(f.alice).setPayout(f.alice.address);
      await f.club.withdraw();
      expect(await bal(await f.club.getAddress())).to.equal(0);
    });
  });

  describe("ownership", function () {
    it("moves in two steps; the new owner's credits pay from then on", async function () {
      const f = await withDrop();
      await f.club.connect(f.alice).transferOwnership(f.bob.address);
      await f.club.connect(f.carol).publicMint(1, { value: E("2") }); // still Alice's credits
      expect(await f.studio.credits(f.alice.address)).to.equal(999);
      await f.club.connect(f.bob).acceptOwnership();
      await expect(f.club.connect(f.carol).publicMint(1, { value: E("2") })).to.be.revertedWith("not enough mint credits");
      await f.studio.connect(f.bob).buyCredits(1, 10, f.bob.address, { value: E("20") });
      await f.club.connect(f.carol).publicMint(1, { value: E("2") });
      expect(await f.studio.credits(f.bob.address)).to.equal(9);
      await expect(f.club.connect(f.bob).renounceOwnership()).to.be.revertedWith("renounce disabled");
    });
  });
});
