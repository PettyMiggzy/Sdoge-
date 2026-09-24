const { expect } = require("chai");
const { ethers } = require("hardhat");

async function deployFixture() {
  const [owner, alice, bob, stranger] = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const sdoge = await MockERC20.deploy("Stable Doge", "SDOGE");

  const CommunityMint = await ethers.getContractFactory("SDOGECommunityMint");
  const communityMint = await CommunityMint.deploy(await sdoge.getAddress(), owner.address);

  const Collectibles = await ethers.getContractFactory("SDOGECollectibles");
  const collectibles = await Collectibles.deploy(owner.address, "https://example.test/metadata/");

  const Marketplace = await ethers.getContractFactory("SDOGENFTMarketplace");
  const marketplace = await Marketplace.deploy(owner.address);

  // Alice mints a real community-mint NFT (tokenId 1) by burning SDOGE - the
  // ERC-721 side of the marketplace.
  await sdoge.mint(alice.address, ethers.parseEther("10000000"));
  await sdoge.connect(alice).approve(await communityMint.getAddress(), ethers.MaxUint256);
  await communityMint.connect(alice).mint("ipfs://alice-art.json");

  // Bob mints 5 real copies of a collectibles design (designId 1) with
  // native USDC - the ERC-1155 side of the marketplace.
  await collectibles.connect(owner).createDesign("Test Doge", 100, ethers.parseEther("1"));
  await collectibles.connect(bob).mint(1, 5, { value: ethers.parseEther("5") });

  return { owner, alice, bob, stranger, sdoge, communityMint, collectibles, marketplace };
}

const communityMintAddr = async (c) => c.getAddress();

