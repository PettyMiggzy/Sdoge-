const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const TIER = { SEVEN_DAY: 0, THIRTY_DAY: 1, NINETY_DAY: 2, ONE_EIGHTY_DAY: 3, THREE_SIXTY_FIVE_DAY: 4 };

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

async function stakeAndGetId(staking, signer, tier, amountEth) {
  const tx = await staking.connect(signer).stake(tier, ethers.parseEther(amountEth));
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    try {
      const parsed = staking.interface.parseLog(log);
      if (parsed && parsed.name === "Staked") return parsed.args.stakeId;
    } catch {
      // not one of this contract's events - ignore
    }
  }
  throw new Error("Staked event not found");
}

describe("SDOGEStaking", function () {
  describe("staking", function () {
    it("stakes into a tier and records correct state", async function () {
      const { alice, sdoge, staking } = await deployFixture();
      const stakeId = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "100");

      const s = await staking.stakes(stakeId);
      expect(s.owner).to.equal(alice.address);
      expect(s.tier).to.equal(TIER.THIRTY_DAY);
      expect(s.amount).to.equal(ethers.parseEther("100"));
      expect(s.weighted).to.equal(ethers.parseEther("120")); // 100 * 1.2x
      expect(s.closed).to.equal(false);

      const startTime = await time.latest();
      expect(s.unlockTime).to.equal(BigInt(startTime) + BigInt(30 * DAY));

      expect(await staking.totalPrincipalStaked()).to.equal(ethers.parseEther("100"));
      expect(await staking.totalWeightedSupply()).to.equal(ethers.parseEther("120"));
      expect(await sdoge.balanceOf(await staking.getAddress())).to.equal(ethers.parseEther("100"));
    });

    it("rejects staking 0", async function () {
      const { alice, staking } = await deployFixture();
      await expect(staking.connect(alice).stake(TIER.SEVEN_DAY, 0)).to.be.revertedWith("cannot stake 0");
    });

    it("rejects an invalid tier", async function () {
      const { alice, staking } = await deployFixture();
      await expect(staking.connect(alice).stake(5, ethers.parseEther("100"))).to.be.revertedWith("invalid tier");
    });

    it("lets a user hold multiple simultaneous stakes without merging them", async function () {
      const { alice, staking } = await deployFixture();
      const id1 = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      const id2 = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "50");
      const id3 = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "25"); // same tier, second position

      expect(id1).to.not.equal(id2);
      expect(id2).to.not.equal(id3);

      const ids = await staking.getStakeIds(alice.address);
      expect(ids.map((x) => x.toString())).to.deep.equal([id1, id2, id3].map((x) => x.toString()));

      expect(await staking.totalPrincipalStaked()).to.equal(ethers.parseEther("175"));
      // weighted: 100*1.0 + 50*1.2 + 25*1.0 = 100 + 60 + 25 = 185
      expect(await staking.totalWeightedSupply()).to.equal(ethers.parseEther("185"));
    });
  });

  describe("withdrawing (matured)", function () {
    it("withdraws full principal back with no penalty once matured", async function () {
      const { alice, sdoge, staking } = await deployFixture();
      const stakeId = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await time.increase(7 * DAY + 1);
      const before = await sdoge.balanceOf(alice.address);

      const amount = ethers.parseEther("100");
      await staking.connect(alice).withdraw(stakeId, amount, [alice.address], [amount]);

      expect(await sdoge.balanceOf(alice.address)).to.equal(before + amount);
      const s = await staking.stakes(stakeId);
      expect(s.amount).to.equal(0);
      expect(s.closed).to.equal(true);
    });

    it("exitStake() withdraws the full remaining amount to msg.sender without needing pre-computed payout", async function () {
      const { owner, alice, sdoge, staking } = await deployFixture();
      const stakeId = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await fund(staking, owner, "7");
      await time.increase(7 * DAY + 1);
      const before = await sdoge.balanceOf(alice.address);

      await staking.connect(alice).exitStake(stakeId);

      expect(await sdoge.balanceOf(alice.address)).to.equal(before + ethers.parseEther("100"));
      const s = await staking.stakes(stakeId);
      expect(s.amount).to.equal(0);
      expect(s.closed).to.equal(true);
      expect(await staking.pendingReward(stakeId)).to.equal(0);
    });

    it("exitStake() applies the early penalty and reward forfeiture too, since it shares withdraw()'s accounting", async function () {
      const { owner, alice, sdoge, staking } = await deployFixture();
      const stakeId = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "100");
      await fund(staking, owner, "7");
      await time.increase(3 * DAY);
      const before = await sdoge.balanceOf(alice.address);

      await staking.connect(alice).exitStake(stakeId);

      expect(await sdoge.balanceOf(alice.address)).to.equal(before + ethers.parseEther("85"));
      expect(await staking.unallocatedTokens()).to.equal(ethers.parseEther("15"));
      expect(await staking.unallocatedUsdc()).to.be.gt(0); // forfeited reward
    });

    it("supports a partial withdrawal, leaving the stake open", async function () {
      const { alice, sdoge, staking } = await deployFixture();
      const stakeId = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await time.increase(7 * DAY + 1);
      const before = await sdoge.balanceOf(alice.address);

      const partial = ethers.parseEther("40");
      await staking.connect(alice).withdraw(stakeId, partial, [alice.address], [partial]);

      expect(await sdoge.balanceOf(alice.address)).to.equal(before + partial);
      const s = await staking.stakes(stakeId);
      expect(s.amount).to.equal(ethers.parseEther("60"));
      expect(s.closed).to.equal(false);
    });

    it("splits the payout across up to 4 recipient wallets", async function () {
      const { alice, bob, stranger, owner, sdoge, staking } = await deployFixture();
      const stakeId = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await time.increase(7 * DAY + 1);

      const amount = ethers.parseEther("100");
      const recipients = [alice.address, bob.address, stranger.address, owner.address];
      const splits = [
        ethers.parseEther("10"),
        ethers.parseEther("20"),
        ethers.parseEther("30"),
        ethers.parseEther("40"),
      ];
      const before = await Promise.all(recipients.map((r) => sdoge.balanceOf(r)));

      await staking.connect(alice).withdraw(stakeId, amount, recipients, splits);

      const after = await Promise.all(recipients.map((r) => sdoge.balanceOf(r)));
      for (let i = 0; i < recipients.length; i++) {
        expect(after[i]).to.equal(before[i] + splits[i]);
      }
    });

    it("rejects withdrawing 0, more than staked, or from a closed/foreign stake", async function () {
      const { alice, bob, staking } = await deployFixture();
      const stakeId = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await time.increase(7 * DAY + 1);

      await expect(
        staking.connect(alice).withdraw(stakeId, 0, [alice.address], [0])
      ).to.be.revertedWith("invalid amount");

      const tooMuch = ethers.parseEther("101");
      await expect(
        staking.connect(alice).withdraw(stakeId, tooMuch, [alice.address], [tooMuch])
      ).to.be.revertedWith("invalid amount");

      const amount = ethers.parseEther("100");
      await expect(
        staking.connect(bob).withdraw(stakeId, amount, [bob.address], [amount])
      ).to.be.revertedWith("not your stake");

      await staking.connect(alice).withdraw(stakeId, amount, [alice.address], [amount]);
      await expect(
        staking.connect(alice).withdraw(stakeId, amount, [alice.address], [amount])
      ).to.be.revertedWith("stake already closed"); // fully withdrawn above
    });

    it("rejects malformed recipient/split arrays", async function () {
      const { alice, staking } = await deployFixture();
      const stakeId = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await time.increase(7 * DAY + 1);
      const amount = ethers.parseEther("100");

      await expect(staking.connect(alice).withdraw(stakeId, amount, [], [])).to.be.revertedWith(
        "1-4 recipients"
      );

      const fiveAddrs = Array(5).fill(alice.address);
      const fiveSplits = Array(5).fill(amount / 5n);
      await expect(
        staking.connect(alice).withdraw(stakeId, amount, fiveAddrs, fiveSplits)
      ).to.be.revertedWith("1-4 recipients");

      await expect(
        staking.connect(alice).withdraw(stakeId, amount, [alice.address], [amount, 0n])
      ).to.be.revertedWith("recipients/amounts length mismatch");

      await expect(
        staking.connect(alice).withdraw(stakeId, amount, [alice.address], [amount - 1n])
      ).to.be.revertedWith("split amounts must sum to payout");

      await expect(
        staking.connect(alice).withdraw(stakeId, amount, [ethers.ZeroAddress], [amount])
      ).to.be.revertedWith("recipient is zero address");
    });
  });

  describe("early withdrawal penalty", function () {
    it("applies the default 15% penalty on principal when withdrawing early", async function () {
      const { alice, sdoge, staking } = await deployFixture();
      const stakeId = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "100");
      const before = await sdoge.balanceOf(alice.address);

      const amount = ethers.parseEther("100");
      const payout = ethers.parseEther("85");
      await expect(staking.connect(alice).withdraw(stakeId, amount, [alice.address], [payout]))
        .to.emit(staking, "EarlyWithdrawPenalty")
        .withArgs(alice.address, stakeId, ethers.parseEther("15"));

      expect(await sdoge.balanceOf(alice.address)).to.equal(before + payout);
      expect(await staking.unallocatedTokens()).to.equal(ethers.parseEther("15"));
    });

    it("forfeits ALL of a stake's accrued reward on early withdrawal, not a pro-rated slice", async function () {
      const { owner, alice, staking } = await deployFixture();
      const stakeId = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "100");
      await fund(staking, owner, "7"); // 7-day default rewardsDuration
      await time.increase(3 * DAY); // well inside the 30-day lock, reward has accrued

      expect(await staking.pendingReward(stakeId)).to.be.gt(0);

      // Alice is the sole staker, so ~3 of the 7-day/7-ETH pool's 3 elapsed
      // days is hers to forfeit here - read from the emitted event rather
      // than a separately-fetched pendingReward() snapshot, since that read
      // and this transaction land in different blocks (a few more seconds
      // of accrual happen in between).
      const amount = ethers.parseEther("10"); // partial early withdrawal
      const payout = ethers.parseEther("8.5"); // 15% penalty
      const tx = await staking.connect(alice).withdraw(stakeId, amount, [alice.address], [payout]);
      const receipt = await tx.wait();
      const forfeitedEvent = receipt.logs
        .map((log) => {
          try {
            return staking.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed && parsed.name === "RewardForfeited");

      expect(forfeitedEvent.args.amount).to.be.closeTo(ethers.parseEther("3"), ethers.parseEther("0.01"));
      expect(await staking.pendingReward(stakeId)).to.equal(0);
      expect(await staking.unallocatedUsdc()).to.equal(forfeitedEvent.args.amount);
    });

    it("charges no penalty and forfeits nothing once the tier has matured", async function () {
      const { owner, alice, sdoge, staking } = await deployFixture();
      const stakeId = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await fund(staking, owner, "7");
      await time.increase(7 * DAY + 1);

      const before = await sdoge.balanceOf(alice.address);
      const amount = ethers.parseEther("100");
      const { rewardPaid } = await staking.connect(alice).withdraw.staticCall(
        stakeId,
        amount,
        [alice.address],
        [amount]
      );
      await staking.connect(alice).withdraw(stakeId, amount, [alice.address], [amount]);

      expect(await sdoge.balanceOf(alice.address)).to.equal(before + amount);
      expect(await staking.unallocatedTokens()).to.equal(0);
      expect(rewardPaid).to.be.closeTo(ethers.parseEther("7"), ethers.parseEther("0.001"));
    });

    it("a partial early withdrawal leaves the remainder staked and accruing afresh", async function () {
      const { owner, alice, staking } = await deployFixture();
      const stakeId = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "100");
      await fund(staking, owner, "7");
      await time.increase(3 * DAY);

      const amount = ethers.parseEther("40");
      const payout = ethers.parseEther("34");
      await staking.connect(alice).withdraw(stakeId, amount, [alice.address], [payout]);

      const s = await staking.stakes(stakeId);
      expect(s.amount).to.equal(ethers.parseEther("60"));
      expect(s.closed).to.equal(false);
      expect(await staking.pendingReward(stakeId)).to.equal(0); // just forfeited

      await time.increase(1 * DAY);
      expect(await staking.pendingReward(stakeId)).to.be.gt(0); // accruing again on the remaining 60
    });
  });

  describe("reward accrual with tier multipliers", function () {
    it("pays a higher tier proportionally more per token for equal principal and time", async function () {
      const { owner, alice, bob, staking } = await deployFixture();
      const aliceId = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100"); // 1.0x
      const bobId = await stakeAndGetId(staking, bob, TIER.THREE_SIXTY_FIVE_DAY, "100"); // 3.0x
      await fund(staking, owner, "7");
      await time.increase(7 * DAY);

      const aliceReward = await staking.pendingReward(aliceId);
      const bobReward = await staking.pendingReward(bobId);

      // weighted 100:300 -> 1/4 and 3/4 of the ~7 ETH pool
      expect(aliceReward).to.be.closeTo(ethers.parseEther("1.75"), ethers.parseEther("0.01"));
      expect(bobReward).to.be.closeTo(ethers.parseEther("5.25"), ethers.parseEther("0.01"));
      expect(aliceReward + bobReward).to.be.lte(ethers.parseEther("7"));
    });

    it("splits rewards proportionally to stake size and time staked within the same tier", async function () {
      const { owner, alice, bob, staking } = await deployFixture();
      const aliceId = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await fund(staking, owner, "7");
      await time.increase(3.5 * DAY);

      const bobId = await stakeAndGetId(staking, bob, TIER.SEVEN_DAY, "100");
      await time.increase(3.5 * DAY);

      const aliceReward = await staking.pendingReward(aliceId);
      const bobReward = await staking.pendingReward(bobId);

      expect(aliceReward).to.be.closeTo(ethers.parseEther("5.25"), ethers.parseEther("0.01"));
      expect(bobReward).to.be.closeTo(ethers.parseEther("1.75"), ethers.parseEther("0.01"));
      expect(aliceReward + bobReward).to.be.lte(ethers.parseEther("7"));
    });

    it("claimReward() pays out a matured stake's reward without touching principal", async function () {
      const { owner, alice, staking } = await deployFixture();
      const stakeId = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      await fund(staking, owner, "7");
      await time.increase(7 * DAY + 1);

      const before = await ethers.provider.getBalance(alice.address);
      const tx = await staking.connect(alice).claimReward(stakeId);
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const after = await ethers.provider.getBalance(alice.address);

      expect(after - before + gasCost).to.be.closeTo(ethers.parseEther("7"), ethers.parseEther("0.001"));

      const s = await staking.stakes(stakeId);
      expect(s.amount).to.equal(ethers.parseEther("100")); // principal untouched
      expect(s.closed).to.equal(false);
      expect(await staking.pendingReward(stakeId)).to.equal(0);
    });

    it("claimReward() reverts while the stake is still locked", async function () {
      const { owner, alice, staking } = await deployFixture();
      const stakeId = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "100");
      await fund(staking, owner, "7");
      await time.increase(3 * DAY);

      await expect(staking.connect(alice).claimReward(stakeId)).to.be.revertedWith(
        "still locked - matures or a full early exit settles reward"
      );
    });
  });

  describe("permissionless contributions", function () {
    it("lets anyone add USDC to the pool, folded in by the next notifyRewardAmount()", async function () {
      const { owner, alice, stranger, staking } = await deployFixture();
      const stakeId = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");

      await expect(staking.connect(stranger).contributeUSDC({ value: ethers.parseEther("3") }))
        .to.emit(staking, "UsdcContributed")
        .withArgs(stranger.address, ethers.parseEther("3"));
      expect(await staking.unallocatedUsdc()).to.equal(ethers.parseEther("3"));

      await fund(staking, owner, "4"); // 4 new + 3 unallocated = 7 total
      expect(await staking.unallocatedUsdc()).to.equal(0);

      await time.increase(7 * DAY);
      expect(await staking.pendingReward(stakeId)).to.be.closeTo(
        ethers.parseEther("7"),
        ethers.parseEther("0.01")
      );
    });

    it("rejects contributing 0 USDC", async function () {
      const { stranger, staking } = await deployFixture();
      await expect(staking.connect(stranger).contributeUSDC({ value: 0 })).to.be.revertedWith(
        "send some USDC"
      );
    });

    it("lets anyone donate $SDOGE, added to unallocatedTokens", async function () {
      const { stranger, sdoge, staking } = await deployFixture();
      const before = await sdoge.balanceOf(await staking.getAddress());

      await expect(staking.connect(stranger).contributeTokens(ethers.parseEther("50")))
        .to.emit(staking, "TokensContributed")
        .withArgs(stranger.address, ethers.parseEther("50"));

      expect(await staking.unallocatedTokens()).to.equal(ethers.parseEther("50"));
      expect(await sdoge.balanceOf(await staking.getAddress())).to.equal(before + ethers.parseEther("50"));
    });

    it("rejects contributing 0 tokens", async function () {
      const { stranger, staking } = await deployFixture();
      await expect(staking.connect(stranger).contributeTokens(0)).to.be.revertedWith("cannot contribute 0");
    });
  });

  describe("sweeping tokens", function () {
    it("lets owner or notifier sweep unallocatedTokens out", async function () {
      const { owner, alice, sdoge, staking } = await deployFixture();
      const stakeId = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "100");
      const amount = ethers.parseEther("100");
      await staking.connect(alice).withdraw(stakeId, amount, [alice.address], [ethers.parseEther("85")]); // 15 penalty

      const treasury = ethers.Wallet.createRandom().address;
      await expect(staking.connect(owner).sweepTokens(treasury))
        .to.emit(staking, "TokensSwept")
        .withArgs(treasury, ethers.parseEther("15"));

      expect(await sdoge.balanceOf(treasury)).to.equal(ethers.parseEther("15"));
      expect(await staking.unallocatedTokens()).to.equal(0);
    });

    it("lets a designated notifier sweep without being owner", async function () {
      const { owner, alice, bob, staking } = await deployFixture();
      await staking.connect(owner).setNotifier(bob.address);
      await staking.connect(alice).contributeTokens(ethers.parseEther("10"));

      await expect(staking.connect(bob).sweepTokens(bob.address)).to.not.be.reverted;
    });

    it("rejects sweeping from a random address, to the zero address, or when empty", async function () {
      const { owner, alice, staking } = await deployFixture();
      await staking.connect(alice).contributeTokens(ethers.parseEther("10"));

      await expect(staking.connect(alice).sweepTokens(alice.address)).to.be.revertedWith(
        "not owner or notifier"
      );
      await expect(staking.connect(owner).sweepTokens(ethers.ZeroAddress)).to.be.revertedWith(
        "cannot sweep to zero address"
      );

      await staking.connect(owner).sweepTokens(owner.address);
      await expect(staking.connect(owner).sweepTokens(owner.address)).to.be.revertedWith(
        "nothing to sweep"
      );
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
      await expect(staking.connect(alice).notifyRewardAmount({ value: ethers.parseEther("7") })).to.not
        .be.reverted;
    });

    it("rejects a reward funding too small to produce a nonzero rate", async function () {
      const { owner, staking } = await deployFixture();
      await expect(staking.connect(owner).notifyRewardAmount({ value: 1n })).to.be.revertedWith(
        "reward rate is 0 (amount too small for duration)"
      );
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

    it("only the owner can set the early-withdrawal penalty, capped at 30%", async function () {
      const { owner, alice, staking } = await deployFixture();
      await expect(staking.connect(alice).setEarlyWithdrawPenalty(1000)).to.be.revertedWithCustomError(
        staking,
        "OwnableUnauthorizedAccount"
      );
      await expect(staking.connect(owner).setEarlyWithdrawPenalty(3001)).to.be.revertedWith(
        "penalty too high"
      );
      await staking.connect(owner).setEarlyWithdrawPenalty(500);
      expect(await staking.earlyWithdrawPenaltyBps()).to.equal(500);
    });

    it("only the owner can tune a tier's multiplier, bounded to (0, 10x]", async function () {
      const { owner, alice, staking } = await deployFixture();
      await expect(
        staking.connect(alice).setTierMultiplier(TIER.SEVEN_DAY, 20000)
      ).to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount");
      await expect(staking.connect(owner).setTierMultiplier(TIER.SEVEN_DAY, 0)).to.be.revertedWith(
        "multiplier out of range"
      );
      await expect(
        staking.connect(owner).setTierMultiplier(TIER.SEVEN_DAY, 100001)
      ).to.be.revertedWith("multiplier out of range");

      await staking.connect(owner).setTierMultiplier(TIER.SEVEN_DAY, 15000);
      expect(await staking.tierMultiplierBps(TIER.SEVEN_DAY)).to.equal(15000);
    });

    it("only the owner can tune a tier's duration, and it doesn't affect existing stakes", async function () {
      const { owner, alice, staking } = await deployFixture();
      const stakeId = await stakeAndGetId(staking, alice, TIER.SEVEN_DAY, "100");
      const originalUnlock = (await staking.stakes(stakeId)).unlockTime;

      await expect(staking.connect(alice).setTierDuration(TIER.SEVEN_DAY, DAY)).to.be.revertedWithCustomError(
        staking,
        "OwnableUnauthorizedAccount"
      );
      await expect(staking.connect(owner).setTierDuration(TIER.SEVEN_DAY, 0)).to.be.revertedWith(
        "duration must be > 0"
      );

      await staking.connect(owner).setTierDuration(TIER.SEVEN_DAY, DAY);
      expect(await staking.tierDuration(TIER.SEVEN_DAY)).to.equal(DAY);
      expect((await staking.stakes(stakeId)).unlockTime).to.equal(originalUnlock); // unchanged
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

  describe("accounting invariant", function () {
    it("the contract's SDOGE balance always equals staked principal plus unallocated tokens", async function () {
      const { alice, bob, sdoge, staking } = await deployFixture();
      const id1 = await stakeAndGetId(staking, alice, TIER.THIRTY_DAY, "100");
      await stakeAndGetId(staking, bob, TIER.NINETY_DAY, "200");
      await staking.connect(alice).contributeTokens(ethers.parseEther("5"));

      const amount = ethers.parseEther("40");
      await staking.connect(alice).withdraw(id1, amount, [alice.address], [ethers.parseEther("34")]); // early, 15% penalty

      const contractBalance = await sdoge.balanceOf(await staking.getAddress());
      const totalPrincipal = await staking.totalPrincipalStaked();
      const unallocated = await staking.unallocatedTokens();
      expect(contractBalance).to.equal(totalPrincipal + unallocated);

      // Bob's full 200 must still be withdrawable in full once matured.
      await time.increase(90 * DAY + 1);
      const bobBefore = await sdoge.balanceOf(bob.address);
      const ids = await staking.getStakeIds(bob.address);
      const full = ethers.parseEther("200");
      await staking.connect(bob).withdraw(ids[0], full, [bob.address], [full]);
      expect(await sdoge.balanceOf(bob.address)).to.equal(bobBefore + full);
    });
  });

  describe("reentrancy", function () {
    it("blocks a reentrant claimReward() call from a malicious receiver", async function () {
      const { owner, staking, sdoge } = await deployFixture();

      const Attacker = await ethers.getContractFactory("ReentrantAttacker");
      const attacker = await Attacker.deploy(await staking.getAddress(), await sdoge.getAddress());

      await sdoge.mint(await attacker.getAddress(), ethers.parseEther("100"));
      await attacker.approveAndStake(TIER.SEVEN_DAY, ethers.parseEther("100"));

      await fund(staking, owner, "7");
      await time.increase(7 * DAY + 1);

      await attacker.claim();

      expect(await attacker.reentryAttempted()).to.equal(true);
      expect(await attacker.reentrySucceeded()).to.equal(false);
      // The legitimate first claim still succeeded despite the blocked reentry.
      const stakeId = await attacker.stakeId();
      expect(await staking.pendingReward(stakeId)).to.equal(0);
    });
  });
});
