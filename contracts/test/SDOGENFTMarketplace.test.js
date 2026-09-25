const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { deployStudio, newCollection } = require("./helpers/studio");

const E = (n) => ethers.parseEther(String(n));
const ERC721 = 0;
const ERC1155 = 1;
const MAXF = 1000; // the highest fee (bps) a seller accepts in these tests
const MAXR = 1000; // and royalty

async function deployFixture() {
  const [owner, alice, bob, carol, treasury, stranger] = await ethers.getSigners();

  const sdoge = await (await ethers.getContractFactory("MockERC20")).deploy("Stable Doge", "SDOGE");
  const { studio, community: communityMint } = await deployStudio(owner, sdoge, treasury);
  const collectibles = await (await ethers.getContractFactory("SDOGECollectibles")).deploy(
    owner.address,
    "https://example.test/metadata/",
    treasury.address
  );
  const marketplace = await (await ethers.getContractFactory("SDOGENFTMarketplace")).deploy(
    owner.address,
    await studio.getAddress(),
    await collectibles.getAddress(),
    treasury.address
  );
  const staking = await (await ethers.getContractFactory("SDOGEStaking")).deploy(
    await sdoge.getAddress(),
    owner.address
  );

  // Alice mints Community Art #1 (ERC-721 side) with a credit.
  await studio.connect(owner).grantCredits(alice.address, 1);
  await studio.connect(alice).mintCommunity("ipfs://alice-art.json");

  // Bob mints 5 copies of design 1 (ERC-1155 side).
  await collectibles.connect(owner).createDesign(1, "Test Doge", 100, E("1"), 10);
  await collectibles.connect(owner).setPublicMint(1, true);
  await collectibles.connect(bob).mint(1, 5, { value: E("5") });

  const mp = await marketplace.getAddress();
  const cm = await communityMint.getAddress();
  const col = await collectibles.getAddress();
  return { owner, alice, bob, carol, treasury, stranger, sdoge, studio, communityMint, collectibles, marketplace, staking, mp, cm, col };
}

// Carol's own collection (5% royalty to Carol); she mints token 1 to Alice, who lists it.
async function listCreator(f, price = E("10"), royaltyTo = null) {
  const art = await newCollection(f.studio, f.carol, { name: "Carol Art", symbol: "CART", royaltyBps: 500 });
  if (royaltyTo) await art.connect(f.carol).setRoyalty(royaltyTo, 500);
  await f.studio.connect(f.owner).grantCredits(f.carol.address, 10);
  await art.connect(f.carol).mintBatch(f.alice.address, 1);
  await art.connect(f.alice).approve(f.mp, 1);
  await f.marketplace.connect(f.alice).listERC721(await art.getAddress(), 1, price, MAXF, MAXR);
  return art;
}

async function listAlice721(f, price = E("10")) {
  await f.communityMint.connect(f.alice).approve(f.mp, 1);
  await f.marketplace.connect(f.alice).listERC721(f.cm, 1, price, MAXF, MAXR);
}

async function listBob1155(f, amount = 5, price = E("2")) {
  await f.collectibles.connect(f.bob).setApprovalForAll(f.mp, true);
  await f.marketplace.connect(f.bob).listERC1155(f.col, 1, amount, price, MAXF);
}

const bal = (a) => ethers.provider.getBalance(a);

