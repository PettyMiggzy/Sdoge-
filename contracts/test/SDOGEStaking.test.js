const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const TIER = { SEVEN_DAY: 0, THIRTY_DAY: 1, NINETY_DAY: 2, ONE_EIGHTY_DAY: 3, THREE_SIXTY_FIVE_DAY: 4 };
const E = (n) => ethers.parseEther(String(n));
const USDC_VIEW = "0x3600000000000000000000000000000000000000";
const TERMS = ["uint8", "uint256", "uint256", "uint256", "uint256"];

// Design 1: +10% boost (20 USDC). Design 2: +50% (50 USDC). Design 3: no boost (10 USDC).
async function deployFixture() {
  const [owner, alice, bob, carol, stranger, notifier, treasury] = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const sdoge = await MockERC20.deploy("Stable Doge", "SDOGE");

  const Collectibles = await ethers.getContractFactory("SDOGECollectibles");
  const collectibles = await Collectibles.deploy(owner.address, "ipfs://meta/", treasury.address);
  const designs = [
    [1, "Cap Doge", 500, E("20")],
    [2, "Space Doge", 200, E("50")],
    [3, "Plain Doge", 100, E("10")],
  ];
  for (const [id, name, supply, price] of designs) {
    await collectibles.createDesign(id, name, supply, price, 0);
    await collectibles.setPublicMint(id, true);
  }

  const Staking = await ethers.getContractFactory("SDOGEStaking");
  const staking = await Staking.deploy(await sdoge.getAddress(), await collectibles.getAddress(), owner.address);
  await staking.connect(owner).setDesignBoosts([1, 2], [1000, 5000]);

  const amount = E("10000000");
  for (const user of [alice, bob, carol, stranger]) {
    await sdoge.mint(user.address, amount);
    await sdoge.connect(user).approve(await staking.getAddress(), amount);
  }
  return { owner, alice, bob, carol, stranger, notifier, treasury, sdoge, collectibles, staking };
}

// On Arc the USDC reward is native; here it's Hardhat's native coin, which is what the contract handles.
async function fund(staking, owner, amount) {
  await staking.connect(owner).notifyRewardAmount({ value: E(amount) });
}

async function fundSdoge({ owner, sdoge, staking }, amount, who = owner) {
  await sdoge.mint(who.address, E(amount));
  await sdoge.connect(who).approve(await staking.getAddress(), E(amount));
  await staking.connect(who).notifySdogeRewards(E(amount));
}

function stakeIdFrom(staking, receipt) {
  for (const log of receipt.logs) {
    try {
      const parsed = staking.interface.parseLog(log);
      if (parsed && parsed.name === "Staked") return parsed.args.stakeId;
    } catch {
      // another contract's event
    }
  }
  throw new Error("Staked event not found");
}

async function stakeAndGetId(staking, signer, tier, amount) {
  const [d, m] = await Promise.all([staking.tierDuration(tier), staking.tierMultiplierBps(tier)]);
  const tx = await staking.connect(signer).stake(tier, typeof amount === "bigint" ? amount : E(amount), d, m);
  return stakeIdFrom(staking, await tx.wait());
}

async function mintNft({ collectibles }, signer, designId) {
  const { priceWei } = await collectibles.designs(designId);
  await collectibles.connect(signer).mint(designId, 1, { value: priceWei });
}

// What the staking page sends with the NFT: the tier's terms and the design's boost.
async function nftTerms(staking, designId, tier, amount, boost) {
  const [d, m, b] = await Promise.all([
    staking.tierDuration(tier),
    staking.tierMultiplierBps(tier),
    staking.designBoostBps(designId),
  ]);
  return ethers.AbiCoder.defaultAbiCoder().encode(TERMS, [tier, amount, d, m, boost ?? b]);
}

async function stakeWithNft({ staking, collectibles }, signer, designId, tier, amount) {
  const amt = typeof amount === "bigint" ? amount : E(amount);
  const data = await nftTerms(staking, designId, tier, amt);
  const tx = await collectibles
    .connect(signer)
    .safeTransferFrom(signer.address, await staking.getAddress(), designId, 1, data);
  return stakeIdFrom(staking, await tx.wait());
}

const balanceOf = (addr) => ethers.provider.getBalance(addr);

// Both books must always balance exactly: the native balance is what's owed in USDC, and the
// SDOGE balance is principal plus what's owed in SDOGE rewards.
async function expectBooks({ staking, sdoge }) {
  const addr = await staking.getAddress();
  expect(await balanceOf(addr)).to.equal((await staking.unallocatedUsdc()) + (await staking.rewardsOutstanding()));
  expect(await sdoge.balanceOf(addr)).to.equal(
    (await staking.totalPrincipalStaked()) + (await staking.unallocatedSdoge()) + (await staking.sdogeRewardsOutstanding())
  );
}

