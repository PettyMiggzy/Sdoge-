const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const TIER = { SEVEN_DAY: 0, THIRTY_DAY: 1, NINETY_DAY: 2, ONE_EIGHTY_DAY: 3, THREE_SIXTY_FIVE_DAY: 4 };
const E = (n) => ethers.parseEther(String(n));
const USDC_VIEW = "0x3600000000000000000000000000000000000000";

async function deployFixture() {
  const [owner, alice, bob, carol, stranger, notifier] = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const sdoge = await MockERC20.deploy("Stable Doge", "SDOGE");

  const Staking = await ethers.getContractFactory("SDOGEStaking");
  const staking = await Staking.deploy(await sdoge.getAddress(), owner.address);

  const amount = E("10000000");
  for (const user of [alice, bob, carol, stranger]) {
    await sdoge.mint(user.address, amount);
    await sdoge.connect(user).approve(await staking.getAddress(), amount);
  }
  return { owner, alice, bob, carol, stranger, notifier, sdoge, staking };
}

// On Arc the reward currency is native USDC; here it's Hardhat's native coin, which is what the
// contract handles.
async function fund(staking, owner, amount) {
  await staking.connect(owner).notifyRewardAmount({ value: E(amount) });
}

async function stakeAndGetId(staking, signer, tier, amount) {
  const [d, m] = await Promise.all([staking.tierDuration(tier), staking.tierMultiplierBps(tier)]);
  const tx = await staking.connect(signer).stake(tier, typeof amount === "bigint" ? amount : E(amount), d, m);
  const receipt = await tx.wait();
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

const balanceOf = (addr) => ethers.provider.getBalance(addr);

// The contract's native balance must always equal exactly what it owes.
async function expectBooksBalance(staking) {
  const bal = await balanceOf(await staking.getAddress());
  const owed = (await staking.unallocatedUsdc()) + (await staking.rewardsOutstanding());
  expect(bal).to.equal(owed);
}

describe("SDOGEStaking", function () {
  describe("staking", function () {
    it("stakes into a tier and snapshots its terms", async function () {
      const { alice, staking } = await deployFixture();
      const id = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "100");
      const start = BigInt(await time.latest());

      const s = await staking.stakes(id);
      expect(s.owner).to.equal(alice.address);
      expect(s.tier).to.equal(TIER.THIRTY_DAY);
      expect(s.multiplierBps).to.equal(12000);
      expect(s.penaltyBps).to.equal(1500);
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

    it("refuses to stake if the tier's terms changed since the page read them", async function () {
      const { owner, alice, staking } = await deployFixture();
      await staking.connect(owner).setTierDuration(TIER.SEVEN_DAY, 10 * DAY);
      await expect(staking.connect(alice).stake(TIER.SEVEN_DAY, E("1"), 7 * DAY, 10000)).to.be.revertedWith(
        "tier terms changed"
      );
      await expect(staking.connect(alice).stake(TIER.SEVEN_DAY, E("1"), 10 * DAY, 12000)).to.be.revertedWith(
        "tier terms changed"
      );
      await staking.connect(alice).stake(TIER.SEVEN_DAY, E("1"), 10 * DAY, 10000);
    });

    it("keeps multiple stakes of one user separate", async function () {
      const { alice, staking } = await deployFixture();
      const a = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      const b = await stakeAndGetId(staking, alice, TIER.THREE_SIXTY_FIVE_DAY, "50");
      expect(a).to.not.equal(b);
      expect(await staking.getStakeIds(alice.address)).to.deep.equal([a, b]);
      expect((await staking.stakes(b)).weighted).to.equal(E("150"));
    });
  });

  describe("exits after maturity", function () {
    it("exitStake returns full principal and the reward", async function () {
      const { owner, alice, sdoge, staking } = await deployFixture();
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
      expect((await staking.stakes(id)).closed).to.equal(true);
      expect(await staking.totalWeightedSupply()).to.equal(0);
      await expectBooksBalance(staking);
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
      await staking.connect(alice).withdraw(id, E("40"), [alice.address], [E("40")]);
      expect(await sdoge.balanceOf(alice.address)).to.equal(before + E("40"));
      const s = await staking.stakes(id);
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
        staking.connect(alice).withdraw(id, E("100"), [bob.address, self], [E("50"), E("50")])
      ).to.be.revertedWith("recipient is the staking contract");
      await expect(
        staking.connect(alice).withdraw(id, E("100"), [bob.address, ethers.ZeroAddress], [E("50"), E("50")])
      ).to.be.revertedWith("recipient is zero address");

      const [b0, c0, s0] = await Promise.all([
        sdoge.balanceOf(bob.address),
        sdoge.balanceOf(carol.address),
        sdoge.balanceOf(stranger.address),
      ]);
      await staking
        .connect(alice)
        .withdraw(id, E("100"), [bob.address, carol.address, stranger.address], [E("10"), E("30"), E("60")]);
      expect(await sdoge.balanceOf(bob.address)).to.equal(b0 + E("10"));
      expect(await sdoge.balanceOf(carol.address)).to.equal(c0 + E("30"));
      expect(await sdoge.balanceOf(stranger.address)).to.equal(s0 + E("60"));
    });

    it("rejects malformed withdrawals", async function () {
      const { alice, bob, staking } = await deployFixture();
      const id = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await time.increase(7 * DAY);
      const w = (amt, rs, ss, who = alice) => staking.connect(who).withdraw(id, amt, rs, ss);
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

    it("a split sized for a matured exit reverts if the stake is still early", async function () {
      const { alice, staking } = await deployFixture();
      const id = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "100");
      await time.increase(10 * DAY);
      await expect(staking.connect(alice).withdraw(id, E("100"), [alice.address], [E("100")])).to.be.revertedWith(
        "split amounts must sum to payout"
      );
    });
  });

  describe("early exits", function () {
    it("charges 15% of principal and forfeits all accrued reward into the pool", async function () {
      const { owner, alice, sdoge, staking } = await deployFixture();
      const before = await sdoge.balanceOf(alice.address);
      const id = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "1000");
      await fund(staking, owner, "7");
      await time.increase(3 * DAY);
      const unallocatedBefore = await staking.unallocatedUsdc();
      const [payout, , penalty, forfeited, early] = await staking.previewExit(id);
      expect(early).to.equal(true);
      expect(payout).to.equal(E("850"));
      expect(penalty).to.equal(E("150"));
      expect(forfeited).to.be.closeTo(E("3"), E("0.001"));

      await staking.connect(alice).exitStake(id, true);
      expect(await sdoge.balanceOf(alice.address)).to.equal(before - E("150"));
      expect(await staking.unallocatedTokens()).to.equal(E("150"));
      expect((await staking.unallocatedUsdc()) - unallocatedBefore).to.be.closeTo(E("3"), E("0.001"));
      await expectBooksBalance(staking);
    });

    it("a partial early withdrawal forfeits that stake's whole reward and the rest accrues afresh", async function () {
      const { owner, alice, staking } = await deployFixture();
      const id = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "1000");
      await fund(staking, owner, "7");
      await time.increase(2 * DAY);
      await staking.connect(alice).withdraw(id, E("500"), [alice.address], [E("425")]);
      expect((await staking.stakes(id)).accruedReward).to.equal(0);
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

  describe("a stake's terms can't change after it opens", function () {
    it("raising the tier's multiplier later doesn't trap the stake", async function () {
      const { owner, alice, staking, sdoge } = await deployFixture();
      const id = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await staking.connect(owner).setTierMultiplier(TIER.SEVEN_DAY, 12000);
      await time.increase(7 * DAY);
      const before = await sdoge.balanceOf(alice.address);
      await staking.connect(alice).exitStake(id, false);
      expect(await sdoge.balanceOf(alice.address)).to.equal(before + E("100"));
      expect(await staking.totalWeightedSupply()).to.equal(0);
    });

    it("lowering it later removes exactly the stake's own weight", async function () {
      const { owner, alice, bob, carol, staking } = await deployFixture();
      const a = await stakeAndGetId(staking, alice, TIER.THREE_SIXTY_FIVE_DAY, "1000");
      await stakeAndGetId(staking, bob, TIER.THREE_SIXTY_FIVE_DAY, "1000");
      await staking.connect(owner).setTierMultiplier(TIER.THREE_SIXTY_FIVE_DAY, 20000);
      await stakeAndGetId(staking, carol, TIER.THREE_SIXTY_FIVE_DAY, "1000");
      expect(await staking.totalWeightedSupply()).to.equal(E("8000"));

      await time.increase(292 * DAY);
      await staking.connect(alice).withdraw(a, E("999"), [alice.address], [E("999")]);
      expect((await staking.stakes(a)).weighted).to.equal(E("3"));
      expect(await staking.totalWeightedSupply()).to.equal(E("5003"));
      await staking.connect(alice).exitStake(a, false);
      expect(await staking.totalWeightedSupply()).to.equal(E("5000"));
    });

    it("penalty and maturity changes only apply to new stakes", async function () {
      const { owner, alice, bob, sdoge, staking } = await deployFixture();
      const a = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "100");
      await staking.connect(owner).setEarlyWithdrawPenalty(3000);
      await staking.connect(owner).setEarlyUnlockThreshold(10000);
      const b = await stakeAndGetId(staking, bob, TIER.THIRTY_DAY, "100");
      expect((await staking.stakes(b)).penaltyBps).to.equal(3000);

      await time.increase(25 * DAY);
      const before = await sdoge.balanceOf(alice.address);
      await staking.connect(alice).exitStake(a, false); // matured at day 24 under ITS terms
      expect(await sdoge.balanceOf(alice.address)).to.equal(before + E("100"));

      await expect(staking.connect(bob).exitStake(b, false)).to.be.revertedWith("exit would be early");
      const [payout] = await staking.previewExit(b);
      expect(payout).to.equal(E("70"));
    });

    it("rounding never leaves weight behind on closed stakes", async function () {
      const { alice, bob, staking } = await deployFixture();
      const a = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, ethers.parseEther("1234.567890123456789012"));
      const b = await stakeAndGetId(staking, bob, TIER.NINETY_DAY, ethers.parseEther("777.777777777777777777"));
      await time.increase(80 * DAY);
      const partA = ethers.parseEther("500.000000000000000003");
      await staking.connect(alice).withdraw(a, partA, [alice.address], [partA]);
      await staking.connect(alice).exitStake(a, false);
      const partB = ethers.parseEther("333.333333333333333331");
      await staking.connect(bob).withdraw(b, partB, [bob.address], [partB]);
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
      const { owner, alice, staking } = await deployFixture();
      const id = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await fund(staking, owner, "7");
      await time.increase(7 * DAY);
      await expect(staking.connect(alice).claimReward(id)).to.emit(staking, "RewardPaid");
      expect((await staking.stakes(id)).amount).to.equal(E("100"));
      expect(await staking.pendingReward(id)).to.equal(0);
      await expectBooksBalance(staking);
    });
  });

  describe("USDC accounting", function () {
    it("rewards streamed before anyone stakes go back to the pool, not nowhere", async function () {
      const { owner, alice, staking } = await deployFixture();
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
      await expectBooksBalance(staking);
    });

    it("rewards streamed after everyone exits go back to the pool too", async function () {
      const { owner, alice, bob, staking } = await deployFixture();
      const id = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await fund(staking, owner, "7");
      await time.increase(6 * DAY);
      await staking.connect(alice).exitStake(id, false);
      await time.increase(2 * DAY);
      await stakeAndGetId(staking, bob, TIER.SEVEN_DAY, "100"); // triggers the global update
      expect(await staking.unallocatedUsdc()).to.be.closeTo(E("1"), E("0.001"));
      await expectBooksBalance(staking);
    });

    it("a re-notify can never slow down rewards already promised", async function () {
      const { owner, alice, staking } = await deployFixture();
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
      await expectBooksBalance(staking);
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
      const { owner, alice, stranger, staking, sdoge } = await deployFixture();
      await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await fund(staking, owner, "7");
      const addr = await staking.getAddress();
      const bal = await balanceOf(addr);
      await network.provider.send("hardhat_setBalance", [addr, ethers.toQuantity(bal + E("5"))]);
      await sdoge.mint(addr, E("42"));
      const unallocatedBefore = await staking.unallocatedUsdc();

      await staking.connect(stranger).absorbSurplus();
      expect((await staking.unallocatedUsdc()) - unallocatedBefore).to.equal(E("5"));
      expect(await staking.unallocatedTokens()).to.equal(E("42"));
      await expectBooksBalance(staking);
      await expect(staking.connect(stranger).absorbSurplus()).to.emit(staking, "SurplusAbsorbed").withArgs(0, 0);
    });

    it("anyone can restart rewards from the pool once it's been idle for a week", async function () {
      const { owner, alice, stranger, staking } = await deployFixture();
      await expect(staking.connect(stranger).notifyUnallocated()).to.be.revertedWith("nobody is staked");
      await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await staking.connect(stranger).contributeUSDC({ value: E("7") });
      await staking.connect(stranger).notifyUnallocated(); // no period has ever run
      await staking.connect(stranger).contributeUSDC({ value: E("7") });
      await expect(staking.connect(stranger).notifyUnallocated()).to.be.revertedWith(
        "owner or notifier schedules for now"
      );
      await time.increase(14 * DAY + 1);
      await staking.connect(stranger).notifyUnallocated();
      await expectBooksBalance(staking);
      expect(await staking.owner()).to.equal(owner.address);
    });

    it("stays exactly solvent through a long random mix of actions", async function () {
      const { owner, alice, bob, carol, stranger, staking } = await deployFixture();
      const users = [alice, bob, carol];
      const open = [];
      let seed = 12345;
      const rnd = (n) => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed % n;
      };
      for (let step = 0; step < 90; step++) {
        const op = rnd(7);
        if (op <= 1) {
          const u = users[rnd(3)];
          const amount = ethers.parseEther(`${1 + rnd(5000)}.123456789`);
          open.push({ u, id: await stakeAndGetId(staking, u, rnd(5), amount) });
        } else if (op === 2 && open.length) {
          const { u, id } = open.splice(rnd(open.length), 1)[0];
          await staking.connect(u).exitStake(id, true);
        } else if (op === 3 && open.length) {
          const { u, id } = open[rnd(open.length)];
          if (await staking.isMature(id)) await staking.connect(u).claimReward(id);
        } else if (op === 4) {
          const running = BigInt(await time.latest()) < (await staking.periodFinish());
          if (!running) await staking.connect(owner).notifyRewardAmount({ value: E(1 + rnd(20)) });
        } else if (op === 5) {
          await staking.connect(stranger).contributeUSDC({ value: E("0.5") });
        } else {
          await time.increase(rnd(20) * DAY + rnd(DAY));
        }
        await expectBooksBalance(staking);
      }
      await time.increase(400 * DAY);
      for (const { u, id } of open) await staking.connect(u).exitStake(id, false);
      await expectBooksBalance(staking);
      expect(await staking.totalWeightedSupply()).to.equal(0);
      // With nobody staked and the stream over, the next update hands per-stake rounding dust
      // back to the pool, so nothing owed is left but deferred payouts (none here).
      await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "1");
      expect(await staking.rewardsOutstanding()).to.equal(await staking.totalDeferredRewards());
      expect(await staking.rewardsOutstanding()).to.equal(0);
      await expectBooksBalance(staking);
    });
  });

  describe("stakers that can't receive USDC", function () {
    it("still get their principal back; the reward waits for them to pull it", async function () {
      const { owner, bob, staking, sdoge } = await deployFixture();
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
      await expectBooksBalance(staking);

      const before = await balanceOf(bob.address);
      await nr.claimDeferred(bob.address);
      expect((await balanceOf(bob.address)) - before).to.equal(owed);
      expect(await staking.deferredRewards(await nr.getAddress())).to.equal(0);
      await expectBooksBalance(staking);
    });
  });

  describe("tokens: contributions and sweeps", function () {
    it("sweeps only to the owner-set sink; the notifier can trigger but not choose", async function () {
      const { owner, alice, carol, stranger, notifier, sdoge, staking } = await deployFixture();
      await staking.connect(owner).setNotifier(notifier.address);
      await staking.connect(stranger).contributeTokens(E("10"));
      const id = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "100");
      await staking.connect(alice).exitStake(id, true); // 15 penalty
      expect(await staking.unallocatedTokens()).to.equal(E("25"));

      await expect(staking.connect(stranger).sweepTokens()).to.be.revertedWith("not owner or notifier");
      const before = await sdoge.balanceOf(owner.address);
      await staking.connect(notifier).sweepTokens();
      expect(await sdoge.balanceOf(owner.address)).to.equal(before + E("25"));
      await expect(staking.connect(notifier).sweepTokens()).to.be.revertedWith("nothing to sweep");

      await expect(staking.connect(notifier).setTokenSink(notifier.address)).to.be.revertedWithCustomError(
        staking,
        "OwnableUnauthorizedAccount"
      );
      await expect(staking.connect(owner).setTokenSink(ethers.ZeroAddress)).to.be.revertedWith("bad sink");
      await staking.connect(owner).setTokenSink(carol.address);
      await staking.connect(stranger).contributeTokens(E("5"));
      const c0 = await sdoge.balanceOf(carol.address);
      await staking.connect(owner).sweepTokens();
      expect(await sdoge.balanceOf(carol.address)).to.equal(c0 + E("5"));
    });

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

    it("penalty is capped at 30% and the threshold stays in (0%, 100%]", async function () {
      const { owner, alice, staking } = await deployFixture();
      await expect(staking.connect(owner).setEarlyWithdrawPenalty(3001)).to.be.revertedWith("penalty too high");
      await expect(staking.connect(alice).setEarlyWithdrawPenalty(1000)).to.be.revertedWithCustomError(
        staking,
        "OwnableUnauthorizedAccount"
      );
      await expect(staking.connect(owner).setEarlyUnlockThreshold(0)).to.be.revertedWith("threshold out of range");
      await expect(staking.connect(owner).setEarlyUnlockThreshold(10001)).to.be.revertedWith("threshold out of range");
      await staking.connect(owner).setEarlyWithdrawPenalty(3000);
      await staking.connect(owner).setEarlyUnlockThreshold(10000);
    });

    it("tier multipliers stay within 1x-10x and in tier order", async function () {
      const { owner, staking } = await deployFixture();
      await expect(staking.connect(owner).setTierMultiplier(0, 9999)).to.be.revertedWith("multiplier out of range");
      await expect(staking.connect(owner).setTierMultiplier(4, 100001)).to.be.revertedWith("multiplier out of range");
      await expect(staking.connect(owner).setTierMultiplier(0, 12001)).to.be.revertedWith("above the tier over it");
      await expect(staking.connect(owner).setTierMultiplier(2, 11999)).to.be.revertedWith("below the tier under it");
      await expect(staking.connect(owner).setTierMultiplier(5, 20000)).to.be.revertedWith("invalid tier");
      await staking.connect(owner).setTierMultiplier(4, 100000);
      await staking.connect(owner).setTierMultiplier(0, 12000);
    });

    it("tier durations stay within 1 day-5 years and strictly in tier order", async function () {
      const { owner, alice, staking } = await deployFixture();
      const id = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "1");
      const unlock = (await staking.stakes(id)).unlockTime;
      await expect(staking.connect(owner).setTierDuration(0, 12 * 3600)).to.be.revertedWith("duration out of range");
      await expect(staking.connect(owner).setTierDuration(4, 6 * 365 * DAY)).to.be.revertedWith(
        "duration out of range"
      );
      await expect(staking.connect(owner).setTierDuration(0, 30 * DAY)).to.be.revertedWith(
        "not shorter than the tier over it"
      );
      await expect(staking.connect(owner).setTierDuration(2, 30 * DAY)).to.be.revertedWith(
        "not longer than the tier under it"
      );
      await staking.connect(owner).setTierDuration(0, 14 * DAY);
      expect((await staking.stakes(id)).unlockTime).to.equal(unlock, "open stakes keep their lock");
    });

    it("ownership moves in two steps and can't be renounced", async function () {
      const { owner, alice, staking } = await deployFixture();
      await expect(staking.connect(owner).renounceOwnership()).to.be.revertedWith("renounce disabled");
      await staking.connect(owner).transferOwnership(alice.address);
      expect(await staking.owner()).to.equal(owner.address);
      await staking.connect(alice).acceptOwnership();
      expect(await staking.owner()).to.equal(alice.address);
    });

    it("can't be deployed with USDC as the staking token", async function () {
      const { owner } = await deployFixture();
      const Staking = await ethers.getContractFactory("SDOGEStaking");
      await expect(Staking.deploy(USDC_VIEW, owner.address)).to.be.revertedWith("staking token cannot be USDC");
      await expect(Staking.deploy(ethers.ZeroAddress, owner.address)).to.be.revertedWith(
        "staking token is zero address"
      );
    });
  });

  describe("invariants", function () {
    it("the SDOGE balance always equals principal plus unallocated tokens", async function () {
      const { owner, alice, bob, stranger, sdoge, staking } = await deployFixture();
      const addr = await staking.getAddress();
      const check = async () =>
        expect(await sdoge.balanceOf(addr)).to.equal(
          (await staking.totalPrincipalStaked()) + (await staking.unallocatedTokens())
        );
      const a = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "1000");
      const b = await stakeAndGetId(staking, bob, TIER.SEVEN_DAY, "500");
      await check();
      await staking.connect(stranger).contributeTokens(E("50"));
      await check();
      await staking.connect(alice).exitStake(a, true);
      await check();
      await time.increase(7 * DAY);
      await staking.connect(bob).withdraw(b, E("200"), [bob.address], [E("200")]);
      await check();
      await staking.connect(owner).sweepTokens();
      await check();
    });
  });

  describe("reentrancy", function () {
    it("a receiver re-entering claimReward gets nothing extra", async function () {
      const { owner, staking, sdoge } = await deployFixture();
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
      await expectBooksBalance(staking);
    });
  });
});
