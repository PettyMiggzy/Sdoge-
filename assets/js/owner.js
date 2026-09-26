// The owner's page (owner.html: not in the nav, not indexed). After a supervised launch the deploy
// wallet offers each contract to the owner (contracts/scripts/handover.js) and the owner accepts
// here, one "Accept ownership" per contract: they're Ownable2Step, so nothing changes until then.
// It also walks the launch steps only the owner can take, in the order they must happen: the seed
// stake, then starting rewards, then sending revenue to the stakers. Needs arc.js and wallet.js.

const OWNER_CONTRACTS = [
  { key: 'collectibles', label: 'NFT collection' },
  { key: 'staking', label: 'Staking' },
  { key: 'studio', label: 'Studio' },
  { key: 'marketplace', label: 'Marketplace' },
];
// nft/studio.json poolShareBps: the share of Studio credit sales that goes to the stakers.
const OWNER_STUDIO_POOL_SHARE_BPS = 5000n;
const OWNER_REWARD_DAYS = 7; // SDOGEStaking: rewardsDuration and SDOGE_REWARDS_DURATION

const OWNABLE_ABI = [
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function acceptOwnership()',
];
const OWNER_STAKING_ABI = [
  ...OWNABLE_ABI,
  'function rewardsStarted() view returns (bool)',
  'function openStakeCount(address) view returns (uint256)',
  'function notifyRewardAmount() payable',
  'function notifySdogeRewards(uint256)',
];
const OWNER_STUDIO_ABI = [
  ...OWNABLE_ABI,
  'function rewardsPool() view returns (address)',
  'function poolShareBps() view returns (uint256)',
  'function setRewardsPool(address pool, uint256 shareBps)',
];
const OWNER_MARKET_ABI = [
  ...OWNABLE_ABI,
  'function rewardsPool() view returns (address)',
  'function setRewardsPool(address newRewardsPool)',
];
const OWNER_TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

let ownerState = { contracts: {}, loaded: false };
let ownerBusy = false;

const ownerAbi = (key) =>
  key === 'staking' ? OWNER_STAKING_ABI : key === 'studio' ? OWNER_STUDIO_ABI : key === 'marketplace' ? OWNER_MARKET_ABI : OWNABLE_ABI;
const ownerRead = (key) => new ethers.Contract(SDOGE_CONTRACTS[key], ownerAbi(key), arcReadProvider);
const ownerWrite = (key) => new ethers.Contract(SDOGE_CONTRACTS[key], ownerAbi(key), signer);
const isZeroAddr = (a) => !a || /^0x0{40}$/i.test(a);

// "250000" or "12.5" SDOGE -> wei. null if it isn't a positive amount.
function ownerParseSdoge(raw) {
  const s = String(raw ?? '').trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,18})?$/.test(s)) return null;
  const wei = ethers.parseEther(s);
  return wei > 0n ? wei : null;
}

// Who owns each contract, who it's offered to, and where the launch steps stand. Reads only.
async function loadOwnerState() {
  const next = { contracts: {}, loaded: true };
  for (const { key } of OWNER_CONTRACTS) {
    if (!isAddressSet(SDOGE_CONTRACTS[key])) {
      next.contracts[key] = null;
      continue;
    }
    const c = ownerRead(key);
    next.contracts[key] = {
      address: SDOGE_CONTRACTS[key],
      owner: await arcRetry(() => c.owner()),
      pending: await arcRetry(() => c.pendingOwner()),
    };
  }
  const staking = next.contracts.staking;
  if (staking) {
    const c = ownerRead('staking');
    // The seed stake belongs to whoever will own staking: the wallet it's offered to, if any.
    next.seedHolder = isZeroAddr(staking.pending) ? staking.owner : staking.pending;
    next.seedStakes = await arcRetry(() => c.openStakeCount(next.seedHolder));
    next.rewardsStarted = await arcRetry(() => c.rewardsStarted());
  }
  if (next.contracts.studio) {
    const c = ownerRead('studio');
    next.studioPool = await arcRetry(() => c.rewardsPool());
    next.studioShare = await arcRetry(() => c.poolShareBps());
  }
  if (next.contracts.marketplace) next.marketPool = await arcRetry(() => ownerRead('marketplace').rewardsPool());
  ownerState = next;
  renderOwner();
  return next;
}

