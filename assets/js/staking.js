// $SDOGE Staking UI.
//
// Two modes, automatically:
// - SDOGE_CONTRACTS.staking unset (today): the tier picker shows the contract's documented
//   defaults so the page is browsable, and wallet actions are disabled ("not live yet").
// - Set (after deploy, by contracts/scripts/sync-frontend.js): everything reads the live
//   contract on Arc and every action writes to it.
//
// Safety rules this file follows (from the audit):
// - Reads go to Arc's RPC (arc.js); every write first checks the wallet is on Arc and is pinned
//   to chain 5042.
// - Lock status uses chain time, never the browser clock.
// - Tier terms are re-read right before staking and passed to stake(), which refuses to open a
//   stake on terms that changed in the meantime.
// - Leaving early always shows the exact penalty and forfeited reward and needs a confirm.
// - Approvals are for the exact amount being staked.
const STAKING_CONTRACT_ADDRESS = SDOGE_CONTRACTS.staking;
const SDOGE_TOKEN_ADDRESS = SDOGE_CONTRACTS.token;

const DEFAULT_TIER_DAYS = [7, 30, 90, 180, 365];
const DEFAULT_TIER_MULT_BPS = [10000, 12000, 15000, 20000, 30000];
const DEFAULT_EARLY_UNLOCK_BPS = 8000;