describe("SDOGEStaking", function () {
  describe("staking", function () {
    it("stakes into a tier and snapshots its terms", async function () {
      const { alice, staking } = await deployFixture();
      const id = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "100");
      const start = BigInt(await time.latest());

      const s = await staking.getStake(id);
      expect(s.owner).to.equal(alice.address);
      expect(s.tier).to.equal(TIER.THIRTY_DAY);
      expect(s.multiplierBps).to.equal(12000);
      expect(s.penaltyBps).to.equal(1500);
      expect(s.boostBps).to.equal(0);
      expect(s.holdsNft).to.equal(false);
      expect(s.amount).to.equal(E("100"));
      expect(s.weighted).to.equal(E("120"));
      expect(s.startTime).to.equal(start);
      expect(s.unlockTime).to.equal(start + BigInt(30 * DAY));
      expect(s.matureTime).to.equal(start + BigInt(24 * DAY));
      expect(s.closed).to.equal(false);
      expect(await staking.effectiveUnlockTime(id)).to.equal(start + BigInt(24 * DAY));
      expect(await staking.totalPrincipalStaked()).to.equal(E("100"));
      expect(await staking.totalWeightedSupply()).to.equal(E("120"));
    });

    it("rejects staking 0 and an invalid tier", async function () {
      const { alice, staking } = await deployFixture();
      await expect(staking.connect(alice).stake(0, 0, 7 * DAY, 10000)).to.be.revertedWith("cannot stake 0");
      await expect(staking.connect(alice).stake(5, E("1"), 7 * DAY, 10000)).to.be.revertedWith("invalid tier");
    });

    it("refuses to stake on terms other than the tier's (a page showing the wrong terms)", async function () {
      const { alice, staking } = await deployFixture();
      await expect(staking.connect(alice).stake(TIER.SEVEN_DAY, E("1"), 10 * DAY, 10000)).to.be.revertedWith(
        "tier terms changed"
      );
      await expect(staking.connect(alice).stake(TIER.SEVEN_DAY, E("1"), 7 * DAY, 12000)).to.be.revertedWith(
        "tier terms changed"
      );
      await staking.connect(alice).stake(TIER.SEVEN_DAY, E("1"), 7 * DAY, 10000);
    });

    it("keeps multiple stakes of one user separate", async function () {
      const { alice, staking } = await deployFixture();
      const a = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      const b = await stakeAndGetId(staking, alice, TIER.THREE_SIXTY_FIVE_DAY, "50");
      expect(a).to.not.equal(b);
      expect(await staking.getStakeIds(alice.address)).to.deep.equal([a, b]);
      expect((await staking.getStake(b)).weighted).to.equal(E("150"));
    });

    it("counts the wallets with an open stake", async function () {
      const { alice, bob, staking } = await deployFixture();
      const a1 = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      const a2 = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "100");
      const b = await stakeAndGetId(staking, bob, TIER.SEVEN_DAY, "100");
      expect(await staking.activeStakers()).to.equal(2);
      expect(await staking.openStakeCount(alice.address)).to.equal(2);
      await staking.connect(alice).exitStake(a2, true);
      expect(await staking.activeStakers()).to.equal(2);
      await time.increase(7 * DAY);
      await staking.connect(alice).withdraw(a1, E("40"), [alice.address], [E("40")], false);
      expect(await staking.openStakeCount(alice.address)).to.equal(1);
      await staking.connect(alice).exitStake(a1, false);
      expect(await staking.activeStakers()).to.equal(1);
      await staking.connect(bob).exitStake(b, false);
      expect(await staking.activeStakers()).to.equal(0);
    });
  });

  describe("exits after maturity", function () {
    it("exitStake returns full principal and the reward", async function () {
      const f = await deployFixture();
      const { owner, alice, sdoge, staking } = f;
      const before = await sdoge.balanceOf(alice.address);
      const id = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "1000");
      await fund(staking, owner, "7");
      await time.increase(8 * DAY);

      const ethBefore = await balanceOf(alice.address);
      const tx = await staking.connect(alice).exitStake(id, false);
      const rc = await tx.wait();
      const gas = rc.gasUsed * rc.gasPrice;
      expect(await sdoge.balanceOf(alice.address)).to.equal(before);
      expect((await balanceOf(alice.address)) + gas - ethBefore).to.be.closeTo(E("7"), E("0.000001"));
      expect((await staking.getStake(id)).closed).to.equal(true);
      expect(await staking.totalWeightedSupply()).to.equal(0);
      expect(await staking.totalUsdcRewardsPaid()).to.be.closeTo(E("7"), E("0.000001"));
      await expectBooks(f);
    });

    it("exitStake(id, false) refuses an early exit instead of charging the penalty", async function () {
      const { owner, alice, staking } = await deployFixture();
      const id = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "100");
      await fund(staking, owner, "7");
      await time.increase(24 * DAY - 10);
      await expect(staking.connect(alice).exitStake(id, false)).to.be.revertedWith("exit would be early");
    });

    it("withdraws part of a matured stake and keeps the rest running", async function () {
      const { alice, sdoge, staking } = await deployFixture();
      const id = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await time.increase(7 * DAY);
      const before = await sdoge.balanceOf(alice.address);
      await staking.connect(alice).withdraw(id, E("40"), [alice.address], [E("40")], false);
      expect(await sdoge.balanceOf(alice.address)).to.equal(before + E("40"));
      const s = await staking.getStake(id);
      expect(s.amount).to.equal(E("60"));
      expect(s.weighted).to.equal(E("60"));
      expect(s.closed).to.equal(false);
    });

    it("splits a payout across up to 4 wallets, never to the staking contract itself", async function () {
      const { alice, bob, carol, stranger, sdoge, staking } = await deployFixture();
      const id = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await time.increase(7 * DAY);
      const self = await staking.getAddress();
      await expect(
        staking.connect(alice).withdraw(id, E("100"), [bob.address, self], [E("50"), E("50")], false)
      ).to.be.revertedWith("recipient is the staking contract");
      await expect(
        staking.connect(alice).withdraw(id, E("100"), [bob.address, ethers.ZeroAddress], [E("50"), E("50")], false)
      ).to.be.revertedWith("recipient is zero address");

      const [b0, c0, s0] = await Promise.all([
        sdoge.balanceOf(bob.address),
        sdoge.balanceOf(carol.address),
        sdoge.balanceOf(stranger.address),
      ]);
      await staking
        .connect(alice)
        .withdraw(id, E("100"), [bob.address, carol.address, stranger.address], [E("10"), E("30"), E("60")], false);
      expect(await sdoge.balanceOf(bob.address)).to.equal(b0 + E("10"));
      expect(await sdoge.balanceOf(carol.address)).to.equal(c0 + E("30"));
      expect(await sdoge.balanceOf(stranger.address)).to.equal(s0 + E("60"));
    });

    it("rejects malformed withdrawals", async function () {
      const { alice, bob, staking } = await deployFixture();
      const id = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await time.increase(7 * DAY);
      const w = (amt, rs, ss, who = alice) => staking.connect(who).withdraw(id, amt, rs, ss, false);
      await expect(w(E("100"), [], [])).to.be.revertedWith("1-4 recipients");
      await expect(w(E("100"), Array(5).fill(bob.address), Array(5).fill(E("20")))).to.be.revertedWith(
        "1-4 recipients"
      );
      await expect(w(E("100"), [bob.address], [E("1"), E("1")])).to.be.revertedWith(
        "recipients/amounts length mismatch"
      );
      await expect(w(E("100"), [bob.address], [E("99")])).to.be.revertedWith("split amounts must sum to payout");
      await expect(w(0, [bob.address], [0])).to.be.revertedWith("invalid amount");
      await expect(w(E("101"), [bob.address], [E("101")])).to.be.revertedWith("invalid amount");
      await expect(w(E("100"), [bob.address], [E("100")], bob)).to.be.revertedWith("not your stake");
      await staking.connect(alice).exitStake(id, false);
      await expect(staking.connect(alice).exitStake(id, false)).to.be.revertedWith("stake already closed");
    });

    it("withdraw(..., false) refuses any early withdrawal, even of a few wei", async function () {
      const { owner, alice, staking } = await deployFixture();
      const id = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "100");
      await fund(staking, owner, "7");
      await time.increase(10 * DAY);
      // 6 wei: the 15% penalty rounds to 0, so the split alone couldn't tell it's early
      await expect(staking.connect(alice).withdraw(id, 6n, [alice.address], [6n], false)).to.be.revertedWith(
        "exit would be early"
      );
      await expect(staking.connect(alice).withdraw(id, E("100"), [alice.address], [E("100")], true)).to.be.revertedWith(
        "split amounts must sum to payout"
      );
      expect(await staking.pendingReward(id)).to.be.gt(0); // nothing forfeited
    });
  });

  describe("early exits", function () {
    it("charges 15% of principal and forfeits all accrued reward into the pool", async function () {
      const f = await deployFixture();
      const { owner, alice, sdoge, staking } = f;
      const before = await sdoge.balanceOf(alice.address);
      const id = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "1000");
      await fund(staking, owner, "7");
      await time.increase(3 * DAY);
      const unallocatedBefore = await staking.unallocatedUsdc();
      const [payout, reward, sdogeReward, penalty, forfeited, forfeitedSdoge, early] = await staking.previewExit(id);
      expect(early).to.equal(true);
      expect(payout).to.equal(E("850"));
      expect(reward).to.equal(0);
      expect(sdogeReward).to.equal(0);
      expect(penalty).to.equal(E("150"));
      expect(forfeited).to.be.closeTo(E("3"), E("0.001"));
      expect(forfeitedSdoge).to.equal(0);

      await staking.connect(alice).exitStake(id, true);
      expect(await sdoge.balanceOf(alice.address)).to.equal(before - E("150"));
      // alice was the only staker, so the penalty waits in the pool for the next ones
      expect(await staking.unallocatedSdoge()).to.equal(E("150"));
      expect(await staking.totalPenalties()).to.equal(E("150"));
      expect((await staking.unallocatedUsdc()) - unallocatedBefore).to.be.closeTo(E("3"), E("0.001"));
      await expectBooks(f);
    });

    it("a partial early withdrawal forfeits that stake's whole reward and the rest accrues afresh", async function () {
      const { owner, alice, staking } = await deployFixture();
      const id = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "1000");
      await fund(staking, owner, "7");
      await time.increase(2 * DAY);
      await staking.connect(alice).withdraw(id, E("500"), [alice.address], [E("425")], true);
      expect((await staking.getStake(id)).accruedReward).to.equal(0);
      expect(await staking.pendingReward(id)).to.be.lt(E("0.001"));
      await time.increase(DAY);
      expect(await staking.pendingReward(id)).to.be.closeTo(E("1"), E("0.001"));
    });

    it("counts a stake as matured at 80% of its lock", async function () {
      const { owner, alice, bob, sdoge, staking } = await deployFixture();
      const a = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "100");
      const b = await stakeAndGetId(staking, bob, TIER.THIRTY_DAY, "100");
      await fund(staking, owner, "7");
      await time.increase(24 * DAY - 30);
      await expect(staking.connect(bob).claimReward(b)).to.be.revertedWith(
        "still locked - matures or a full early exit settles reward"
      );
      await time.increase(60);
      await staking.connect(bob).claimReward(b);
      const before = await sdoge.balanceOf(alice.address);
      await staking.connect(alice).exitStake(a, false);
      expect(await sdoge.balanceOf(alice.address)).to.equal(before + E("100"));
    });
  });

  describe("the penalty stays in the pool", function () {
    it("an early exit's 15% streams to the stakers who stay", async function () {
      const f = await deployFixture();
      const { owner, alice, bob, sdoge, staking } = f;
      const a = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "1000");
      const b = await stakeAndGetId(staking, bob, TIER.THIRTY_DAY, "1000");
      await fund(staking, owner, "7"); // rewards have started
      const aliceStart = await sdoge.balanceOf(alice.address);
      await time.increase(DAY);

      await expect(staking.connect(bob).exitStake(b, true))
        .to.emit(staking, "EarlyWithdrawPenalty")
        .withArgs(bob.address, b, E("150"))
        .and.to.emit(staking, "SdogeRewardAdded");
      expect(await staking.unallocatedSdoge()).to.be.lt(E("0.000001")); // only the rounding remainder waits
      expect(await staking.totalPenalties()).to.equal(E("150"));
      await expectBooks(f);

      await time.increase(8 * DAY);
      expect(await staking.pendingSdogeReward(a)).to.be.closeTo(E("150"), E("0.000001"));
      await staking.connect(alice).exitStake(a, false);
      expect((await sdoge.balanceOf(alice.address)) - aliceStart).to.be.closeTo(E("1150"), E("0.000001"));
      expect(await staking.totalSdogeRewardsPaid()).to.be.closeTo(E("150"), E("0.000001"));
      await expectBooks(f);
    });

    it("an early exit forfeits the stake's SDOGE reward too; it streams on to the stakers who stay", async function () {
      const f = await deployFixture();
      const { alice, bob, sdoge, staking } = f;
      const a = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "1000"); // weight 1000
      const b = await stakeAndGetId(staking, bob, TIER.THIRTY_DAY, "1000"); // weight 1200
      const aliceStart = await sdoge.balanceOf(alice.address);
      await fundSdoge(f, "70");
      await time.increase(2 * DAY);

      const [, , , , , forfeitedSdoge] = await staking.previewExit(b);
      expect(forfeitedSdoge).to.be.closeTo((E("20") * 1200n) / 2200n, E("0.001"));
      await expect(staking.connect(bob).exitStake(b, true))
        .to.emit(staking, "SdogeRewardForfeited")
        .and.to.emit(staking, "SdogeRewardAdded");
      await expectBooks(f);

      await time.increase(10 * DAY);
      await staking.connect(alice).exitStake(a, false);
      // alice, who stayed, ends up with every SDOGE reward: the 70 funded and bob's 150 penalty
      expect((await sdoge.balanceOf(alice.address)) - aliceStart).to.be.closeTo(E("1220"), E("0.000001"));
      await expectBooks(f);
    });

    it("matured exits and claims pay both USDC and SDOGE", async function () {
      const f = await deployFixture();
      const { owner, alice, sdoge, staking } = f;
      const id = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await fund(staking, owner, "7");
      await fundSdoge(f, "70");
      await time.increase(7 * DAY);

      const [payout, reward, sdogeReward, penalty, , , early] = await staking.previewExit(id);
      expect([payout, penalty, early]).to.deep.equal([E("100"), 0n, false]);
      expect(reward).to.be.closeTo(E("7"), E("0.001"));
      expect(sdogeReward).to.be.closeTo(E("70"), E("0.001"));

      const before = await sdoge.balanceOf(alice.address);
      await expect(staking.connect(alice).claimReward(id))
        .to.emit(staking, "RewardPaid")
        .and.to.emit(staking, "SdogeRewardPaid");
      expect((await sdoge.balanceOf(alice.address)) - before).to.be.closeTo(E("70"), E("0.001"));
      expect((await staking.getStake(id)).amount).to.equal(E("100"));
      expect(await staking.pendingReward(id)).to.equal(0);
      expect(await staking.pendingSdogeReward(id)).to.equal(0);
      expect(await staking.totalSdogeRewardsPaid()).to.be.closeTo(E("70"), E("0.001"));
      expect(await staking.totalUsdcRewardsPaid()).to.be.closeTo(E("7"), E("0.001"));
      await expectBooks(f);
    });

    it("before the owner starts rewards, nothing streams to whoever is staked", async function () {
      const f = await deployFixture();
      const { alice, bob, stranger, staking } = f;
      const a = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "1000");
      const b = await stakeAndGetId(staking, bob, TIER.THIRTY_DAY, "1000");
      await expect(staking.connect(bob).exitStake(b, true)).to.not.emit(staking, "SdogeRewardAdded");
      expect(await staking.unallocatedSdoge()).to.equal(E("150"));
      expect(await staking.sdogeRewardsOutstanding()).to.equal(0);
      await expect(staking.connect(stranger).notifyUnallocatedSdoge()).to.be.revertedWith(
        "the owner starts the first period"
      );

      await expect(staking.connect(f.owner).notifySdogeRewards(0)).to.emit(staking, "SdogeRewardAdded");
      expect(await staking.rewardsStarted()).to.equal(true);
      await time.increase(8 * DAY);
      expect(await staking.pendingSdogeReward(a)).to.be.closeTo(E("150"), E("0.000001"));
    });

    it("notifySdogeRewards: owner or notifier only, pulls the SDOGE, never slows a running stream", async function () {
      const f = await deployFixture();
      const { owner, alice, stranger, notifier, sdoge, staking } = f;
      await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await expect(staking.connect(stranger).notifySdogeRewards(E("1"))).to.be.revertedWith("not owner or notifier");
      await expect(staking.connect(owner).notifySdogeRewards(0)).to.be.revertedWith(
        "reward rate is 0 (amount too small for duration)"
      );

      await fundSdoge(f, "70");
      expect(await sdoge.balanceOf(owner.address)).to.equal(0);
      const rate = E("70") / BigInt(7 * DAY);
      expect(await staking.sdogeRewardRate()).to.equal(rate);
      expect(await staking.sdogeRewardsOutstanding()).to.equal(rate * BigInt(7 * DAY));
      expect(await staking.getRewardForDuration()).to.equal(0); // the USDC side hasn't started

      await time.increase(DAY);
      await sdoge.mint(owner.address, E("1"));
      await sdoge.connect(owner).approve(await staking.getAddress(), E("1"));
      await expect(staking.connect(owner).notifySdogeRewards(E("1"))).to.be.revertedWith(
        "would slow the current payout"
      );

      await staking.connect(owner).setNotifier(notifier.address);
      const finish = await staking.sdogePeriodFinish();
      await fundSdoge(f, "100", notifier);
      expect(await staking.sdogeRewardRate()).to.be.gte(rate);
      expect(await staking.sdogePeriodFinish()).to.be.gt(finish);
      expect(await staking.sdogeRewardsRemaining()).to.be.closeTo(E("160"), E("0.001"));
      await expectBooks(f);
    });

    it("anyone can stream SDOGE that's waiting, once rewards have started", async function () {
      const f = await deployFixture();
      const { alice, stranger, staking } = f;
      const id = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await fundSdoge(f, "70"); // 10 a day
      await time.increase(DAY);
      // 5 more now would stretch the rest over a new 7 days, paying slower: it waits instead
      await expect(staking.connect(stranger).contributeTokens(E("5"))).to.not.emit(staking, "SdogeRewardAdded");
      expect(await staking.unallocatedSdoge()).to.be.closeTo(E("5"), E("0.000001"));
      await expect(staking.connect(stranger).notifyUnallocatedSdoge()).to.be.revertedWith("nothing to stream right now");

      await time.increase(7 * DAY);
      await expect(staking.connect(stranger).notifyUnallocatedSdoge()).to.emit(staking, "SdogeRewardAdded");
      await time.increase(8 * DAY);
      expect(await staking.pendingSdogeReward(id)).to.be.closeTo(E("75"), E("0.000001"));
      await expectBooks(f);
    });

    it("SDOGE that streams while nobody is staked goes back to the pool", async function () {
      const f = await deployFixture();
      const { alice, bob, staking } = f;
      const a = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await fundSdoge(f, "70");
      await time.increase(6 * DAY);
      await staking.connect(alice).exitStake(a, false); // ~60 paid; nobody is staked for the last day
      await time.increase(2 * DAY);
      await expect(stakeAndGetId(staking, bob, TIER.SEVEN_DAY, "100")).to.not.be.rejected;
      const [event] = await staking.queryFilter(staking.filters.IdleSdogeReturned(), -1);
      expect(event.args.amount).to.be.closeTo(E("10"), E("0.001"));
      // and it streams again, to bob
      expect((await staking.unallocatedSdoge()) + (await staking.sdogeRewardsOutstanding())).to.be.closeTo(
        E("10"),
        E("0.001")
      );
      await expectBooks(f);
    });

    it("donations and stray SDOGE join the SDOGE stream", async function () {
      const f = await deployFixture();
      const { owner, alice, stranger, sdoge, staking } = f;
      const id = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await fund(staking, owner, "7");
      await expect(staking.connect(stranger).contributeTokens(E("10")))
        .to.emit(staking, "TokensContributed")
        .withArgs(stranger.address, E("10"))
        .and.to.emit(staking, "SdogeRewardAdded");
      await sdoge.mint(await staking.getAddress(), E("4"));
      await expect(staking.connect(stranger).absorbSurplus()).to.emit(staking, "SurplusAbsorbed").withArgs(0, E("4"));
      await time.increase(8 * DAY);
      expect(await staking.pendingSdogeReward(id)).to.be.closeTo(E("14"), E("0.000001"));
      await expectBooks(f);
    });

    it("nobody can take the pool's SDOGE out: there is no sweep and no sink", async function () {
      const { owner, sdoge, staking } = await deployFixture();
      const names = staking.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
      for (const fn of ["sweepTokens", "setTokenSink", "tokenSink", "unallocatedTokens"]) expect(names).to.not.include(fn);
      await expect(staking.connect(owner).recoverERC20(await sdoge.getAddress(), 1)).to.be.revertedWith(
        "cannot withdraw the staking token"
      );
    });
  });

  describe("NFT boosts", function () {
    it("an NFT stake gets its design's boost, fixed when the stake opens", async function () {
      const f = await deployFixture();
      const { owner, alice, staking, collectibles } = f;
      await mintNft(f, alice, 2);
      const data = await nftTerms(staking, 2, TIER.THIRTY_DAY, E("1000"));
      const tx = collectibles.connect(alice).safeTransferFrom(alice.address, await staking.getAddress(), 2, 1, data);
      await expect(tx).to.emit(staking, "NftStaked").withArgs(alice.address, 1, 2, 5000);

      const s = await staking.getStake(1);
      expect(s.owner).to.equal(alice.address);
      expect(s.amount).to.equal(E("1000"));
      expect(s.boostBps).to.equal(5000);
      expect(s.holdsNft).to.equal(true);
      expect(s.nftId).to.equal(2);
      expect(s.weighted).to.equal(E("1800")); // 1000 x 1.2 x 1.5
      expect(await staking.weightOf(E("1000"), 12000, 5000)).to.equal(E("1800"));
      expect(await collectibles.balanceOf(await staking.getAddress(), 2)).to.equal(1);
      expect(await collectibles.balanceOf(alice.address, 2)).to.equal(0);
      expect(await staking.nftsStaked()).to.equal(1);

      await staking.connect(owner).setDesignBoosts([2], [1000]);
      expect((await staking.getStake(1)).weighted).to.equal(E("1800"));
      expect(await staking.totalWeightedSupply()).to.equal(E("1800"));
    });

    it("the boost raises the stake's share of both reward streams", async function () {
      const f = await deployFixture();
      const { owner, alice, bob, staking } = f;
      await mintNft(f, alice, 2);
      const a = await stakeWithNft(f, alice, 2, TIER.SEVEN_DAY, "1000"); // weight 1500
      const b = await stakeAndGetId(staking, bob, TIER.SEVEN_DAY, "1000"); // weight 1000
      await fund(staking, owner, "10");
      await fundSdoge(f, "100");
      await time.increase(7 * DAY);
      expect(await staking.pendingReward(a)).to.be.closeTo(E("6"), E("0.001"));
      expect(await staking.pendingReward(b)).to.be.closeTo(E("4"), E("0.001"));
      expect(await staking.pendingSdogeReward(a)).to.be.closeTo(E("60"), E("0.001"));
      expect(await staking.pendingSdogeReward(b)).to.be.closeTo(E("40"), E("0.001"));
    });

    it("the NFT comes back when its stake closes, early or not, and stays through a partial withdrawal", async function () {
      const f = await deployFixture();
      const { alice, bob, sdoge, staking, collectibles } = f;
      const self = await staking.getAddress();
      await mintNft(f, alice, 1);
      await mintNft(f, alice, 2);
      const a = await stakeWithNft(f, alice, 1, TIER.SEVEN_DAY, "1000"); // weight 1100
      const b = await stakeWithNft(f, alice, 2, TIER.THIRTY_DAY, "1000");
      expect(await staking.nftsStaked()).to.equal(2);

      // leaving early costs 15% of the SDOGE, never the NFT
      const before = await sdoge.balanceOf(alice.address);
      await expect(staking.connect(alice).exitStake(b, true)).to.emit(staking, "NftReturned").withArgs(alice.address, b, 2);
      expect(await collectibles.balanceOf(alice.address, 2)).to.equal(1);
      expect((await sdoge.balanceOf(alice.address)) - before).to.equal(E("850"));

      await time.increase(7 * DAY);
      await expect(staking.connect(alice).withdraw(a, E("400"), [alice.address], [E("400")], false)).to.not.emit(
        staking,
        "NftReturned"
      );
      expect(await collectibles.balanceOf(self, 1)).to.equal(1);
      expect((await staking.getStake(a)).weighted).to.equal(E("660"));

      // the NFT goes back to the staker, not to where the SDOGE is split
      await expect(staking.connect(alice).withdraw(a, E("600"), [bob.address], [E("600")], false))
        .to.emit(staking, "NftReturned")
        .withArgs(alice.address, a, 1);
      expect(await collectibles.balanceOf(alice.address, 1)).to.equal(1);
      expect(await collectibles.balanceOf(bob.address, 1)).to.equal(0);
      const s = await staking.getStake(a);
      expect([s.closed, s.holdsNft, s.nftId, s.boostBps]).to.deep.equal([true, false, 1n, 1000n]);
      expect(await staking.nftsStaked()).to.equal(0);
      await expectBooks(f);
    });

    it("refuses anything but one of your own boost NFTs sent with the stake's terms", async function () {
      const f = await deployFixture();
      const { owner, alice, bob, treasury, sdoge, staking, collectibles } = f;
      const self = await staking.getAddress();
      await mintNft(f, alice, 1);
      await mintNft(f, alice, 1);
      await mintNft(f, alice, 3);
      const terms = (designId, tier, amount, boost) => nftTerms(staking, designId, tier, E(amount), boost);
      const send = (who, from, id, value, data) => collectibles.connect(who).safeTransferFrom(from, self, id, value, data);

      await expect(send(alice, alice.address, 1, 1, "0x")).to.be.revertedWith("send the NFT with the stake's terms");
      await expect(send(alice, alice.address, 1, 1, (await terms(1, 0, "100")) + "00")).to.be.revertedWith(
        "send the NFT with the stake's terms"
      );
      await expect(send(alice, alice.address, 1, 2, await terms(1, 0, "100"))).to.be.revertedWith("one NFT per stake");
      await expect(send(alice, alice.address, 1, 1, await terms(1, 0, "100", 999))).to.be.revertedWith("boost changed");
      await expect(send(alice, alice.address, 3, 1, await terms(3, 0, "100"))).to.be.revertedWith(
        "this NFT gives no boost"
      );
      const wrongTier = ethers.AbiCoder.defaultAbiCoder().encode(TERMS, [0, E("100"), 14 * DAY, 10000, 1000]);
      await expect(send(alice, alice.address, 1, 1, wrongTier)).to.be.revertedWith("tier terms changed");
      await expect(send(alice, alice.address, 1, 1, await terms(1, 0, "0"))).to.be.revertedWith("cannot stake 0");
      await expect(
        collectibles.connect(alice).safeBatchTransferFrom(alice.address, self, [1], [1], await terms(1, 0, "100"))
      ).to.be.revertedWith("one NFT per stake");

      // someone approved for alice's NFTs can't stake them for her
      await collectibles.connect(alice).setApprovalForAll(bob.address, true);
      await expect(send(bob, alice.address, 1, 1, await terms(1, 0, "100"))).to.be.revertedWith("stake your own NFT");

      // another collection's NFT, even with the same design id
      const other = await (await ethers.getContractFactory("SDOGECollectibles")).deploy(
        owner.address,
        "ipfs://other/",
        treasury.address
      );
      await other.createDesign(1, "Fake Doge", 10, E("1"), 0);
      await other.setPublicMint(1, true);
      await other.connect(alice).mint(1, 1, { value: E("1") });
      await expect(
        other.connect(alice).safeTransferFrom(alice.address, self, 1, 1, await terms(1, 0, "100"))
      ).to.be.revertedWith("not a boost NFT");
      await expect(
        staking.connect(alice).onERC1155Received(alice.address, alice.address, 1, 1, await terms(1, 0, "100"))
      ).to.be.revertedWith("not a boost NFT");

      // the SDOGE must be approved
      await sdoge.connect(alice).approve(self, 0);
      await expect(send(alice, alice.address, 1, 1, await terms(1, 0, "100"))).to.be.revertedWithCustomError(
        sdoge,
        "ERC20InsufficientAllowance"
      );

      expect(await collectibles.balanceOf(self, 1)).to.equal(0);
      expect(await staking.nextStakeId()).to.equal(1);
    });

    it("boosts: set by the owner only, at most +50%, until locked", async function () {
      const { owner, stranger, sdoge, staking } = await deployFixture();
      await expect(staking.connect(stranger).setDesignBoosts([1], [100])).to.be.revertedWithCustomError(
        staking,
        "OwnableUnauthorizedAccount"
      );
      await expect(staking.connect(owner).setDesignBoosts([1], [5001])).to.be.revertedWith("boost above the maximum");
      await expect(staking.connect(owner).setDesignBoosts([1, 2], [100])).to.be.revertedWith(
        "ids/boosts length mismatch"
      );
      await expect(staking.connect(owner).setDesignBoosts([4], [2500])).to.emit(staking, "DesignBoostSet").withArgs(4, 2500);
      expect(await staking.designBoostBps(4)).to.equal(2500);
      await expect(staking.connect(stranger).lockBoosts()).to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount");
      await expect(staking.connect(owner).lockBoosts()).to.emit(staking, "BoostsLocked");
      expect(await staking.boostsLocked()).to.equal(true);
      await expect(staking.connect(owner).setDesignBoosts([4], [0])).to.be.revertedWith("boosts are locked");
      await expect(staking.connect(owner).lockBoosts()).to.be.revertedWith("boosts are locked");

      const Staking = await ethers.getContractFactory("SDOGEStaking");
      const plain = await Staking.deploy(await sdoge.getAddress(), ethers.ZeroAddress, owner.address);
      await expect(plain.connect(owner).setDesignBoosts([1], [1000])).to.be.revertedWith("no boost collection");
    });

    it("an NFT its wallet refuses on the way back waits for it; the exit still goes through", async function () {
      const f = await deployFixture();
      const { alice, bob, sdoge, staking, collectibles } = f;
      const self = await staking.getAddress();
      const w = await (await ethers.getContractFactory("NftStaker")).deploy(
        self,
        await sdoge.getAddress(),
        await collectibles.getAddress()
      );
      await sdoge.mint(await w.getAddress(), E("100"));
      await w.mintNft(1, { value: E("20") });
      await w.stakeWithNft(1, TIER.SEVEN_DAY, E("100"));
      const id = await w.stakeId();
      expect((await staking.getStake(id)).owner).to.equal(await w.getAddress());
      expect((await staking.getStake(id)).holdsNft).to.equal(true);

      await w.setRefuseNfts(true);
      await time.increase(8 * DAY);
      await expect(w.exit(false)).to.emit(staking, "NftReturnDeferred").withArgs(await w.getAddress(), id, 1);
      expect(await sdoge.balanceOf(await w.getAddress())).to.equal(E("100"));
      expect(await staking.deferredNfts(await w.getAddress(), 1)).to.equal(1);
      expect(await collectibles.balanceOf(self, 1)).to.equal(1);
      expect(await staking.nftsStaked()).to.equal(0);

      await expect(staking.connect(alice).claimDeferredNft(1, alice.address)).to.be.revertedWith("nothing deferred");
      await expect(w.claimDeferredNft(1, ethers.ZeroAddress)).to.be.revertedWith("bad recipient");
      await expect(w.claimDeferredNft(1, bob.address))
        .to.emit(staking, "DeferredNftClaimed")
        .withArgs(await w.getAddress(), bob.address, 1);
      expect(await collectibles.balanceOf(bob.address, 1)).to.equal(1);
      await expect(w.claimDeferredNft(1, bob.address)).to.be.revertedWith("nothing deferred");
    });

    it("tells ERC-165 callers it takes ERC-1155 tokens", async function () {
      const { staking } = await deployFixture();
      expect(await staking.supportsInterface("0x4e2312e0")).to.equal(true); // IERC1155Receiver
      expect(await staking.supportsInterface("0x01ffc9a7")).to.equal(true); // IERC165
      expect(await staking.supportsInterface("0xd9b67a26")).to.equal(false); // IERC1155 itself
    });
  });

  describe("the terms are fixed in the code", function () {
    it("are the published tiers, penalty and maturity point, with no way to change them", async function () {
      const { staking } = await deployFixture();
      const durations = await Promise.all([0, 1, 2, 3, 4].map((t) => staking.tierDuration(t)));
      const multipliers = await Promise.all([0, 1, 2, 3, 4].map((t) => staking.tierMultiplierBps(t)));
      expect(durations.map(Number)).to.deep.equal([7, 30, 90, 180, 365].map((d) => d * DAY));
      expect(multipliers.map(Number)).to.deep.equal([10000, 12000, 15000, 20000, 30000]);
      expect(await staking.earlyWithdrawPenaltyBps()).to.equal(1500);
      expect(await staking.earlyUnlockThresholdBps()).to.equal(8000);
      expect(await staking.MAX_BOOST_BPS()).to.equal(5000);
      await expect(staking.tierDuration(5)).to.be.revertedWith("invalid tier");
      await expect(staking.tierMultiplierBps(5)).to.be.revertedWith("invalid tier");
      const names = staking.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
      for (const setter of ["setTierDuration", "setTierMultiplier", "setEarlyWithdrawPenalty", "setEarlyUnlockThreshold"]) {
        expect(names).to.not.include(setter);
      }
    });

    it("a partial withdrawal removes exactly the stake's own weight", async function () {
      const { alice, bob, staking } = await deployFixture();
      const a = await stakeAndGetId(staking, alice, TIER.THREE_SIXTY_FIVE_DAY, "1000");
      await stakeAndGetId(staking, bob, TIER.NINETY_DAY, "1000");
      expect(await staking.totalWeightedSupply()).to.equal(E("4500"));
      await time.increase(292 * DAY);
      await staking.connect(alice).withdraw(a, E("999"), [alice.address], [E("999")], false);
      expect((await staking.getStake(a)).weighted).to.equal(E("3"));
      expect(await staking.totalWeightedSupply()).to.equal(E("1503"));
      await staking.connect(alice).exitStake(a, false);
      expect(await staking.totalWeightedSupply()).to.equal(E("1500"));
    });

    it("rounding never leaves weight behind on closed stakes", async function () {
      const f = await deployFixture();
      const { alice, bob, staking } = f;
      const a = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, ethers.parseEther("1234.567890123456789012"));
      await mintNft(f, bob, 1);
      const b = await stakeWithNft(f, bob, 1, TIER.NINETY_DAY, ethers.parseEther("777.777777777777777777"));
      await time.increase(80 * DAY);
      const partA = ethers.parseEther("500.000000000000000003");
      await staking.connect(alice).withdraw(a, partA, [alice.address], [partA], false);
      await staking.connect(alice).exitStake(a, false);
      const partB = ethers.parseEther("333.333333333333333331");
      await staking.connect(bob).withdraw(b, partB, [bob.address], [partB], false);
      await staking.connect(bob).exitStake(b, false);
      expect(await staking.totalWeightedSupply()).to.equal(0);
      expect(await staking.totalPrincipalStaked()).to.equal(0);
    });
  });

  describe("rewards", function () {
    it("pays a higher tier proportionally more", async function () {
      const { owner, alice, bob, staking } = await deployFixture();
      const a = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "1000");
      const b = await stakeAndGetId(staking, bob, TIER.THREE_SIXTY_FIVE_DAY, "1000");
      await fund(staking, owner, "8");
      await time.increase(7 * DAY);
      expect(await staking.pendingReward(a)).to.be.closeTo(E("2"), E("0.001"));
      expect(await staking.pendingReward(b)).to.be.closeTo(E("6"), E("0.001"));
    });

    it("splits by size within a tier", async function () {
      const { owner, alice, bob, staking } = await deployFixture();
      const a = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "300");
      const b = await stakeAndGetId(staking, bob, TIER.SEVEN_DAY, "100");
      await fund(staking, owner, "4");
      await time.increase(7 * DAY);
      expect(await staking.pendingReward(a)).to.be.closeTo(E("3"), E("0.001"));
      expect(await staking.pendingReward(b)).to.be.closeTo(E("1"), E("0.001"));
    });

    it("claimReward pays a matured stake without touching principal", async function () {
      const f = await deployFixture();
      const { owner, alice, staking } = f;
      const id = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await fund(staking, owner, "7");
      await time.increase(7 * DAY);
      await expect(staking.connect(alice).claimReward(id)).to.emit(staking, "RewardPaid");
      expect((await staking.getStake(id)).amount).to.equal(E("100"));
      expect(await staking.pendingReward(id)).to.equal(0);
      await expectBooks(f);
    });
  });

  describe("USDC accounting", function () {
    it("rewards streamed before anyone stakes go back to the pool, not nowhere", async function () {
      const f = await deployFixture();
      const { owner, alice, staking } = f;
      await fund(staking, owner, "7");
      await time.increase(2 * DAY);
      const id = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      expect(await staking.unallocatedUsdc()).to.be.closeTo(E("2"), E("0.001"));
      await time.increase(8 * DAY);
      await staking.connect(alice).exitStake(id, false);
      // the 2 USDC nobody earned can be scheduled again
      const id2 = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await staking.connect(owner).notifyRewardAmount();
      await time.increase(8 * DAY);
      expect(await staking.pendingReward(id2)).to.be.closeTo(E("2"), E("0.001"));
      await expectBooks(f);
    });

    it("rewards streamed after everyone exits go back to the pool too", async function () {
      const f = await deployFixture();
      const { owner, alice, bob, staking } = f;
      const id = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await fund(staking, owner, "7");
      await time.increase(6 * DAY);
      await staking.connect(alice).exitStake(id, false);
      await time.increase(2 * DAY);
      await stakeAndGetId(staking, bob, TIER.SEVEN_DAY, "100"); // triggers the global update
      expect(await staking.unallocatedUsdc()).to.be.closeTo(E("1"), E("0.001"));
      await expectBooks(f);
    });

    it("a re-notify can never slow down rewards already promised", async function () {
      const f = await deployFixture();
      const { owner, alice, staking } = f;
      await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await fund(staking, owner, "7");
      const finish = await staking.periodFinish();
      await time.increase(DAY);
      await expect(staking.connect(owner).notifyRewardAmount()).to.be.revertedWith("would slow the current payout");
      await expect(staking.connect(owner).notifyRewardAmount({ value: E("0.1") })).to.be.revertedWith(
        "would slow the current payout"
      );
      const rate = await staking.rewardRate();
      await fund(staking, owner, "2");
      expect(await staking.rewardRate()).to.be.gte(rate);
      expect(await staking.periodFinish()).to.be.gt(finish);
      await expectBooks(f);
    });

    it("refuses to promise more USDC than it holds", async function () {
      const { owner, alice, staking } = await deployFixture();
      await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await fund(staking, owner, "7");
      await network.provider.send("hardhat_setBalance", [await staking.getAddress(), "0x0"]);
      await time.increase(8 * DAY);
      await expect(staking.connect(owner).notifyRewardAmount({ value: E("1") })).to.be.revertedWith(
        "not enough USDC for what's owed"
      );
    });

    it("recoverERC20 can never move the staking token or USDC", async function () {
      const { owner, staking, sdoge } = await deployFixture();
      await expect(staking.connect(owner).recoverERC20(await sdoge.getAddress(), 1)).to.be.revertedWith(
        "cannot withdraw the staking token"
      );
      await expect(staking.connect(owner).recoverERC20(USDC_VIEW, 1)).to.be.revertedWith("cannot withdraw USDC");

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const other = await MockERC20.deploy("Other", "OTH");
      await other.mint(await staking.getAddress(), E("5"));
      await staking.connect(owner).recoverERC20(await other.getAddress(), E("5"));
      expect(await other.balanceOf(owner.address)).to.equal(E("5"));
    });

    it("absorbSurplus turns forced-in USDC and stray SDOGE into pool money", async function () {
      const f = await deployFixture();
      const { owner, alice, stranger, staking, sdoge } = f;
      await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await fund(staking, owner, "7");
      const addr = await staking.getAddress();
      const bal = await balanceOf(addr);
      await network.provider.send("hardhat_setBalance", [addr, ethers.toQuantity(bal + E("5"))]);
      await sdoge.mint(addr, E("42"));
      const unallocatedBefore = await staking.unallocatedUsdc();

      await expect(staking.connect(stranger).absorbSurplus()).to.emit(staking, "SdogeRewardAdded");
      expect((await staking.unallocatedUsdc()) - unallocatedBefore).to.equal(E("5"));
      // the stray SDOGE is already streaming to the stakers
      expect((await staking.unallocatedSdoge()) + (await staking.sdogeRewardsOutstanding())).to.equal(E("42"));
      await expectBooks(f);
      await expect(staking.connect(stranger).absorbSurplus()).to.emit(staking, "SurplusAbsorbed").withArgs(0, 0);
    });

    it("the owner starts the first period; after that anyone can restart an idle pool", async function () {
      const f = await deployFixture();
      const { owner, alice, stranger, staking } = f;
      await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await staking.connect(stranger).contributeUSDC({ value: E("7") });
      await time.increase(30 * DAY);
      // a dust stake made before the team's first notify can't start the stream for itself
      await expect(staking.connect(stranger).notifyUnallocated()).to.be.revertedWith("the owner starts the first period");
      const rate = E("7") / BigInt(7 * DAY); // the rounding remainder waits in the pool
      await expect(staking.connect(owner).notifyRewardAmount())
        .to.emit(staking, "RewardAdded")
        .withArgs(rate * BigInt(7 * DAY), rate, (await time.latest()) + 1 + 7 * DAY);
      await staking.connect(stranger).contributeUSDC({ value: E("7") });
      await expect(staking.connect(stranger).notifyUnallocated()).to.be.revertedWith(
        "owner or notifier schedules for now"
      );
      await time.increase(14 * DAY + 1);
      // RewardAdded reports the USDC added to the stream, not msg.value (0 here)
      await expect(staking.connect(stranger).notifyUnallocated()).to.emit(staking, "RewardAdded");
      const [event] = await staking.queryFilter(staking.filters.RewardAdded(), -1);
      expect(event.args.amount).to.be.closeTo(E("7"), E("0.000001"));
      await expectBooks(f);
      expect(await staking.owner()).to.equal(owner.address);
    });

    it("an idle pool with nobody staked stays put", async function () {
      const { owner, alice, stranger, staking } = await deployFixture();
      const id = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await fund(staking, owner, "7");
      await time.increase(8 * DAY);
      await staking.connect(alice).exitStake(id, false);
      await staking.connect(stranger).contributeUSDC({ value: E("7") });
      await time.increase(8 * DAY);
      await expect(staking.connect(stranger).notifyUnallocated()).to.be.revertedWith("nobody is staked");
      await staking.connect(stranger).contributeTokens(E("7"));
      await expect(staking.connect(stranger).notifyUnallocatedSdoge()).to.be.revertedWith("nothing to stream right now");
    });

    it("stays exactly solvent in both currencies through a long random mix of actions", async function () {
      const f = await deployFixture();
      const { owner, alice, bob, carol, stranger, sdoge, staking, collectibles } = f;
      const addr = await staking.getAddress();
      await sdoge.mint(owner.address, E("1000000"));
      await sdoge.connect(owner).approve(addr, E("1000000"));
      const users = [alice, bob, carol];
      const open = [];
      // mulberry32: a small deterministic generator whose low bits are as random as its high ones
      let seed = Number(process.env.STAKING_SEED || 12345); // STAKING_SEED=n tries another sequence
      const rnd = (n) => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) % n;
      };
      const ran = new Set(); // which kinds of action actually happened
      for (let step = 0; step < 120; step++) {
        const op = rnd(10);
        const u = users[rnd(3)];
        if (op <= 1) {
          const amount = ethers.parseEther(`${1 + rnd(5000)}.123456789`);
          open.push({ u, id: await stakeAndGetId(staking, u, rnd(5), amount) });
          ran.add("stake");
        } else if (op === 2 && open.length) {
          const { u: w, id } = open.splice(rnd(open.length), 1)[0];
          ran.add((await staking.isMature(id)) ? "exit" : "early exit");
          await staking.connect(w).exitStake(id, true);
        } else if (op === 3 && open.length) {
          const { u: w, id } = open[rnd(open.length)];
          if (await staking.isMature(id)) {
            await staking.connect(w).claimReward(id);
            ran.add("claim");
          }
        } else if (op === 4) {
          const running = BigInt(await time.latest()) < (await staking.periodFinish());
          if (!running) {
            await staking.connect(owner).notifyRewardAmount({ value: E(1 + rnd(20)) });
            ran.add("notify USDC");
          }
        } else if (op === 5) {
          await staking.connect(stranger).contributeUSDC({ value: E("0.5") });
          ran.add("contribute USDC");
        } else if (op === 6) {
          const design = 1 + rnd(2);
          await mintNft(f, u, design);
          open.push({ u, id: await stakeWithNft(f, u, design, rnd(5), ethers.parseEther(`${1 + rnd(5000)}.5`)) });
          ran.add("NFT stake");
        } else if (op === 7) {
          const running = BigInt(await time.latest()) < (await staking.sdogePeriodFinish());
          if (!running) {
            await staking.connect(owner).notifySdogeRewards(E(1 + rnd(50)));
            ran.add("notify SDOGE");
          }
        } else if (op === 8) {
          await staking.connect(stranger).contributeTokens(E("3"));
          ran.add("contribute SDOGE");
        } else {
          await time.increase(rnd(20) * DAY + rnd(DAY));
        }
        await expectBooks(f);
        const held = (await collectibles.balanceOf(addr, 1)) + (await collectibles.balanceOf(addr, 2));
        expect(held).to.equal(await staking.nftsStaked());
      }
      if (!process.env.STAKING_SEED) expect([...ran].sort()).to.deep.equal(
        ["NFT stake", "claim", "contribute SDOGE", "contribute USDC", "early exit", "exit", "notify SDOGE", "notify USDC", "stake"].sort()
      );
      await time.increase(400 * DAY);
      for (const { u, id } of open) await staking.connect(u).exitStake(id, false);
      await expectBooks(f);
      expect(await staking.totalWeightedSupply()).to.equal(0);
      expect(await staking.totalPrincipalStaked()).to.equal(0);
      expect(await staking.nftsStaked()).to.equal(0);
      expect(await staking.activeStakers()).to.equal(0);
      // With nobody staked and the stream over, the next update hands per-stake rounding dust
      // back to the pool, so nothing owed in USDC is left but deferred payouts (none here).
      await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "1");
      expect(await staking.rewardsOutstanding()).to.equal(await staking.totalDeferredRewards());
      expect(await staking.rewardsOutstanding()).to.equal(0);
      await expectBooks(f);
    });
  });

  describe("stakers that can't receive USDC", function () {
    it("still get their principal back; the reward waits for them to pull it", async function () {
      const f = await deployFixture();
      const { owner, bob, staking, sdoge } = f;
      const NoReceive = await ethers.getContractFactory("NoReceiveStaker");
      const nr = await NoReceive.deploy(await staking.getAddress(), await sdoge.getAddress());
      await sdoge.mint(await nr.getAddress(), E("100"));
      await nr.approveAndStake(TIER.SEVEN_DAY, E("100"));
      await fund(staking, owner, "7");
      await time.increase(8 * DAY);

      await expect(nr.exit()).to.emit(staking, "RewardDeferred");
      expect(await sdoge.balanceOf(await nr.getAddress())).to.equal(E("100"));
      const owed = await staking.deferredRewards(await nr.getAddress());
      expect(owed).to.be.closeTo(E("7"), E("0.000001"));
      expect(await staking.totalUsdcRewardsPaid()).to.equal(0);
      await expectBooks(f);

      const before = await balanceOf(bob.address);
      await nr.claimDeferred(bob.address);
      expect((await balanceOf(bob.address)) - before).to.equal(owed);
      expect(await staking.deferredRewards(await nr.getAddress())).to.equal(0);
      expect(await staking.totalUsdcRewardsPaid()).to.equal(owed);
      await expectBooks(f);
    });
  });

  describe("contributions", function () {
    it("rejects zero contributions", async function () {
      const { stranger, staking } = await deployFixture();
      await expect(staking.connect(stranger).contributeUSDC()).to.be.revertedWith("send some USDC");
      await expect(staking.connect(stranger).contributeTokens(0)).to.be.revertedWith("cannot contribute 0");
    });
  });

  describe("admin", function () {
    it("only the owner or notifier can schedule rewards; only the owner sets the notifier", async function () {
      const { owner, alice, stranger, notifier, staking } = await deployFixture();
      await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "1");
      await expect(staking.connect(stranger).notifyRewardAmount({ value: E("7") })).to.be.revertedWith(
        "not owner or notifier"
      );
      await expect(staking.connect(stranger).setNotifier(stranger.address)).to.be.revertedWithCustomError(
        staking,
        "OwnableUnauthorizedAccount"
      );
      await staking.connect(owner).setNotifier(notifier.address);
      await staking.connect(notifier).notifyRewardAmount({ value: E("7") });
      await expect(staking.connect(owner).notifyRewardAmount({ value: 1 })).to.be.revertedWith(
        "would slow the current payout"
      );
    });

    it("rejects a funding too small for a nonzero rate", async function () {
      const { owner, staking } = await deployFixture();
      await expect(staking.connect(owner).notifyRewardAmount({ value: 1000 })).to.be.revertedWith(
        "reward rate is 0 (amount too small for duration)"
      );
    });

    it("rewardsDuration changes only between periods, within 1-90 days", async function () {
      const { owner, alice, staking } = await deployFixture();
      await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "1");
      await fund(staking, owner, "7");
      await expect(staking.connect(owner).setRewardsDuration(14 * DAY)).to.be.revertedWith(
        "previous period still active"
      );
      await time.increase(8 * DAY);
      await expect(staking.connect(owner).setRewardsDuration(12 * 3600)).to.be.revertedWith("duration out of range");
      await expect(staking.connect(owner).setRewardsDuration(91 * DAY)).to.be.revertedWith("duration out of range");
      await expect(staking.connect(owner).setRewardsDuration(604800000)).to.be.revertedWith("duration out of range");
      await staking.connect(owner).setRewardsDuration(14 * DAY);
      expect(await staking.rewardsDuration()).to.equal(14 * DAY);
    });

    it("ownership moves in two steps and can't be renounced", async function () {
      const { owner, alice, staking } = await deployFixture();
      await expect(staking.connect(owner).renounceOwnership()).to.be.revertedWith("renounce disabled");
      await staking.connect(owner).transferOwnership(alice.address);
      expect(await staking.owner()).to.equal(owner.address);
      await staking.connect(alice).acceptOwnership();
      expect(await staking.owner()).to.equal(alice.address);
    });

    it("can't be deployed with USDC as the staking token, or a bad boost collection", async function () {
      const { owner, sdoge } = await deployFixture();
      const Staking = await ethers.getContractFactory("SDOGEStaking");
      const token = await sdoge.getAddress();
      await expect(Staking.deploy(USDC_VIEW, ethers.ZeroAddress, owner.address)).to.be.revertedWith(
        "staking token cannot be USDC"
      );
      await expect(Staking.deploy(ethers.ZeroAddress, ethers.ZeroAddress, owner.address)).to.be.revertedWith(
        "staking token is zero address"
      );
      await expect(Staking.deploy(token, token, owner.address)).to.be.revertedWith("bad boost collection");
      await expect(Staking.deploy(token, USDC_VIEW, owner.address)).to.be.revertedWith("bad boost collection");
    });
  });

  describe("invariants", function () {
    it("the SDOGE balance always equals principal plus what's owed in SDOGE", async function () {
      const f = await deployFixture();
      const { owner, alice, bob, stranger, staking } = f;
      const a = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "1000");
      const b = await stakeAndGetId(staking, bob, TIER.SEVEN_DAY, "500");
      await expectBooks(f);
      await fund(staking, owner, "7");
      await staking.connect(stranger).contributeTokens(E("50"));
      await expectBooks(f);
      await staking.connect(alice).exitStake(a, true);
      await expectBooks(f);
      await time.increase(7 * DAY);
      await staking.connect(bob).withdraw(b, E("200"), [bob.address], [E("200")], false);
      await expectBooks(f);
      await staking.connect(bob).claimReward(b);
      await expectBooks(f);
    });
  });

  describe("reentrancy", function () {
    it("a receiver re-entering claimReward gets nothing extra", async function () {
      const f = await deployFixture();
      const { owner, staking, sdoge } = f;
      const Attacker = await ethers.getContractFactory("ReentrantAttacker");
      const attacker = await Attacker.deploy(await staking.getAddress(), await sdoge.getAddress());
      await sdoge.mint(await attacker.getAddress(), E("100"));
      await attacker.approveAndStake(TIER.SEVEN_DAY, E("100"));
      await fund(staking, owner, "7");
      await time.increase(7 * DAY + 1);

      await attacker.claim();
      expect(await attacker.reentryAttempted()).to.equal(true);
      expect(await attacker.reentrySucceeded()).to.equal(false);
      expect(await staking.pendingReward(await attacker.stakeId())).to.equal(0);
      await expectBooks(f);
    });
  });
});