function ownerStatus(entry) {
  if (!entry) return { text: 'Not deployed yet', you: false, offered: false };
  if (sameAddr(entry.owner, userAddress)) return { text: 'You own it', you: true, offered: false };
  if (sameAddr(entry.pending, userAddress)) return { text: 'Offered to you: accept it to take over', you: false, offered: true };
  if (!isZeroAddr(entry.pending)) {
    return { text: `Offered to ${shortAddr(entry.pending)}, waiting for that wallet to accept`, you: false, offered: false };
  }
  return { text: `Owned by ${shortAddr(entry.owner)}`, you: false, offered: false };
}

const ownsIt = (key) => sameAddr(ownerState.contracts[key]?.owner, userAddress);
const stakingAddr = () => ownerState.contracts.staking?.address;

function renderOwner() {
  if (!ownerState.loaded) return;
  const list = document.getElementById('ownerList');
  list.innerHTML = OWNER_CONTRACTS.map(({ key, label }) => {
    const entry = ownerState.contracts[key];
    const status = ownerStatus(entry);
    const link = entry
      ? `<a class="own-row__addr" href="${ARC_EXPLORER_URL}/address/${entry.address}" target="_blank" rel="noopener">${shortAddr(entry.address)}</a>`
      : '';
    const button = status.offered
      ? `<button type="button" class="stk-btn stk-btn--primary" data-accept="${key}">Accept ownership</button>`
      : '';
    return (
      `<div class="own-row${status.you ? ' is-yours' : ''}">` +
      `<div class="own-row__main"><div class="own-row__name">${label}</div>${link}</div>` +
      `<div class="own-row__status">${escHtml(status.text)}</div>${button}</div>`
    );
  }).join('');

  const staking = ownerState.contracts.staking;
  const seedDone = ownerState.seedStakes > 0n;
  const rewardsDone = ownerState.rewardsStarted === true;
  const studioDone = !!stakingAddr() && sameAddr(ownerState.studioPool, stakingAddr());
  const marketDone = !!stakingAddr() && sameAddr(ownerState.marketPool, stakingAddr());
  const mark = (done) => (done ? 'Done' : 'To do');
  document.getElementById('stepSeedState').textContent = staking
    ? `${mark(seedDone)}: ${seedDone ? `${ownerState.seedStakes} open stake(s)` : 'no open stake'} from ${shortAddr(ownerState.seedHolder)}`
    : 'Staking isn’t deployed yet';
  document.getElementById('stepRewardsState').textContent = staking ? mark(rewardsDone) : '';
  document.getElementById('stepRevenueState').textContent =
    `Studio: ${studioDone ? `${Number(ownerState.studioShare) / 100}% of credit sales` : 'not yet'} · ` +
    `Marketplace fees: ${marketDone ? 'to the stakers' : 'not yet'}`;
  document.getElementById('ownerStartSdoge').disabled = !staking || !ownsIt('staking') || !seedDone;
  document.getElementById('ownerStartUsdc').disabled = !staking || !ownsIt('staking') || !seedDone;
  document.getElementById('ownerRouteStudio').disabled = !rewardsDone || studioDone || !ownsIt('studio');
  document.getElementById('ownerRouteMarket').disabled = !rewardsDone || marketDone || !ownsIt('marketplace');
}

// Every owner action: connected, on Arc, one at a time, and the page re-read afterwards.
async function ownerAction(fn) {
  if (ownerBusy) return false;
  ownerBusy = true;
  try {
    if (!(await walletReady())) return false;
    await loadOwnerState();
    const done = await fn();
    await loadOwnerState();
    return done;
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`That didn't go through: ${reason(err)}`);
    return false;
  } finally {
    ownerBusy = false;
  }
}

function ownerAccept(key) {
  return ownerAction(async () => {
    const entry = ownerState.contracts[key];
    const label = OWNER_CONTRACTS.find((c) => c.key === key)?.label || key;
    if (!entry) {
      alert(`The ${label} contract isn't deployed yet.`);
      return false;
    }
    if (sameAddr(entry.owner, userAddress)) {
      alert(`This wallet already owns the ${label} contract.`);
      return false;
    }
    if (!sameAddr(entry.pending, userAddress)) {
      alert(`The ${label} contract hasn't been offered to this wallet (${shortAddr(userAddress)}). Connect the wallet it was offered to.`);
      return false;
    }
    if (!confirm(`Accept ownership of the ${label} contract (${entry.address})?\n\nFrom then on only this wallet can change its settings. Keep it safe.`)) {
      return false;
    }
    await (await ownerWrite(key).acceptOwnership(arcTx())).wait();
    return true;
  });
}