const STAKING_ABI = [
  'function stake(uint8 tier, uint256 amount, uint256 expectedDuration, uint256 expectedMultiplierBps) returns (uint256 stakeId)',
  'function exitStake(uint256 stakeId, bool allowEarly) returns (uint256 payout, uint256 reward)',
  'function claimReward(uint256 stakeId) returns (uint256 reward)',
  'function claimDeferredRewards(address to) returns (uint256 amount)',
  'function deferredRewards(address) view returns (uint256)',
  'function getStakeIds(address user) view returns (uint256[])',
  'function stakes(uint256) view returns (address owner, uint8 tier, uint32 multiplierBps, uint16 penaltyBps, bool closed, uint256 amount, uint256 weighted, uint256 startTime, uint256 unlockTime, uint256 matureTime, uint256 rewardPerWeightedSharePaid, uint256 accruedReward)',
  'function pendingReward(uint256 stakeId) view returns (uint256)',
  'function previewExit(uint256 stakeId) view returns (uint256 payout, uint256 reward, uint256 penalty, uint256 forfeitedReward, bool early)',
  'function tierDuration(uint256) view returns (uint256)',
  'function tierMultiplierBps(uint256) view returns (uint256)',
  'function earlyUnlockThresholdBps() view returns (uint256)',
  'function earlyWithdrawPenaltyBps() view returns (uint256)',
  'function totalPrincipalStaked() view returns (uint256)',
  'function unallocatedUsdc() view returns (uint256)',
  'function rewardsRemaining() view returns (uint256)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];

const isDeployed = () => isAddressSet(STAKING_CONTRACT_ADDRESS);

let provider, signer, userAddress;
let stakingWrite, sdogeWrite;
const stakingRead = isDeployed() ? new ethers.Contract(STAKING_CONTRACT_ADDRESS, STAKING_ABI, arcReadProvider) : null;
const sdogeRead = new ethers.Contract(SDOGE_TOKEN_ADDRESS, ERC20_ABI, arcReadProvider);

let tierData = DEFAULT_TIER_DAYS.map((days, i) => ({
  tier: i,
  duration: BigInt(days * 86400),
  multiplierBps: BigInt(DEFAULT_TIER_MULT_BPS[i]),
}));
let earlyUnlockBps = DEFAULT_EARLY_UNLOCK_BPS;
let liveReady = false; // true once the live contract and its terms have been read
let selectedTier = 0;

const fmt = (n, d = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
const short = (addr) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;
const days = (seconds) => Number(seconds) / 86400;
const usdc = (wei, d = 4) => `${fmt(ethers.formatEther(wei), d)} USDC`;
const sdogeAmt = (wei) => `${fmt(ethers.formatUnits(wei, 18))} SDOGE`;
const reason = (err) => err?.shortMessage || err?.reason || err?.message || 'unknown error';

function renderTierGrid() {
  const grid = document.getElementById('tierGrid');
  grid.innerHTML = tierData
    .map(
      (t) => `
      <label class="tier-option ${t.tier === selectedTier ? 'is-selected' : ''}" data-tier="${t.tier}">
        <input type="radio" name="tier" value="${t.tier}" ${t.tier === selectedTier ? 'checked' : ''} />
        <div class="tier-option__mult">${(Number(t.multiplierBps) / 10000).toFixed(1)}&times;</div>
        <div class="tier-option__len">${fmt(days(t.duration), 1)}d</div>
      </label>`
    )
    .join('');

  grid.querySelectorAll('.tier-option').forEach((el) => {
    el.addEventListener('click', () => {
      selectedTier = Number(el.dataset.tier);
      renderTierGrid();
      updateMetaRow();
    });
  });
}

function updateMetaRow() {
  const t = tierData[selectedTier];
  document.getElementById('metaLockLength').textContent = `${fmt(days(t.duration), 1)} days`;
  document.getElementById('metaMultiplier').textContent = `${(Number(t.multiplierBps) / 10000).toFixed(1)}×`;
  const earlyUnlockDays = (days(t.duration) * earlyUnlockBps) / 10000;
  document.getElementById('metaEarlyUnlock').textContent = `~${earlyUnlockDays.toFixed(1)} days`;
}

function showUnavailable(message) {
  liveReady = false;
  for (const id of ['metaLockLength', 'metaMultiplier', 'metaEarlyUnlock', 'statTotalStaked', 'statRewardPool']) {
    document.getElementById(id).textContent = 'Unavailable';
  }
  const btn = document.getElementById('connectOrStakeBtn');
  if (userAddress) {
    btn.textContent = 'Staking unavailable';
    btn.disabled = true;
  }
  console.error(message);
}

async function readTier(i) {
  const [duration, multiplierBps] = await Promise.all([stakingRead.tierDuration(i), stakingRead.tierMultiplierBps(i)]);
  return { tier: i, duration, multiplierBps };
}

async function loadTierDataFromChain() {
  if (!isDeployed()) return;
  if (!(await hasCodeOnArc(STAKING_CONTRACT_ADDRESS))) {
    showUnavailable(`No staking contract at ${STAKING_CONTRACT_ADDRESS} on Arc.`);
    return;
  }
  try {
    tierData = await Promise.all([0, 1, 2, 3, 4].map(readTier));
    earlyUnlockBps = Number(await stakingRead.earlyUnlockThresholdBps());
    const [totalStaked, remaining, unallocated] = await Promise.all([
      stakingRead.totalPrincipalStaked(),
      stakingRead.rewardsRemaining(),
      stakingRead.unallocatedUsdc(),
    ]);
    document.getElementById('statTotalStaked').textContent = fmt(ethers.formatUnits(totalStaked, 18));
    document.getElementById('statRewardPool').textContent = usdc(remaining + unallocated, 2);
    liveReady = true;
  } catch (err) {
    // Never fall back to the defaults here: they may no longer be the real terms.
    showUnavailable(`Could not read the staking contract: ${reason(err)}`);
    return;
  }
  renderTierGrid();
  updateMetaRow();
}

async function connectWallet() {
  if (!window.ethereum) {
    alert('No wallet found. Install MetaMask or another injected wallet to continue.');
    return false;
  }
  try {
    if (!(await ensureArcNetwork())) return false;
    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send('eth_requestAccounts', []);
    signer = await provider.getSigner();
    userAddress = await signer.getAddress();
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`Could not connect: ${reason(err)}`);
    return false;
  }
  arcTrackSigner(userAddress);

  sdogeWrite = new ethers.Contract(SDOGE_TOKEN_ADDRESS, ERC20_ABI, signer);
  if (isDeployed()) stakingWrite = new ethers.Contract(STAKING_CONTRACT_ADDRESS, STAKING_ABI, signer);

  const live = isDeployed() && liveReady;
  document.getElementById('overviewWallet').textContent = short(userAddress);
  const btn = document.getElementById('connectOrStakeBtn');
  btn.textContent = !isDeployed() ? 'Staking not live yet' : live ? 'Stake' : 'Staking unavailable';
  btn.disabled = !live;
  document.getElementById('claimAllBtn').disabled = !live;

  await refreshBalance();
  if (live) await refreshOverview();
  return true;
}

async function refreshBalance() {
  if (!userAddress) return;
  try {
    const bal = await sdogeRead.balanceOf(userAddress);
    document.getElementById('sdogeBalance').textContent = fmt(ethers.formatUnits(bal, 18));
  } catch (err) {
    console.error('balanceOf failed:', err);
  }
}

async function loadMyStakes() {
  const [ids, now] = await Promise.all([stakingRead.getStakeIds(userAddress), arcNow()]);
  const rows = [];
  for (const id of ids) {
    const s = await stakingRead.stakes(id);
    if (s.closed) continue;
    const reward = await stakingRead.pendingReward(id);
    rows.push({ id, tier: Number(s.tier), amount: s.amount, reward, mature: now >= s.matureTime, matureTime: s.matureTime });
  }
  return rows;
}

async function refreshOverview() {
  if (!stakingRead || !userAddress || !liveReady) return;
  try {
    const [rows, deferred] = await Promise.all([loadMyStakes(), stakingRead.deferredRewards(userAddress)]);
    let staked = 0n;
    let ready = 0n;
    let atRisk = 0n;
    for (const r of rows) {
      staked += r.amount;
      if (r.mature) ready += r.reward;
      else atRisk += r.reward;
    }

    document.getElementById('overviewStaked').textContent = sdogeAmt(staked);
    document.getElementById('overviewRewards').textContent =
      `${usdc(ready + deferred)} ready` + (atRisk > 0n ? ` · ${usdc(atRisk)} still at risk` : '');
    document.getElementById('overviewCount').textContent = String(rows.length);

    const list = document.getElementById('myStakesList');
    const html = rows.map(
      (r) => `
        <div class="stake-row">
          <span>#${r.id} &middot; Tier ${r.tier} &middot; ${sdogeAmt(r.amount)} &middot; ${usdc(r.reward)}</span>
          <span class="stake-row__tag">${
            r.mature ? 'Matured' : `Locked until ${new Date(Number(r.matureTime) * 1000).toLocaleDateString()}`
          }</span>
          ${r.mature && r.reward > 0n ? `<button class="chip-btn" data-claim="${r.id}">Claim</button>` : ''}
          <button class="chip-btn" data-exit="${r.id}">${r.mature ? 'Exit' : 'Exit early'}</button>
        </div>`
    );
    if (deferred > 0n) {
      html.unshift(`
        <div class="stake-row">
          <span>Payout waiting for you: ${usdc(deferred)}</span>
          <button class="chip-btn" data-deferred="1">Collect</button>
        </div>`);
    }
    list.innerHTML = html.length ? html.join('') : '<p class="empty-state">No stakes yet.</p>';

    list.querySelectorAll('[data-exit]').forEach((btn) => btn.addEventListener('click', () => exitStake(BigInt(btn.dataset.exit))));
    list.querySelectorAll('[data-claim]').forEach((btn) => btn.addEventListener('click', () => claimOne(BigInt(btn.dataset.claim))));
    list.querySelectorAll('[data-deferred]').forEach((btn) => btn.addEventListener('click', collectDeferred));
  } catch (err) {
    console.error('refreshOverview failed:', err);
  }
}

async function ready() {
  if (!userAddress && !(await connectWallet())) return false;
  if (!liveReady) return false;
  return ensureArcNetwork();
}

async function doStake() {
  const raw = document.getElementById('stakeAmount').value;
  if (!raw || Number(raw) <= 0) return alert('Enter an amount to stake.');
  if (!(await ready())) return;
  let amountWei;
  try {
    amountWei = ethers.parseUnits(raw, 18);
  } catch {
    return alert('Enter a valid amount.');
  }

  try {
    // Re-read the terms right now; the contract rejects the stake if they change again.
    const live = await readTier(selectedTier);
    const shown = tierData[selectedTier];
    if (live.duration !== shown.duration || live.multiplierBps !== shown.multiplierBps) {
      tierData[selectedTier] = live;
      renderTierGrid();
      updateMetaRow();
      return alert('This tier\'s terms just changed. Check the new lock length and multiplier, then stake again.');
    }
    const allowance = await sdogeRead.allowance(userAddress, STAKING_CONTRACT_ADDRESS);
    if (allowance < amountWei) await (await sdogeWrite.approve(STAKING_CONTRACT_ADDRESS, amountWei, arcTx())).wait();
    await (await stakingWrite.stake(selectedTier, amountWei, live.duration, live.multiplierBps, arcTx())).wait();
    document.getElementById('stakeAmount').value = '';
    await refreshBalance();
    await refreshOverview();
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`Stake failed: ${reason(err)}`);
  }
}