describe("SDOGENFTMarketplace", function () {
  describe("deployment", function () {
    it("binds the Studio registry, the Collectibles and sane defaults", async function () {
      const f = await deployFixture();
      expect(await f.marketplace.owner()).to.equal(f.owner.address);
      expect(await f.marketplace.studio()).to.equal(await f.studio.getAddress());
      expect(await f.marketplace.collectibles()).to.equal(f.col);
      expect(await f.marketplace.feeRecipient()).to.equal(f.treasury.address);
      expect(await f.marketplace.feeBps()).to.equal(200);
      expect(await f.marketplace.rewardsPool()).to.equal(ethers.ZeroAddress);
    });

    it("rejects codeless or zero addresses", async function () {
      const f = await deployFixture();
      const M = await ethers.getContractFactory("SDOGENFTMarketplace");
      const st = await f.studio.getAddress();
      const noCode = "collection registry or collectibles has no code";
      await expect(M.deploy(f.owner.address, ethers.ZeroAddress, f.col, f.treasury.address)).to.be.revertedWith(noCode);
      await expect(M.deploy(f.owner.address, st, f.stranger.address, f.treasury.address)).to.be.revertedWith(noCode);
      await expect(M.deploy(f.owner.address, st, f.col, ethers.ZeroAddress)).to.be.revertedWith(
        "fee recipient is zero address"
      );
    });
  });

  describe("listing moves the NFT into escrow", function () {
    it("ERC-721: escrows the token and emits Listed with the fee rate", async function () {
      const f = await deployFixture();
      await f.communityMint.connect(f.alice).approve(f.mp, 1);
      await expect(f.marketplace.connect(f.alice).listERC721(f.cm, 1, E("10"), MAXF, MAXR))
        .to.emit(f.marketplace, "Listed")
        .withArgs(1, f.alice.address, f.cm, ERC721, 1, 1, E("10"), 200, 0);
      expect(await f.communityMint.ownerOf(1)).to.equal(f.mp);
      const l = await f.marketplace.getListing(1);
      expect(l.seller).to.equal(f.alice.address);
      expect(l.active).to.equal(true);
      expect(l.feeBps).to.equal(200);
    });

    it("ERC-721: the same token can't be listed twice", async function () {
      const f = await deployFixture();
      await listAlice721(f);
      await expect(f.marketplace.connect(f.alice).listERC721(f.cm, 1, E("5"), MAXF, MAXR)).to.be.reverted;
    });

    it("ERC-1155: escrows exactly the listed copies", async function () {
      const f = await deployFixture();
      await listBob1155(f, 3);
      expect(await f.collectibles.balanceOf(f.mp, 1)).to.equal(3);
      expect(await f.collectibles.balanceOf(f.bob.address, 1)).to.equal(2);
      // can't list more than is left in the wallet
      await expect(f.marketplace.connect(f.bob).listERC1155(f.col, 1, 3, E("2"), MAXF)).to.be.reverted;
    });

    it("needs the marketplace approved first", async function () {
      const f = await deployFixture();
      await expect(f.marketplace.connect(f.alice).listERC721(f.cm, 1, E("10"), MAXF, MAXR)).to.be.revertedWithCustomError(
        f.communityMint,
        "ERC721InsufficientApproval"
      );
      await expect(f.marketplace.connect(f.bob).listERC1155(f.col, 1, 1, E("1"), MAXF)).to.be.revertedWithCustomError(
        f.collectibles,
        "ERC1155MissingApprovalForAll"
      );
    });

    it("only accepts SDOGE collections: the Collectibles and Studio collections", async function () {
      const f = await deployFixture();
      const Fake = await ethers.getContractFactory("MockERC20");
      const fake = await Fake.deploy("Fake", "FAKE");
      await expect(f.marketplace.connect(f.bob).listERC1155(await fake.getAddress(), 1, 1, E("1"), MAXF)).to.be.revertedWith(
        "only SDOGE Collectibles"
      );
      await expect(f.marketplace.connect(f.bob).listERC1155(f.cm, 1, 1, E("1"), MAXF)).to.be.revertedWith(
        "only SDOGE Collectibles"
      );
      await expect(f.marketplace.connect(f.alice).listERC721(f.col, 1, E("1"), MAXF, MAXR)).to.be.revertedWith(
        "only SDOGE Studio collections"
      );
      await expect(f.marketplace.connect(f.alice).listERC721(await fake.getAddress(), 1, E("1"), MAXF, MAXR)).to.be.revertedWith(
        "only SDOGE Studio collections"
      );
      const art = await listCreator(f); // any creator's own Studio collection is fine
      expect(await art.ownerOf(1)).to.equal(f.mp);
    });

    it("rejects prices below 0.01 USDC or in 6-decimal units", async function () {
      const f = await deployFixture();
      await f.collectibles.connect(f.bob).setApprovalForAll(f.mp, true);
      const list = (p) => f.marketplace.connect(f.bob).listERC1155(f.col, 1, 1, p, MAXF);
      await expect(list(0)).to.be.revertedWith("price below 0.01 USDC (prices use 18 decimals)");
      await expect(list(40_000_000n)).to.be.revertedWith("price below 0.01 USDC (prices use 18 decimals)");
      await expect(list(E("1") + 1n)).to.be.revertedWith("price must be whole micro-USDC");
      await list(E("0.01"));
    });

    it("refuses NFTs sent directly instead of listed", async function () {
      const f = await deployFixture();
      await expect(
        f.collectibles.connect(f.bob).safeTransferFrom(f.bob.address, f.mp, 1, 1, "0x")
      ).to.be.revertedWith("list it instead");
      await expect(
        f.communityMint.connect(f.alice)["safeTransferFrom(address,address,uint256)"](f.alice.address, f.mp, 1)
      ).to.be.revertedWith("list it instead");
    });
  });

  describe("updating and cancelling", function () {
    it("lets only the seller update the price, within the price rules", async function () {
      const f = await deployFixture();
      await listAlice721(f);
      await expect(f.marketplace.connect(f.bob).updatePrice(1, E("20"), MAXF, MAXR)).to.be.revertedWith("not your listing");
      await expect(f.marketplace.connect(f.alice).updatePrice(1, 35_000_000n, MAXF, MAXR)).to.be.revertedWith(
        "price below 0.01 USDC (prices use 18 decimals)"
      );
      await expect(f.marketplace.connect(f.alice).updatePrice(1, E("20"), MAXF, MAXR))
        .to.emit(f.marketplace, "PriceUpdated")
        .withArgs(1, E("20"), 200, 0);
    });

    it("repricing takes the fee and royalty in force now, within the seller's limits", async function () {
      const f = await deployFixture();
      // Carol's collection has no royalty when Alice lists; Carol adds 10% later, the fee goes to 5%
      const art = await listCreator(f, E("100"));
      await art.connect(f.carol).setRoyalty(f.carol.address, 0);
      await f.marketplace.connect(f.alice).updatePrice(1, E("100"), MAXF, MAXR);
      expect((await f.marketplace.getListing(1)).royaltyBps).to.equal(0);
      await art.connect(f.carol).setRoyalty(f.carol.address, 1000);
      await f.marketplace.connect(f.owner).setFeeBps(500);
      await expect(f.marketplace.connect(f.alice).updatePrice(1, E("90"), 499, MAXR)).to.be.revertedWith(
        "fee is above your limit"
      );
      await expect(f.marketplace.connect(f.alice).updatePrice(1, E("90"), 500, 999)).to.be.revertedWith(
        "royalty is above your limit"
      );
      await expect(f.marketplace.connect(f.alice).updatePrice(1, E("90"), 500, 1000))
        .to.emit(f.marketplace, "PriceUpdated")
        .withArgs(1, E("90"), 500, 1000);
      const [a0, c0] = [await bal(f.alice.address), await bal(f.carol.address)];
      await f.marketplace.connect(f.bob).buy(1, 1, { value: E("90") });
      expect((await bal(f.carol.address)) - c0).to.equal(E("9"));
      expect((await bal(f.alice.address)) - a0).to.equal(E("76.5")); // 90 - 4.5 fee - 9 royalty
    });

    it("listing reverts when the fee or royalty is above the seller's limits", async function () {
      const f = await deployFixture();
      await f.marketplace.connect(f.owner).setFeeBps(300);
      await f.communityMint.connect(f.alice).approve(f.mp, 1);
      await expect(f.marketplace.connect(f.alice).listERC721(f.cm, 1, E("10"), 200, 0)).to.be.revertedWith(
        "fee is above your limit"
      );
      await f.marketplace.connect(f.alice).listERC721(f.cm, 1, E("10"), 300, 0); // Community Art: no royalty
      await f.collectibles.connect(f.bob).setApprovalForAll(f.mp, true);
      await expect(f.marketplace.connect(f.bob).listERC1155(f.col, 1, 1, E("1"), 299)).to.be.revertedWith(
        "fee is above your limit"
      );
      const art = await newCollection(f.studio, f.carol, { name: "Carol Art", symbol: "CART", royaltyBps: 500 });
      await f.studio.connect(f.owner).grantCredits(f.carol.address, 1);
      await art.connect(f.carol).mintBatch(f.bob.address, 1);
      await art.connect(f.bob).approve(f.mp, 1);
      await expect(f.marketplace.connect(f.bob).listERC721(await art.getAddress(), 1, E("10"), 300, 499)).to.be.revertedWith(
        "royalty is above your limit"
      );
      await f.marketplace.connect(f.bob).listERC721(await art.getAddress(), 1, E("10"), 300, 500);
    });

    it("a seller contract without the ERC-721 receiver hook can still cancel", async function () {
      const f = await deployFixture();
      const seller = await (await ethers.getContractFactory("PlainSeller721")).deploy();
      const sAddr = await seller.getAddress();
      const art = await newCollection(f.studio, f.carol, { name: "Carol Art", symbol: "CART" });
      await f.studio.connect(f.owner).grantCredits(f.carol.address, 2);
      await art.connect(f.carol).airdrop([sAddr, sAddr]); // owner mints skip the hook
      await seller.list(f.mp, await art.getAddress(), 1, E("10"));
      await f.marketplace.connect(f.owner).pause();
      await seller.cancel(f.mp, 1);
      expect(await art.ownerOf(1)).to.equal(sAddr);
      // to another address, the receiver check applies
      await f.marketplace.connect(f.owner).unpause();
      await seller.list(f.mp, await art.getAddress(), 2, E("10"));
      const noHooks = await (await ethers.getContractFactory("RevertingReceiver")).deploy();
      await expect(seller.cancelTo(f.mp, 2, await noHooks.getAddress())).to.be.revertedWithCustomError(
        art,
        "ERC721InvalidReceiver"
      );
      await seller.cancelTo(f.mp, 2, f.carol.address);
      expect(await art.ownerOf(2)).to.equal(f.carol.address);
    });

    it("cancelListingTo: only the seller, never to the zero address", async function () {
      const f = await deployFixture();
      await listBob1155(f, 3, E("1"));
      await expect(f.marketplace.connect(f.alice).cancelListingTo(1, f.alice.address)).to.be.revertedWith(
        "not your listing"
      );
      await expect(f.marketplace.connect(f.bob).cancelListingTo(1, ethers.ZeroAddress)).to.be.revertedWith(
        "bad recipient"
      );
      await expect(f.marketplace.connect(f.bob).cancelListingTo(1, f.carol.address))
        .to.emit(f.marketplace, "Cancelled")
        .withArgs(1, 3);
      expect(await f.collectibles.balanceOf(f.carol.address, 1)).to.equal(3);
    });

    it("cancelling returns the escrowed NFT, even while paused", async function () {
      const f = await deployFixture();
      await listAlice721(f);
      await listBob1155(f, 4);
      await f.marketplace.connect(f.owner).pause();
      await expect(f.marketplace.connect(f.bob).cancelListing(1)).to.be.revertedWith("not your listing");
      await f.marketplace.connect(f.alice).cancelListing(1);
      await f.marketplace.connect(f.bob).cancelListing(2);
      expect(await f.communityMint.ownerOf(1)).to.equal(f.alice.address);
      expect(await f.collectibles.balanceOf(f.bob.address, 1)).to.equal(5);
      await f.marketplace.connect(f.owner).unpause();
      await expect(f.marketplace.connect(f.carol).buy(1, 1, { value: E("10") })).to.be.revertedWith("not active");
    });
  });

  describe("buying", function () {
    it("ERC-721: NFT to the buyer, 98% to the seller, 2% to the fee recipient", async function () {
      const f = await deployFixture();
      await listAlice721(f);
      const [a0, t0] = [await bal(f.alice.address), await bal(f.treasury.address)];
      await expect(f.marketplace.connect(f.carol).buy(1, 1, { value: E("10") }))
        .to.emit(f.marketplace, "Sold")
        .withArgs(1, f.carol.address, 1, E("10"), E("0.2"), 0);
      expect(await f.communityMint.ownerOf(1)).to.equal(f.carol.address);
      expect((await bal(f.alice.address)) - a0).to.equal(E("9.8"));
      expect((await bal(f.treasury.address)) - t0).to.equal(E("0.2"));
      expect((await f.marketplace.getListing(1)).active).to.equal(false);
      expect(await bal(f.mp)).to.equal(0);
    });

    it("requires the exact payment and a valid amount", async function () {
      const f = await deployFixture();
      await listAlice721(f);
      await expect(f.marketplace.connect(f.carol).buy(1, 1, { value: E("9") })).to.be.revertedWith("incorrect payment");
      await expect(f.marketplace.connect(f.carol).buy(1, 1, { value: E("11") })).to.be.revertedWith("incorrect payment");
      await expect(f.marketplace.connect(f.carol).buy(1, 2, { value: E("20") })).to.be.revertedWith("invalid amount");
      await expect(f.marketplace.connect(f.carol).buy(1, 0, { value: 0 })).to.be.revertedWith("invalid amount");
    });

    it("ERC-1155: partial buys shrink the listing; the last one closes it", async function () {
      const f = await deployFixture();
      await listBob1155(f, 5, E("2"));
      await f.marketplace.connect(f.carol).buy(1, 2, { value: E("4") });
      expect(await f.collectibles.balanceOf(f.carol.address, 1)).to.equal(2);
      expect((await f.marketplace.getListing(1)).amount).to.equal(3);
      await expect(f.marketplace.connect(f.carol).buy(1, 4, { value: E("8") })).to.be.revertedWith("invalid amount");
      await f.marketplace.connect(f.alice).buy(1, 3, { value: E("6") });
      expect((await f.marketplace.getListing(1)).active).to.equal(false);
      expect(await f.collectibles.balanceOf(f.mp, 1)).to.equal(0);
    });

    it("a stale or revived listing can't exist: sold items are gone from escrow", async function () {
      const f = await deployFixture();
      await listBob1155(f, 2, E("1"));
      await f.marketplace.connect(f.carol).buy(1, 2, { value: E("2") });
      // Bob later holds copies again and re-approves: the old listing stays dead
      await f.collectibles.connect(f.bob).setApprovalForAll(f.mp, true);
      await expect(f.marketplace.connect(f.carol).buy(1, 1, { value: E("1") })).to.be.revertedWith("not active");
    });
  });

  describe("fees", function () {
    it("go to the staking pool's contributeUSDC when one is set", async function () {
      const f = await deployFixture();
      await f.marketplace.connect(f.owner).setRewardsPool(await f.staking.getAddress());
      await listAlice721(f);
      await f.marketplace.connect(f.carol).buy(1, 1, { value: E("10") });
      expect(await f.staking.unallocatedUsdc()).to.equal(E("0.2"));
    });

    it("the pool must be a contract", async function () {
      const f = await deployFixture();
      await expect(f.marketplace.connect(f.owner).setRewardsPool(f.stranger.address)).to.be.revertedWith(
        "pool must be a contract"
      );
    });

    it("a pool that refuses the fee never blocks a sale; the fee waits for flushFees", async function () {
      const f = await deployFixture();
      await f.marketplace.connect(f.owner).setRewardsPool(await f.sdoge.getAddress()); // no contributeUSDC
      await listAlice721(f);
      await expect(f.marketplace.connect(f.carol).buy(1, 1, { value: E("10") })).to.emit(f.marketplace, "FeeDeferred");
      expect(await f.marketplace.pendingFees()).to.equal(E("0.2"));
      await expect(f.marketplace.flushFees()).to.be.revertedWith("fee recipient refused");
      await f.marketplace.connect(f.owner).setRewardsPool(await f.staking.getAddress());
      await f.marketplace.connect(f.stranger).flushFees();
      expect(await f.staking.unallocatedUsdc()).to.equal(E("0.2"));
      expect(await f.marketplace.pendingFees()).to.equal(0);
    });

    it("never charge more than the rate when listed, but a later cut applies", async function () {
      const f = await deployFixture();
      await listBob1155(f, 5, E("10"));
      await f.marketplace.connect(f.owner).setFeeBps(1000);
      const t0 = await bal(f.treasury.address);
      await f.marketplace.connect(f.carol).buy(1, 1, { value: E("10") });
      expect((await bal(f.treasury.address)) - t0).to.equal(E("0.2"), "raise ignored");
      await f.marketplace.connect(f.owner).setFeeBps(100);
      const t1 = await bal(f.treasury.address);
      await f.marketplace.connect(f.carol).buy(1, 1, { value: E("10") });
      expect((await bal(f.treasury.address)) - t1).to.equal(E("0.1"), "cut applied");
      await expect(f.marketplace.connect(f.owner).setFeeBps(1001)).to.be.revertedWith("fee too high");
    });
  });

  describe("creator royalties", function () {
    it("pay the collection's royalty receiver out of the price", async function () {
      const f = await deployFixture();
      await listCreator(f, E("10"));
      const [a0, c0, t0] = [await bal(f.alice.address), await bal(f.carol.address), await bal(f.treasury.address)];
      await expect(f.marketplace.connect(f.bob).buy(1, 1, { value: E("10") }))
        .to.emit(f.marketplace, "RoyaltyPaid")
        .withArgs(1, f.carol.address, E("0.5"))
        .and.to.emit(f.marketplace, "Sold")
        .withArgs(1, f.bob.address, 1, E("10"), E("0.2"), E("0.5"));
      expect((await bal(f.alice.address)) - a0).to.equal(E("9.3"));
      expect((await bal(f.carol.address)) - c0).to.equal(E("0.5"));
      expect((await bal(f.treasury.address)) - t0).to.equal(E("0.2"));
      expect(await bal(f.mp)).to.equal(0);
    });

    it("never pay more than the rate when listed, but a later cut applies", async function () {
      const f = await deployFixture();
      const art = await listCreator(f, E("10"));
      expect((await f.marketplace.getListing(1)).royaltyBps).to.equal(500);
      await art.connect(f.carol).setRoyalty(f.carol.address, 1000);
      const c0 = await bal(f.carol.address);
      await f.marketplace.connect(f.bob).buy(1, 1, { value: E("10") });
      expect((await bal(f.carol.address)) - c0).to.equal(E("0.5"), "raise ignored");

      await art.connect(f.bob).approve(f.mp, 1);
      await f.marketplace.connect(f.bob).listERC721(await art.getAddress(), 1, E("10"), MAXF, MAXR); // listed at 10%
      expect((await f.marketplace.getListing(2)).royaltyBps).to.equal(1000);
      await art.connect(f.carol).setRoyalty(f.carol.address, 100);
      const c1 = await bal(f.carol.address);
      await f.marketplace.connect(f.alice).buy(2, 1, { value: E("10") });
      expect((await bal(f.carol.address)) - c1).to.equal(E("0.1"), "cut applied");
    });

    it("a receiver that refuses USDC gets it as withdrawable proceeds; the sale goes through", async function () {
      const f = await deployFixture();
      const refuser = await (await ethers.getContractFactory("RevertingReceiver")).deploy();
      await listCreator(f, E("10"), await refuser.getAddress());
      await expect(f.marketplace.connect(f.bob).buy(1, 1, { value: E("10") }))
        .to.emit(f.marketplace, "ProceedsCredited")
        .withArgs(await refuser.getAddress(), E("0.5"))
        .and.to.not.emit(f.marketplace, "RoyaltyPaid");
      expect(await f.marketplace.proceeds(await refuser.getAddress())).to.equal(E("0.5"));
      expect(await f.marketplace.totalProceeds()).to.equal(E("0.5"));
      await expect(f.marketplace.withdrawProceedsFor(await refuser.getAddress())).to.be.revertedWith("transfer failed");
    });

    it("anyone can push waiting proceeds to a receiver that needs more gas than the sale gave it", async function () {
      const f = await deployFixture();
      const splitter = await (await ethers.getContractFactory("GasHungryReceiver")).deploy();
      const sAddr = await splitter.getAddress();
      await listCreator(f, E("10"), sAddr);
      await f.marketplace.connect(f.bob).buy(1, 1, { value: E("10") });
      expect(await f.marketplace.proceeds(sAddr)).to.equal(E("0.5"));
      await expect(f.marketplace.connect(f.stranger).withdrawProceedsFor(sAddr))
        .to.emit(f.marketplace, "ProceedsWithdrawn")
        .withArgs(sAddr, sAddr, E("0.5"));
      expect(await bal(sAddr)).to.equal(E("0.5"));
      expect(await f.marketplace.totalProceeds()).to.equal(0);
      await expect(f.marketplace.withdrawProceedsFor(sAddr)).to.be.revertedWith("nothing to withdraw");
    });

    it("a royalty pointed at the marketplace itself is never taken from the seller", async function () {
      const f = await deployFixture();
      await listCreator(f, E("10"), f.mp);
      const a0 = await bal(f.alice.address);
      await expect(f.marketplace.connect(f.bob).buy(1, 1, { value: E("10") }))
        .to.emit(f.marketplace, "Sold")
        .withArgs(1, f.bob.address, 1, E("10"), E("0.2"), 0);
      expect((await bal(f.alice.address)) - a0).to.equal(E("9.8"));
      expect(await f.marketplace.totalProceeds()).to.equal(0);
      expect(await bal(f.mp)).to.equal(0);
    });

    it("Community Art and the Collectibles carry no royalty", async function () {
      const f = await deployFixture();
      await listAlice721(f);
      await listBob1155(f, 1, E("1"));
      expect((await f.marketplace.getListing(1)).royaltyBps).to.equal(0);
      expect((await f.marketplace.getListing(2)).royaltyBps).to.equal(0);
    });
  });

  describe("sellers that can't receive USDC", function () {
    it("the sale still goes through and the proceeds wait for withdrawal", async function () {
      const f = await deployFixture();
      const Seller = await ethers.getContractFactory("MarketSeller");
      const seller = await Seller.deploy();
      const sAddr = await seller.getAddress();
      await f.collectibles.connect(f.bob).safeTransferFrom(f.bob.address, sAddr, 1, 2, "0x");
      await seller.list(f.mp, f.col, 1, 2, E("3"));

      await expect(f.marketplace.connect(f.carol).buy(1, 2, { value: E("6") })).to.emit(
        f.marketplace,
        "ProceedsCredited"
      );
      expect(await f.collectibles.balanceOf(f.carol.address, 1)).to.equal(2);
      expect(await f.marketplace.proceeds(sAddr)).to.equal(E("5.88"));

      const before = await bal(f.alice.address);
      await seller.withdraw(f.mp, f.alice.address);
      expect((await bal(f.alice.address)) - before).to.equal(E("5.88"));
      expect(await f.marketplace.proceeds(sAddr)).to.equal(0);
      expect(await bal(f.mp)).to.equal(0);
    });
  });

  describe("reentrancy", function () {
    it("a seller re-entering buy() from its receive() gets nothing and can't block the sale", async function () {
      const f = await deployFixture();
      const Attacker = await ethers.getContractFactory("ReentrantSeller");
      const attacker = await Attacker.deploy();
      const aAddr = await attacker.getAddress();
      await attacker.setTargets(await f.studio.getAddress(), f.mp);
      await f.studio.connect(f.owner).grantCredits(aAddr, 2);
      await attacker.mintAndList("ipfs://attacker-1.json", E("10")); // listing 1, token 2
      await attacker.mintAndList("ipfs://attacker-2.json", E("1")); // listing 2, token 3
      await attacker.armReentry(2, E("1"));

      const before = await bal(aAddr);
      await f.marketplace.connect(f.bob).buy(1, 1, { value: E("10") });
      expect(await f.communityMint.ownerOf(2)).to.equal(f.bob.address);
      expect((await f.marketplace.getListing(2)).active).to.equal(true);
      expect(await f.communityMint.ownerOf(3)).to.equal(f.mp);
      // the seller got its 9.8 either directly or as withdrawable proceeds
      expect((await bal(aAddr)) - before + (await f.marketplace.proceeds(aAddr))).to.equal(E("9.8"));
    });
  });

  describe("reading listings", function () {
    it("pages through active listings only", async function () {
      const f = await deployFixture();
      await listAlice721(f);
      await listBob1155(f, 1, E("1"));
      await f.marketplace.connect(f.bob).listERC1155(f.col, 1, 1, E("2"), MAXF);
      expect(await f.marketplace.activeListingCount()).to.equal(3);
      await f.marketplace.connect(f.carol).buy(2, 1, { value: E("1") });
      expect(await f.marketplace.activeListingCount()).to.equal(2);
      const [ids, items] = await f.marketplace.getActiveListings(0, 10);
      expect(ids.map(Number).sort()).to.deep.equal([1, 3]);
      expect(items.every((l) => l.active)).to.equal(true);
      const [page2] = await f.marketplace.getActiveListings(1, 1);
      expect(page2.length).to.equal(1);
      const [none] = await f.marketplace.getActiveListings(5, 10);
      expect(none.length).to.equal(0);
      const [all] = await f.marketplace.getActiveListings(0, ethers.MaxUint256); // no overflow on a huge limit
      expect(all.length).to.equal(2);
    });

    it("per-seller and per-collection indexes always match the active listings", async function () {
      const f = await deployFixture();
      const art = await newCollection(f.studio, f.carol, { name: "Carol Art", symbol: "CART", royaltyBps: 0 });
      await f.studio.connect(f.owner).grantCredits(f.carol.address, 6);
      await art.connect(f.carol).mintBatch(f.alice.address, 3);
      await art.connect(f.carol).mintBatch(f.bob.address, 3);
      await art.connect(f.alice).setApprovalForAll(f.mp, true);
      await art.connect(f.bob).setApprovalForAll(f.mp, true);
      await f.communityMint.connect(f.alice).approve(f.mp, 1);
      await f.collectibles.connect(f.bob).setApprovalForAll(f.mp, true);
      const artAddr = await art.getAddress();
      const m = f.marketplace;

      const check = async () => {
        const [ids, items] = await m.getActiveListings(0, 1000);
        const active = ids.map((id, i) => ({ id: Number(id), seller: items[i].seller, nft: items[i].nftContract }));
        for (const who of [f.alice.address, f.bob.address, f.carol.address]) {
          const [mine] = await m.getActiveListingsBySeller(who, 0, 1000);
          const want = active.filter((l) => l.seller === who).map((l) => l.id);
          expect(mine.map(Number).sort()).to.deep.equal(want.sort(), `seller ${who}`);
          expect(await m.activeListingCountBySeller(who)).to.equal(want.length);
        }
        for (const nft of [artAddr, f.cm, f.col]) {
          const [its] = await m.getActiveListingsByCollection(nft, 0, 1000);
          const want = active.filter((l) => l.nft === nft).map((l) => l.id);
          expect(its.map(Number).sort()).to.deep.equal(want.sort(), `collection ${nft}`);
          expect(await m.activeListingCountByCollection(nft)).to.equal(want.length);
        }
      };

      for (const id of [1, 2, 3]) await m.connect(f.alice).listERC721(artAddr, id, E("1"), MAXF, MAXR); // #1-3
      await m.connect(f.alice).listERC721(f.cm, 1, E("1"), MAXF, MAXR); // #4
      for (const id of [4, 5]) await m.connect(f.bob).listERC721(artAddr, id, E("2"), MAXF, MAXR); // #5-6
      await m.connect(f.bob).listERC1155(f.col, 1, 5, E("1"), MAXF); // #7
      await check();
      await m.connect(f.carol).buy(1, 1, { value: E("1") }); // first of Alice's
      await check();
      await m.connect(f.carol).buy(7, 2, { value: E("2") }); // partial: stays listed
      await check();
      await m.connect(f.bob).cancelListing(5);
      await check();
      await m.connect(f.alice).cancelListing(4);
      await check();
      await m.connect(f.carol).buy(7, 3, { value: E("3") }); // the rest: delisted
      await check();
      await m.connect(f.bob).listERC721(artAddr, 6, E("2"), MAXF, MAXR); // #8
      await m.connect(f.carol).buy(3, 1, { value: E("1") });
      await check();
      const [page] = await m.getActiveListingsBySeller(f.alice.address, 1, 5);
      expect(page.length).to.equal(0); // Alice has just #2 left
      const [bobs] = await m.getActiveListingsBySeller(f.bob.address, 0, 1);
      expect(bobs.length).to.equal(1);
    });

    it("a seller's listing stays reachable however many listings came before it", async function () {
      const f = await deployFixture();
      const art = await newCollection(f.studio, f.carol, { name: "Spam", symbol: "SPAM", royaltyBps: 0 });
      await f.studio.connect(f.owner).grantCredits(f.carol.address, 210);
      await art.connect(f.carol).mintBatch(f.carol.address, 200);
      await art.connect(f.carol).setApprovalForAll(f.mp, true);
      const spam = await art.getAddress();
      for (let id = 1; id <= 200; id++) {
        await f.marketplace.connect(f.carol).listERC721(spam, id, E("1000000"), MAXF, MAXR);
      }
      await listAlice721(f, E("5")); // listing #201
      expect(await f.marketplace.activeListingCount()).to.equal(201);
      const [mine] = await f.marketplace.getActiveListingsBySeller(f.alice.address, 0, 50);
      expect(mine.map(Number)).to.deep.equal([201]);
      const [community] = await f.marketplace.getActiveListingsByCollection(f.cm, 0, 50);
      expect(community.map(Number)).to.deep.equal([201]);
      await f.marketplace.connect(f.alice).cancelListing(201);
      expect(await f.communityMint.ownerOf(1)).to.equal(f.alice.address);
    });
  });

  describe("admin", function () {
    it("pause stops listing and buying only", async function () {
      const f = await deployFixture();
      await listBob1155(f, 2, E("1"));
      await expect(f.marketplace.connect(f.stranger).pause()).to.be.revertedWithCustomError(
        f.marketplace,
        "OwnableUnauthorizedAccount"
      );
      await f.marketplace.connect(f.owner).pause();
      await expect(f.marketplace.connect(f.carol).buy(1, 1, { value: E("1") })).to.be.revertedWithCustomError(
        f.marketplace,
        "EnforcedPause"
      );
      await expect(f.marketplace.connect(f.bob).listERC1155(f.col, 1, 1, E("1"), MAXF)).to.be.revertedWithCustomError(
        f.marketplace,
        "EnforcedPause"
      );
      await f.marketplace.connect(f.owner).unpause();
      await f.marketplace.connect(f.carol).buy(1, 1, { value: E("1") });
    });

    it("rescues NFTs sent in without the hooks, but never escrowed ones", async function () {
      const f = await deployFixture();
      await f.communityMint.connect(f.alice).transferFrom(f.alice.address, f.mp, 1); // no hook
      await f.marketplace.connect(f.owner).rescueStrayNft(f.cm, 1, 1, f.alice.address);
      expect(await f.communityMint.ownerOf(1)).to.equal(f.alice.address);

      await listAlice721(f);
      await expect(f.marketplace.connect(f.owner).rescueStrayNft(f.cm, 1, 1, f.owner.address)).to.be.revertedWith(
        "not stray"
      );
      await listBob1155(f, 2, E("1"));
      await expect(f.marketplace.connect(f.owner).rescueStrayNft(f.col, 1, 1, f.owner.address)).to.be.revertedWith(
        "not stray"
      );
    });

    it("sweeps forced-in USDC but never proceeds or pending fees", async function () {
      const f = await deployFixture();
      await expect(f.marketplace.connect(f.owner).sweepSurplus()).to.be.revertedWith("no surplus");
      await network.provider.send("hardhat_setBalance", [f.mp, ethers.toQuantity(E("3"))]);
      const t0 = await bal(f.treasury.address);
      await f.marketplace.connect(f.owner).sweepSurplus();
      expect((await bal(f.treasury.address)) - t0).to.equal(E("3"));
    });

    it("ownership moves in two steps and can't be renounced", async function () {
      const f = await deployFixture();
      await expect(f.marketplace.connect(f.owner).renounceOwnership()).to.be.revertedWith("renounce disabled");
      await f.marketplace.connect(f.owner).transferOwnership(f.alice.address);
      expect(await f.marketplace.owner()).to.equal(f.owner.address);
      await f.marketplace.connect(f.alice).acceptOwnership();
      expect(await f.marketplace.owner()).to.equal(f.alice.address);
    });

    it("only the owner changes fees, pool and recipient", async function () {
      const f = await deployFixture();
      const who = f.marketplace.connect(f.stranger);
      for (const call of [() => who.setFeeBps(100), () => who.setRewardsPool(ethers.ZeroAddress), () => who.setFeeRecipient(f.stranger.address)]) {
        await expect(call()).to.be.revertedWithCustomError(f.marketplace, "OwnableUnauthorizedAccount");
      }
      await expect(f.marketplace.connect(f.owner).setFeeRecipient(ethers.ZeroAddress)).to.be.revertedWith(
        "fee recipient is zero address"
      );
    });
  });
});