describe("SDOGENFTMarketplace", function () {
  describe("deployment", function () {
    it("sets the owner and sane defaults", async function () {
      const { owner, marketplace } = await deployFixture();
      expect(await marketplace.owner()).to.equal(owner.address);
      expect(await marketplace.feeBps()).to.equal(200);
      expect(await marketplace.rewardsPool()).to.equal(ethers.ZeroAddress);
      expect(await marketplace.nextListingId()).to.equal(1);
    });
  });

  describe("listERC721", function () {
    it("lists a token the caller owns and has approved, and emits Listed", async function () {
      const { alice, communityMint, marketplace } = await deployFixture();
      const nftAddr = await communityMintAddr(communityMint);
      await communityMint.connect(alice).approve(await marketplace.getAddress(), 1);

      await expect(marketplace.connect(alice).listERC721(nftAddr, 1, ethers.parseEther("10")))
        .to.emit(marketplace, "Listed")
        .withArgs(1, alice.address, nftAddr, 0, 1, 1, ethers.parseEther("10"));

      const listing = await marketplace.getListing(1);
      expect(listing.seller).to.equal(alice.address);
      expect(listing.amount).to.equal(1);
      expect(listing.active).to.equal(true);
    });

    it("also accepts a blanket setApprovalForAll instead of a per-token approve", async function () {
      const { alice, communityMint, marketplace } = await deployFixture();
      const nftAddr = await communityMintAddr(communityMint);
      await communityMint.connect(alice).setApprovalForAll(await marketplace.getAddress(), true);
      await expect(marketplace.connect(alice).listERC721(nftAddr, 1, ethers.parseEther("10"))).to.not.be.reverted;
    });

    it("reverts if the caller doesn't own the token", async function () {
      const { bob, communityMint, marketplace } = await deployFixture();
      const nftAddr = await communityMintAddr(communityMint);
      await expect(
        marketplace.connect(bob).listERC721(nftAddr, 1, ethers.parseEther("10"))
      ).to.be.revertedWith("not the owner");
    });

    it("reverts if the marketplace hasn't been approved", async function () {
      const { alice, communityMint, marketplace } = await deployFixture();
      const nftAddr = await communityMintAddr(communityMint);
      await expect(
        marketplace.connect(alice).listERC721(nftAddr, 1, ethers.parseEther("10"))
      ).to.be.revertedWith("marketplace not approved");
    });

    it("reverts on a zero price", async function () {
      const { alice, communityMint, marketplace } = await deployFixture();
      const nftAddr = await communityMintAddr(communityMint);
      await communityMint.connect(alice).approve(await marketplace.getAddress(), 1);
      await expect(marketplace.connect(alice).listERC721(nftAddr, 1, 0)).to.be.revertedWith("price must be > 0");
    });
  });

  describe("listERC1155", function () {
    it("lists a quantity the caller holds and has approved, and emits Listed", async function () {
      const { bob, collectibles, marketplace } = await deployFixture();
      const nftAddr = await collectibles.getAddress();
      await collectibles.connect(bob).setApprovalForAll(await marketplace.getAddress(), true);

      await expect(marketplace.connect(bob).listERC1155(nftAddr, 1, 3, ethers.parseEther("2")))
        .to.emit(marketplace, "Listed")
        .withArgs(1, bob.address, nftAddr, 1, 1, 3, ethers.parseEther("2"));

      const listing = await marketplace.getListing(1);
      expect(listing.amount).to.equal(3);
    });

    it("reverts if the caller doesn't hold enough copies", async function () {
      const { bob, collectibles, marketplace } = await deployFixture();
      const nftAddr = await collectibles.getAddress();
      await collectibles.connect(bob).setApprovalForAll(await marketplace.getAddress(), true);
      await expect(
        marketplace.connect(bob).listERC1155(nftAddr, 1, 6, ethers.parseEther("2"))
      ).to.be.revertedWith("insufficient balance");
    });

    it("reverts if the marketplace hasn't been approved", async function () {
      const { bob, collectibles, marketplace } = await deployFixture();
      const nftAddr = await collectibles.getAddress();
      await expect(
        marketplace.connect(bob).listERC1155(nftAddr, 1, 3, ethers.parseEther("2"))
      ).to.be.revertedWith("marketplace not approved");
    });
  });

  describe("updatePrice / cancelListing", function () {
    async function listAliceToken(marketplace, alice, communityMint) {
      const nftAddr = await communityMintAddr(communityMint);
      await communityMint.connect(alice).approve(await marketplace.getAddress(), 1);
      await marketplace.connect(alice).listERC721(nftAddr, 1, ethers.parseEther("10"));
    }

    it("lets the seller update the price", async function () {
      const { alice, communityMint, marketplace } = await deployFixture();
      await listAliceToken(marketplace, alice, communityMint);
      await expect(marketplace.connect(alice).updatePrice(1, ethers.parseEther("5")))
        .to.emit(marketplace, "PriceUpdated")
        .withArgs(1, ethers.parseEther("5"));
      expect((await marketplace.getListing(1)).pricePerUnit).to.equal(ethers.parseEther("5"));
    });

    it("blocks a non-seller from updating the price", async function () {
      const { alice, bob, communityMint, marketplace } = await deployFixture();
      await listAliceToken(marketplace, alice, communityMint);
      await expect(marketplace.connect(bob).updatePrice(1, ethers.parseEther("5"))).to.be.revertedWith(
        "not your listing"
      );
    });

    it("lets the seller cancel, and a cancelled listing can't be bought", async function () {
      const { alice, bob, communityMint, marketplace } = await deployFixture();
      await listAliceToken(marketplace, alice, communityMint);
      await expect(marketplace.connect(alice).cancelListing(1)).to.emit(marketplace, "Cancelled").withArgs(1);

      await expect(
        marketplace.connect(bob).buy(1, 1, { value: ethers.parseEther("10") })
      ).to.be.revertedWith("not active");
    });

    it("blocks a non-seller from cancelling", async function () {
      const { alice, bob, communityMint, marketplace } = await deployFixture();
      await listAliceToken(marketplace, alice, communityMint);
      await expect(marketplace.connect(bob).cancelListing(1)).to.be.revertedWith("not your listing");
    });
  });

  describe("buy - ERC721", function () {
    async function listAliceToken(marketplace, alice, communityMint, price = "10") {
      const nftAddr = await communityMintAddr(communityMint);
      await communityMint.connect(alice).approve(await marketplace.getAddress(), 1);
      await marketplace.connect(alice).listERC721(nftAddr, 1, ethers.parseEther(price));
    }

    it("transfers the NFT, pays the seller minus the fee, and sends the fee to the owner (no rewardsPool set)", async function () {
      const { owner, alice, bob, communityMint, marketplace } = await deployFixture();
      await listAliceToken(marketplace, alice, communityMint, "10");

      const aliceBefore = await ethers.provider.getBalance(alice.address);
      const ownerBefore = await ethers.provider.getBalance(owner.address);

      await expect(marketplace.connect(bob).buy(1, 1, { value: ethers.parseEther("10") }))
        .to.emit(marketplace, "Sold")
        .withArgs(1, bob.address, 1, ethers.parseEther("10"), ethers.parseEther("0.2"));

      expect(await communityMint.ownerOf(1)).to.equal(bob.address);
      expect(await ethers.provider.getBalance(alice.address)).to.equal(aliceBefore + ethers.parseEther("9.8"));
      expect(await ethers.provider.getBalance(owner.address)).to.equal(ownerBefore + ethers.parseEther("0.2"));

      const listing = await marketplace.getListing(1);
      expect(listing.active).to.equal(false);
      expect(listing.amount).to.equal(0);
    });

    it("routes the fee to rewardsPool.contributeUSDC() when one is set", async function () {
      const { owner, alice, bob, sdoge, communityMint, marketplace } = await deployFixture();

      const Staking = await ethers.getContractFactory("SDOGEStaking");
      const staking = await Staking.deploy(await sdoge.getAddress(), owner.address);
      await marketplace.connect(owner).setRewardsPool(await staking.getAddress());

      await listAliceToken(marketplace, alice, communityMint, "10");
      await marketplace.connect(bob).buy(1, 1, { value: ethers.parseEther("10") });

      expect(await staking.unallocatedUsdc()).to.equal(ethers.parseEther("0.2"));
      expect(await ethers.provider.getBalance(await staking.getAddress())).to.equal(ethers.parseEther("0.2"));
    });

    it("reverts on incorrect payment (too little or too much)", async function () {
      const { alice, bob, communityMint, marketplace } = await deployFixture();
      await listAliceToken(marketplace, alice, communityMint, "10");
      await expect(
        marketplace.connect(bob).buy(1, 1, { value: ethers.parseEther("9") })
      ).to.be.revertedWith("incorrect payment");
      await expect(
        marketplace.connect(bob).buy(1, 1, { value: ethers.parseEther("11") })
      ).to.be.revertedWith("incorrect payment");
    });

    it("reverts buying amount != 1 on an ERC-721 listing", async function () {
      const { alice, bob, communityMint, marketplace } = await deployFixture();
      await listAliceToken(marketplace, alice, communityMint, "10");
      await expect(
        marketplace.connect(bob).buy(1, 2, { value: ethers.parseEther("20") })
      ).to.be.revertedWith("invalid amount");
    });

    it("reverts a stale listing after the seller transfers the NFT away", async function () {
      const { alice, bob, stranger, communityMint, marketplace } = await deployFixture();
      await listAliceToken(marketplace, alice, communityMint, "10");

      // Alice sells/gives the token away outside the marketplace entirely.
      await communityMint.connect(alice).transferFrom(alice.address, stranger.address, 1);

      await expect(
        marketplace.connect(bob).buy(1, 1, { value: ethers.parseEther("10") })
      ).to.be.reverted; // communityMint itself reverts the safeTransferFrom (alice no longer owns it)
    });

    it("blocks a reentrant buy() from a malicious seller's receive() hook", async function () {
      const { owner, alice, bob, sdoge, communityMint, marketplace } = await deployFixture();
      const marketplaceAddr = await marketplace.getAddress();
      const nftAddr = await communityMintAddr(communityMint);

      const ReentrantSeller = await ethers.getContractFactory("ReentrantSeller");
      const attacker = await ReentrantSeller.deploy();
      const attackerAddr = await attacker.getAddress();

      await attacker.setTargets(nftAddr, marketplaceAddr);
      await sdoge.mint(attackerAddr, ethers.parseEther("10000000"));
      await attacker.approveToken(await sdoge.getAddress(), nftAddr);

      // Attacker mints and lists TWO of its own NFTs (tokenId 2 and 3 -
      // alice already holds tokenId 1 from the fixture).
      await attacker.mintAndList("ipfs://attacker-1.json", nftAddr, ethers.parseEther("10")); // listing 1
      await attacker.mintAndList("ipfs://attacker-2.json", nftAddr, ethers.parseEther("1")); // listing 2

      // When paid for listing 1, the attacker's receive() will try to buy
      // listing 2 using the proceeds it just received.
      await attacker.armReentry(2, ethers.parseEther("1"));

      await expect(marketplace.connect(bob).buy(1, 1, { value: ethers.parseEther("10") })).to.not.be.reverted;

      expect(await attacker.reentrantCallAttempted()).to.equal(true);
      expect(await attacker.reentrantCallReverted()).to.equal(true); // nonReentrant blocked it

      // Listing 1 (the real, outer purchase) went through...
      expect(await communityMint.ownerOf(2)).to.equal(bob.address);
      // ...but listing 2 (the reentrant attempt) did not.
      const listing2 = await marketplace.getListing(2);
      expect(listing2.active).to.equal(true);
      expect(await communityMint.ownerOf(3)).to.equal(attackerAddr);
    });
  });

  describe("buy - ERC1155", function () {
    async function listBobCopies(marketplace, bob, collectibles, amount, price) {
      const nftAddr = await collectibles.getAddress();
      await collectibles.connect(bob).setApprovalForAll(await marketplace.getAddress(), true);
      await marketplace.connect(bob).listERC1155(nftAddr, 1, amount, ethers.parseEther(price));
    }

    it("supports a partial buy, leaving the rest of the listing active", async function () {
      const { alice, bob, collectibles, marketplace } = await deployFixture();
      await listBobCopies(marketplace, bob, collectibles, 5, "2");

      await marketplace.connect(alice).buy(1, 2, { value: ethers.parseEther("4") });

      expect(await collectibles.balanceOf(alice.address, 1)).to.equal(2);
      expect(await collectibles.balanceOf(bob.address, 1)).to.equal(3);

      const listing = await marketplace.getListing(1);
      expect(listing.active).to.equal(true);
      expect(listing.amount).to.equal(3);
    });

    it("closes the listing once the full amount is bought (possibly across multiple buys)", async function () {
      const { alice, stranger, bob, collectibles, marketplace } = await deployFixture();
      await listBobCopies(marketplace, bob, collectibles, 5, "2");

      await marketplace.connect(alice).buy(1, 3, { value: ethers.parseEther("6") });
      await marketplace.connect(stranger).buy(1, 2, { value: ethers.parseEther("4") });

      const listing = await marketplace.getListing(1);
      expect(listing.active).to.equal(false);
      expect(listing.amount).to.equal(0);
      expect(await collectibles.balanceOf(alice.address, 1)).to.equal(3);
      expect(await collectibles.balanceOf(stranger.address, 1)).to.equal(2);
    });

    it("reverts buying more than what remains listed", async function () {
      const { alice, bob, collectibles, marketplace } = await deployFixture();
      await listBobCopies(marketplace, bob, collectibles, 5, "2");
      await expect(
        marketplace.connect(alice).buy(1, 6, { value: ethers.parseEther("12") })
      ).to.be.revertedWith("invalid amount");
    });

    it("reverts a stale listing after the seller revokes approval", async function () {
      const { alice, bob, collectibles, marketplace } = await deployFixture();
      await listBobCopies(marketplace, bob, collectibles, 5, "2");
      await collectibles.connect(bob).setApprovalForAll(await marketplace.getAddress(), false);

      await expect(marketplace.connect(alice).buy(1, 1, { value: ethers.parseEther("2") })).to.be.reverted;
    });
  });

  describe("admin", function () {
    it("lets the owner set feeBps up to the cap", async function () {
      const { owner, marketplace } = await deployFixture();
      await expect(marketplace.connect(owner).setFeeBps(1000)).to.emit(marketplace, "FeeBpsUpdated").withArgs(1000);
      expect(await marketplace.feeBps()).to.equal(1000);
    });

    it("rejects a feeBps above the 10% cap", async function () {
      const { owner, marketplace } = await deployFixture();
      await expect(marketplace.connect(owner).setFeeBps(1001)).to.be.revertedWith("fee too high");
    });

    it("only the owner can set feeBps or rewardsPool", async function () {
      const { alice, marketplace } = await deployFixture();
      await expect(marketplace.connect(alice).setFeeBps(100)).to.be.revertedWithCustomError(
        marketplace,
        "OwnableUnauthorizedAccount"
      );
      await expect(marketplace.connect(alice).setRewardsPool(alice.address)).to.be.revertedWithCustomError(
        marketplace,
        "OwnableUnauthorizedAccount"
      );
    });

    it("lets the owner point rewardsPool back at address(0) to fall back to direct owner payment", async function () {
      const { owner, marketplace } = await deployFixture();
      await marketplace.connect(owner).setRewardsPool(owner.address);
      await expect(marketplace.connect(owner).setRewardsPool(ethers.ZeroAddress))
        .to.emit(marketplace, "RewardsPoolUpdated")
        .withArgs(ethers.ZeroAddress);
      expect(await marketplace.rewardsPool()).to.equal(ethers.ZeroAddress);
    });
  });
});