async function exitStake(stakeId) {
  if (!(await ready())) return;
  try {
    const p = await stakingRead.previewExit(stakeId);
    if (!p.early) {
      await (await stakingWrite.exitStake(stakeId, false, arcTx())).wait();
    } else {
      const ok = confirm(
        `This stake hasn't matured yet.\n\n` +
          `Leaving now costs ${sdogeAmt(p.penalty)} (the early-exit penalty) and forfeits ${usdc(p.forfeitedReward)} of reward.\n` +
          `You would get back ${sdogeAmt(p.payout)}.\n\nExit early anyway?`
      );
      if (!ok) return;
      await (await stakingWrite.exitStake(stakeId, true, arcTx())).wait();
    }
    await refreshBalance();
    await refreshOverview();
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`Exit failed: ${reason(err)}`);
  }
}

async function claimOne(stakeId) {
  if (!(await ready())) return;
  try {
    await (await stakingWrite.claimReward(stakeId, arcTx())).wait();
    await refreshOverview();
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`Claim failed: ${reason(err)}`);
  }
}

async function collectDeferred() {
  if (!(await ready())) return;
  try {
    await (await stakingWrite.claimDeferredRewards(userAddress, arcTx())).wait();
    await refreshOverview();
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`Collect failed: ${reason(err)}`);
  }
}

