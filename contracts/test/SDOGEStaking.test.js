const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;

async function deployFixture() {
  const [owner, alice, bob, stranger] = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const sdoge = await MockERC20.deploy("Stable Doge", "SDOGE");

  const Staking = await ethers.getContractFactory("SDOGEStaking");
  const staking = await Staking.deploy(await sdoge.getAddress(), owner.address);

  const amount = ethers.parseEther("1000000");
  for (const user of [alice, bob, stranger]) {
    await sdoge.mint(user.address, amount);
    await sdoge.connect(user).approve(await staking.getAddress(), amount);
  }

  return { owner, alice, bob, stranger, sdoge, staking };
}

// Native-value funding helper - on Arc this would be real USDC, here it's
// the Hardhat network's native currency, which is what the contract expects.
async function fund(staking, owner, amountEth) {
  await staking.connect(owner).notifyRewardAmount({ value: ethers.parseEther(amountEth) });
}

describe("SDOGEStaking", function () {
  describe("staking and withdrawing", function () {
    it("stakes and tracks balances/totalSupply correctly", async function () {
      const { alice, sdoge, staking } = await deployFixture();
      await staking.connect(alice).stake(ethers.parseEther("100"));

      expect(await staking.balanceOf(alice.address)).to.equal(ethers.parseEther("100"));
      expect(await staking.totalSupply()).to.equal(ethers.parseEther("100"));
      expect(await sdoge.balanceOf(await staking.getAddress())).to.equal(ethers.parseEther("100"));
    });

    it("rejects staking 0", async function () {
      const { alice, staking } = await deployFixture();
      await expect(staking.connect(alice).stake(0)).to.be.revertedWith("cannot stake 0");
    });

    it("withdraws principal back and updates balances", async function () {
      const { alice, sdoge, staking } = await deployFixture();
      await staking.connect(alice).stake(ethers.parseEther("100"));
      await time.increase(7 * DAY + 1); // clear of the early-withdrawal window - see that describe block
      const before = await sdoge.balanceOf(alice.address);

      await staking.connect(alice).withdraw(ethers.parseEther("40"));

      expect(await staking.balanceOf(alice.address)).to.equal(ethers.parseEther("60"));
      expect(await sdoge.balanceOf(alice.address)).to.equal(before + ethers.parseEther("40"));
    });

    it("rejects withdrawing 0 or more than staked", async function () {
      const { alice, staking } = await deployFixture();
      await staking.connect(alice).stake(ethers.parseEther("100"));
      await expect(staking.connect(alice).withdraw(0)).to.be.revertedWith("cannot withdraw 0");
      await expect(staking.connect(alice).withdraw(ethers.parseEther("101"))).to.be.revertedWith(
        "withdraw amount exceeds balance"
      );
    });
  });

  describe("early withdrawal penalty", function () {
    it("applies the default 15% penalty when withdrawing within the window", async function () {
      const { alice, sdoge, staking } = await deployFixture();
      await staking.connect(alice).stake(ethers.parseEther("100"));
      const before = await sdoge.balanceOf(alice.address);

      await expect(staking.connect(alice).withdraw(ethers.parseEther("100")))
        .to.emit(staking, "EarlyWithdrawPenalty")
        .withArgs(alice.address, ethers.parseEther("15"));

      expect(await sdoge.balanceOf(alice.address)).to.equal(before + ethers.parseEther("85"));
      expect(await staking.pendingPenalties()).to.equal(ethers.parseEther("15"));
    });

    it("charges no penalty once earlyWithdrawWindow has passed", async function () {
      const { alice, sdoge, staking } = await deployFixture();
      await staking.connect(alice).stake(ethers.parseEther("100"));
      await time.increase(7 * DAY + 1);
      const before = await sdoge.balanceOf(alice.address);

      await staking.connect(alice).withdraw(ethers.parseEther("100"));

      expect(await sdoge.balanceOf(alice.address)).to.equal(before + ethers.parseEther("100"));
      expect(await staking.pendingPenalties()).to.equal(0);
    });

    it("resets the window on every additional stake", async function () {
      const { alice, staking } = await deployFixture();
      await staking.connect(alice).stake(ethers.parseEther("100"));
      await time.increase(7 * DAY + 1); // clear of the window
      await staking.connect(alice).stake(ethers.parseEther("1")); // top-up resets the clock

      await expect(staking.connect(alice).withdraw(ethers.parseEther("101"))).to.emit(
        staking,
        "EarlyWithdrawPenalty"
      );
    });

    it("accumulates penalties from multiple stakers", async function () {
      const { alice, bob, staking } = await deployFixture();
      await staking.connect(alice).stake(ethers.parseEther("100"));
      await staking.connect(bob).stake(ethers.parseEther("200"));

      await staking.connect(alice).withdraw(ethers.parseEther("100")); // 15 penalty
      await staking.connect(bob).withdraw(ethers.parseEther("200")); // 30 penalty

      expect(await staking.pendingPenalties()).to.equal(ethers.parseEther("45"));
    });

    it("exit() applies the penalty too, since it calls withdraw() internally", async function () {
      const { alice, sdoge, staking } = await deployFixture();
      await staking.connect(alice).stake(ethers.parseEther("100"));
      const before = await sdoge.balanceOf(alice.address);

      await staking.connect(alice).exit();

      expect(await sdoge.balanceOf(alice.address)).to.equal(before + ethers.parseEther("85"));
    });

    it("never lets a penalty touch other stakers' principal - full accounting invariant", async function () {
      const { alice, bob, sdoge, staking } = await deployFixture();
      await staking.connect(alice).stake(ethers.parseEther("100"));
      await staking.connect(bob).stake(ethers.parseEther("200"));
      await staking.connect(alice).withdraw(ethers.parseEther("100")); // early - 15 penalty

      const contractBalance = await sdoge.balanceOf(await staking.getAddress());
      const totalSupply = await staking.totalSupply();
      const pending = await staking.pendingPenalties();
      expect(contractBalance).to.equal(totalSupply + pending);

      // Bob's full 200 must still be withdrawable in full once he's clear of his own window.
      await time.increase(7 * DAY + 1);
      const bobBefore = await sdoge.balanceOf(bob.address);
      await staking.connect(bob).withdraw(ethers.parseEther("200"));
      expect(await sdoge.balanceOf(bob.address)).to.equal(bobBefore + ethers.parseEther("200"));
    });
  });

  describe("sweeping penalties", function () {
    it("lets owner or notifier sweep accumulated penalties out", async function () {
      const { owner, alice, sdoge, staking } = await deployFixture();
      await staking.connect(alice).stake(ethers.parseEther("100"));
      await staking.connect(alice).withdraw(ethers.parseEther("100")); // 15 penalty accrues

      const treasury = ethers.Wallet.createRandom().address;
      await expect(staking.connect(owner).sweepPenalties(treasury))
        .to.emit(staking, "PenaltiesSwept")
        .withArgs(treasury, ethers.parseEther("15"));

      expect(await sdoge.balanceOf(treasury)).to.equal(ethers.parseEther("15"));
      expect(await staking.pendingPenalties()).to.equal(0);
    });

    it("lets a designated notifier sweep penalties without being owner", async function () {
      const { owner, alice, bob, staking } = await deployFixture();
      await staking.connect(owner).setNotifier(bob.address);
      await staking.connect(alice).stake(ethers.parseEther("100"));
      await staking.connect(alice).withdraw(ethers.parseEther("100"));

      await expect(staking.connect(bob).sweepPenalties(bob.address)).to.not.be.reverted;
    });

    it("rejects sweeping from a random address", async function () {
      const { alice, staking } = await deployFixture();
      await staking.connect(alice).stake(ethers.parseEther("100"));
      await staking.connect(alice).withdraw(ethers.parseEther("100"));

      await expect(staking.connect(alice).sweepPenalties(alice.address)).to.be.revertedWith(
        "not owner or notifier"
      );
    });

    it("rejects sweeping to the zero address", async function () {
      const { owner, alice, staking } = await deployFixture();
      await staking.connect(alice).stake(ethers.parseEther("100"));
      await staking.connect(alice).withdraw(ethers.parseEther("100"));

      await expect(staking.connect(owner).sweepPenalties(ethers.ZeroAddress)).to.be.revertedWith(
        "cannot sweep to zero address"
      );
    });

    it("rejects sweeping when there's nothing to sweep", async function () {
      const { owner, staking } = await deployFixture();
      await expect(staking.connect(owner).sweepPenalties(owner.address)).to.be.revertedWith(
        "no penalties to sweep"
      );
    });
  });

  describe("early withdrawal settings", function () {
    it("only the owner can change penalty settings", async function () {
      const { alice, staking } = await deployFixture();
      await expect(
        staking.connect(alice).setEarlyWithdrawSettings(1000, DAY)
      ).to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount");
    });

    it("rejects a penalty above the 30% cap", async function () {
      const { owner, staking } = await deployFixture();
      await expect(staking.connect(owner).setEarlyWithdrawSettings(3001, DAY)).to.be.revertedWith(
        "penalty too high"
      );
    });

    it("applies updated settings to subsequent withdrawals", async function () {
      const { owner, alice, sdoge, staking } = await deployFixture();
      await staking.connect(owner).setEarlyWithdrawSettings(500, DAY); // 5%, 1-day window
      await staking.connect(alice).stake(ethers.parseEther("100"));
      const before = await sdoge.balanceOf(alice.address);

      await staking.connect(alice).withdraw(ethers.parseEther("100"));

      expect(await sdoge.balanceOf(alice.address)).to.equal(before + ethers.parseEther("95"));
    });
  });

  describe("reward accrual", function () {
    it("pays a single staker ~all of a fully-elapsed reward period", async function () {
      const { owner, alice, staking } = await deployFixture();
      await staking.connect(alice).stake(ethers.parseEther("100"));
      await fund(staking, owner, "7"); // 7 native ETH over the default 7-day duration

      await time.increase(7 * DAY);

      const earned = await staking.earned(alice.address);
      // Integer-division dust only (rate = amount / duration truncates) -
      // must be very close to, and never more than, what was funded.
      expect(earned).to.be.closeTo(ethers.parseEther("7"), ethers.parseEther("0.001"));
      expect(earned).to.be.lte(ethers.parseEther("7"));
    });

    it("splits rewards proportionally to stake size and time staked", async function () {
      const { owner, alice, bob, staking } = await deployFixture();

      // Alice stakes first and alone for half the period.
      await staking.connect(alice).stake(ethers.parseEther("100"));
      await fund(staking, owner, "7");
      await time.increase(3.5 * DAY);

      // Bob joins with an equal stake for the second half.
      await staking.connect(bob).stake(ethers.parseEther("100"));
      await time.increase(3.5 * DAY);

      const aliceEarned = await staking.earned(alice.address);
      const bobEarned = await staking.earned(bob.address);

      // Alice: all of the first half (~3.5) + half of the second half (~1.75) = ~5.25
      // Bob: half of the second half (~1.75)
      expect(aliceEarned).to.be.closeTo(ethers.parseEther("5.25"), ethers.parseEther("0.01"));
      expect(bobEarned).to.be.closeTo(ethers.parseEther("1.75"), ethers.parseEther("0.01"));

      // Total paid out never exceeds what was funded.
      expect(aliceEarned + bobEarned).to.be.lte(ethers.parseEther("7"));
    });

    it("actually pays out native currency on getReward(), zeroing the claim", async function () {
      const { owner, alice, staking } = await deployFixture();
      await staking.connect(alice).stake(ethers.parseEther("100"));
      await fund(staking, owner, "7");
      await time.increase(7 * DAY);

      const before = await ethers.provider.getBalance(alice.address);
      const tx = await staking.connect(alice).getReward();
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const after = await ethers.provider.getBalance(alice.address);

      expect(after - before + gasCost).to.be.closeTo(ethers.parseEther("7"), ethers.parseEther("0.001"));
      expect(await staking.earned(alice.address)).to.equal(0);
    });

    it("exit() withdraws principal and claims reward in one call", async function () {
      const { owner, alice, sdoge, staking } = await deployFixture();
      await staking.connect(alice).stake(ethers.parseEther("100"));
      await fund(staking, owner, "7");
      await time.increase(7 * DAY);

      await staking.connect(alice).exit();

      expect(await staking.balanceOf(alice.address)).to.equal(0);
      expect(await sdoge.balanceOf(alice.address)).to.equal(ethers.parseEther("1000000")); // fully restored
      expect(await staking.earned(alice.address)).to.equal(0);
    });

    it("rolls unpaid remainder of an active period into a new notifyRewardAmount", async function () {
      const { owner, alice, staking } = await deployFixture();
      await staking.connect(alice).stake(ethers.parseEther("100"));
      await fund(staking, owner, "7");
      await time.increase(3.5 * DAY); // half the period elapses, ~3.5 earned/unclaimed

      // Fund again mid-period with another 7 - the ~3.5 leftover should
      // roll in, not vanish.
      await fund(staking, owner, "7");
      await time.increase(7 * DAY);

      const earned = await staking.earned(alice.address);
      // ~3.5 (first half) + ~10.5 (leftover 3.5 + new 7, over a fresh 7-day window)
      expect(earned).to.be.closeTo(ethers.parseEther("14"), ethers.parseEther("0.01"));
    });
  });

  describe("admin controls", function () {
    it("only the owner or notifier can fund rewards", async function () {
      const { alice, staking } = await deployFixture();
      await expect(
        staking.connect(alice).notifyRewardAmount({ value: ethers.parseEther("1") })
      ).to.be.revertedWith("not owner or notifier");
    });

    it("only the owner can set the notifier", async function () {
      const { alice, staking } = await deployFixture();
      await expect(staking.connect(alice).setNotifier(alice.address)).to.be.revertedWithCustomError(
        staking,
        "OwnableUnauthorizedAccount"
      );
    });

    it("lets a designated notifier fund rewards without being owner", async function () {
      const { owner, alice, staking } = await deployFixture();
      await staking.connect(owner).setNotifier(alice.address);

      await expect(staking.connect(alice).notifyRewardAmount({ value: ethers.parseEther("7") })).to.not.be.reverted;
      expect(await staking.rewardRate()).to.equal(ethers.parseEther("7") / BigInt(7 * DAY));
    });

    it("revokes notifier access by setting it back to address(0)", async function () {
      const { owner, alice, staking } = await deployFixture();
      await staking.connect(owner).setNotifier(alice.address);
      await staking.connect(owner).setNotifier(ethers.ZeroAddress);

      await expect(
        staking.connect(alice).notifyRewardAmount({ value: ethers.parseEther("1") })
      ).to.be.revertedWith("not owner or notifier");
    });

    it("rejects a reward funding too small to produce a nonzero rate", async function () {
      const { owner, staking } = await deployFixture();
      await expect(
        staking.connect(owner).notifyRewardAmount({ value: 1n })
      ).to.be.revertedWith("reward rate is 0 (amount too small for duration)");
    });

    it("only the owner can change rewardsDuration, and only between periods", async function () {
      const { owner, alice, staking } = await deployFixture();
      await expect(staking.connect(alice).setRewardsDuration(DAY)).to.be.revertedWithCustomError(
        staking,
        "OwnableUnauthorizedAccount"
      );

      await fund(staking, owner, "7");
      await expect(staking.connect(owner).setRewardsDuration(DAY)).to.be.revertedWith(
        "previous period still active"
      );

      await time.increase(7 * DAY);
      await staking.connect(owner).setRewardsDuration(DAY);
      expect(await staking.rewardsDuration()).to.equal(DAY);
    });

    it("recoverERC20 can rescue an unrelated token but never the staking token", async function () {
      const { owner, staking, sdoge } = await deployFixture();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const other = await MockERC20.deploy("Random", "RND");
      await other.mint(await staking.getAddress(), ethers.parseEther("50"));

      await expect(staking.connect(owner).recoverERC20(await sdoge.getAddress(), 1)).to.be.revertedWith(
        "cannot withdraw the staking token"
      );

      await staking.connect(owner).recoverERC20(await other.getAddress(), ethers.parseEther("50"));
      expect(await other.balanceOf(owner.address)).to.equal(ethers.parseEther("50"));
    });
  });

  describe("reentrancy", function () {
    it("blocks a reentrant getReward() call from a malicious receiver", async function () {
      const { owner, staking, sdoge } = await deployFixture();

      const Attacker = await ethers.getContractFactory("ReentrantAttacker");
      const attacker = await Attacker.deploy(await staking.getAddress(), await sdoge.getAddress());

      await sdoge.mint(await attacker.getAddress(), ethers.parseEther("100"));
      await attacker.approveAndStake(ethers.parseEther("100"));

      await fund(staking, owner, "7");
      await time.increase(7 * DAY);

      await attacker.claim();

      expect(await attacker.reentryAttempted()).to.equal(true);
      expect(await attacker.reentrySucceeded()).to.equal(false);
      // The legitimate first claim still succeeded despite the blocked reentry.
      expect(await staking.earned(await attacker.getAddress())).to.equal(0);
    });
  });
});