// Rewards start from the owner's first notify, and never before the seed stake: while nobody else
// is staked, the first stakers would split a stream meant for a pool that can't empty.
function ownerCanStart() {
  if (!ownsIt('staking')) {
    alert('Only the staking contract’s owner can start rewards. Accept ownership of Staking first, with this wallet.');
    return false;
  }
  if (!(ownerState.seedStakes > 0n)) {
    alert('Make the seed stake first: on the staking page, stake SDOGE you will never unstake, in the 365-day tier, from this wallet.');
    return false;
  }
  return true;
}

function ownerStartSdogeRewards() {
  return ownerAction(async () => {
    if (!ownerCanStart()) return false;
    const amount = ownerParseSdoge(document.getElementById('ownerSdogeAmount').value);
    if (amount === null) {
      alert('Enter how much SDOGE to stream to the stakers.');
      return false;
    }
    const token = new ethers.Contract(SDOGE_CONTRACTS.token, OWNER_TOKEN_ABI, signer);
    const balance = await arcRetry(() => token.balanceOf(userAddress));
    if (balance < amount) {
      alert(`This wallet holds ${tokenText(balance)} SDOGE, less than ${tokenText(amount)}.`);
      return false;
    }
    const more = ownerState.rewardsStarted ? ' It adds to the stream that is running.' : ' This starts rewards.';
    if (!confirm(`Stream ${tokenText(amount)} SDOGE to the stakers over the next ${OWNER_REWARD_DAYS} days?${more}`)) return false;
    // An exact approval for this amount only, then the notify that pulls it.
    await (await token.approve(stakingAddr(), amount, arcTx())).wait();
    await (await ownerWrite('staking').notifySdogeRewards(amount, arcTx())).wait();
    return true;
  });
}

function ownerStartUsdcRewards() {
  return ownerAction(async () => {
    if (!ownerCanStart()) return false;
    const value = parseUsdc(document.getElementById('ownerUsdcAmount').value);
    if (value === null || value === 0n) {
      alert('Enter how much USDC to stream to the stakers (up to 6 decimals).');
      return false;
    }
    const more = ownerState.rewardsStarted ? ' It adds to the stream that is running.' : ' This starts rewards.';
    if (!confirm(`Stream ${usdcText(value)} USDC to the stakers over the next ${OWNER_REWARD_DAYS} days?${more}`)) return false;
    await (await ownerWrite('staking').notifyRewardAmount(arcTx({ value }))).wait();
    return true;
  });
}

// Revenue goes to the stakers only once rewards have started (deploy-staking.js's order).
function ownerRoute(key) {
  return ownerAction(async () => {
    const label = key === 'studio' ? 'Studio' : 'Marketplace';
    if (!ownsIt(key)) {
      alert(`Only the ${label} contract’s owner can do this. Accept ownership of it first, with this wallet.`);
      return false;
    }
    if (!ownerState.rewardsStarted) {
      alert('Start rewards first (step 2): revenue should reach a running stream.');
      return false;
    }
    const pool = stakingAddr();
    if (key === 'studio') {
      const pct = Number(OWNER_STUDIO_POOL_SHARE_BPS) / 100;
      if (!confirm(`Send ${pct}% of Studio credit sales to the stakers (staking contract ${pool})?`)) return false;
      await (await ownerWrite('studio').setRewardsPool(pool, OWNER_STUDIO_POOL_SHARE_BPS, arcTx())).wait();
    } else {
      if (!confirm(`Send the marketplace fees to the stakers (staking contract ${pool})?`)) return false;
      await (await ownerWrite('marketplace').setRewardsPool(pool, arcTx())).wait();
    }
    return true;
  });
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('ownerList').addEventListener('click', (e) => {
    const key = e.target?.closest?.('[data-accept]')?.dataset.accept;
    if (key) ownerAccept(key);
  });
  document.getElementById('ownerStartSdoge').addEventListener('click', ownerStartSdogeRewards);
  document.getElementById('ownerStartUsdc').addEventListener('click', ownerStartUsdcRewards);
  document.getElementById('ownerRouteStudio').addEventListener('click', () => ownerRoute('studio'));
  document.getElementById('ownerRouteMarket').addEventListener('click', () => ownerRoute('marketplace'));
  const live = OWNER_CONTRACTS.some(({ key }) => isAddressSet(SDOGE_CONTRACTS[key]));
  arcShowLiveCopy(live);
  loadOwnerState().catch((err) => {
    console.error(err);
    document.getElementById('ownerNotice').textContent = `Couldn't read the contracts: ${reason(err)}. Reload to try again.`;
  });
});
document.addEventListener('sdoge:wallet-connected', () => renderOwner());