// Claims every matured stake that has something to claim. Locked stakes are skipped (their
// reward is still at risk), and one failure doesn't stop the rest.
async function claimAll() {
  if (!(await ready())) return;
  const rows = (await loadMyStakes()).filter((r) => r.mature && r.reward > 0n);
  if (!rows.length) return alert('Nothing ready to claim yet. Rewards on locked stakes unlock when the stake matures.');
  const failed = [];
  for (const r of rows) {
    try {
      await (await stakingWrite.claimReward(r.id, arcTx())).wait();
    } catch (err) {
      console.error(err);
      if (userRejected(err)) break; // the user cancelled: stop asking for the rest
      failed.push(`#${r.id}: ${reason(err)}`);
    }
  }
  await refreshOverview();
  if (failed.length) alert(`Some claims failed:\n${failed.join('\n')}`);
}

// ---------- wire up ----------
document.addEventListener('DOMContentLoaded', () => {
  renderTierGrid();
  updateMetaRow();
  loadTierDataFromChain();

  document.getElementById('connectOrStakeBtn').addEventListener('click', async () => {
    if (!userAddress) {
      await connectWallet();
      return;
    }
    if (isDeployed()) await doStake();
  });

  document.getElementById('claimAllBtn').addEventListener('click', claimAll);
  document.getElementById('connectWalletHero')?.addEventListener('click', connectWallet);

  document.getElementById('maxStakeBtn').addEventListener('click', async () => {
    if (!userAddress) return connectWallet();
    const bal = await sdogeRead.balanceOf(userAddress);
    document.getElementById('stakeAmount').value = ethers.formatUnits(bal, 18);
  });

  document.querySelectorAll('.percent-row button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!userAddress) return connectWallet();
      const bal = await sdogeRead.balanceOf(userAddress);
      const amount = (bal * BigInt(Number(btn.dataset.pct))) / 100n;
      document.getElementById('stakeAmount').value = ethers.formatUnits(amount, 18);
    });
  });

  document.querySelectorAll('.tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tabs .tab').forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      const isStake = tab.dataset.tab === 'stake';
      document.getElementById('tabPanelStake').style.display = isStake ? 'block' : 'none';
      document.getElementById('tabPanelUnstake').style.display = isStake ? 'none' : 'block';
      if (!isStake && userAddress) refreshOverview();
    });
  });

  if (!isDeployed()) {
    document.getElementById('statTotalStaked').textContent = 'Not live yet';
    document.getElementById('statRewardPool').textContent = 'Not live yet';
  }
});
