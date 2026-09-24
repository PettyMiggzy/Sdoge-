// $SDOGE Staking UI.
//
// Works in two modes, automatically:
// - STAKING_CONTRACT_ADDRESS unset (today): tier picker/calculations use
//   the contract's own documented defaults (verified against
//   contracts/contracts/SDOGEStaking.sol directly, not guessed) so the
//   page is fully browsable and the math is correct, but wallet actions
//   are disabled with an explicit "not live yet" state.
// - STAKING_CONTRACT_ADDRESS set (after deploy): tier data, balances, and
//   every stake/claim/withdraw action read and write the real contract.
//
// Drop the real address in below once contracts/README.md's deploy step
// has run - nothing else here needs to change.
const STAKING_CONTRACT_ADDRESS = ''; // e.g. '0x...'
const SDOGE_TOKEN_ADDRESS = '0xf8df98fda14cabb2e8b6efe920081ffcbb0bb405';

const DEFAULT_TIER_DAYS = [7, 30, 90, 180, 365];
const DEFAULT_TIER_MULT_BPS = [10000, 12000, 15000, 20000, 30000];
const DEFAULT_EARLY_UNLOCK_BPS = 8000;

const STAKING_ABI = [
  'function stake(uint8 tier, uint256 amount) returns (uint256 stakeId)',
  'function withdraw(uint256 stakeId, uint256 amount, address[] recipients, uint256[] splitAmounts) returns (uint256 payout, uint256 rewardPaid)',
  'function exitStake(uint256 stakeId) returns (uint256 payout, uint256 rewardPaid)',
  'function claimReward(uint256 stakeId) returns (uint256 rewardPaid)',
  'function getStakeIds(address user) view returns (uint256[])',
  'function stakes(uint256) view returns (address owner, uint8 tier, uint256 amount, uint256 weighted, uint256 startTime, uint256 unlockTime, uint256 rewardPerWeightedSharePaid, uint256 accruedReward, bool closed)',
  'function pendingReward(uint256 stakeId) view returns (uint256)',
  'function effectiveUnlockTime(uint256 stakeId) view returns (uint256)',
  'function tierDuration(uint256) view returns (uint256)',
  'function tierMultiplierBps(uint256) view returns (uint256)',
  'function earlyUnlockThresholdBps() view returns (uint256)',
  'function totalPrincipalStaked() view returns (uint256)',
  'function unallocatedUsdc() view returns (uint256)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
];

const isDeployed = () => STAKING_CONTRACT_ADDRESS && STAKING_CONTRACT_ADDRESS.length === 42;

let provider, signer, userAddress;
let staking, sdoge;
let tierData = DEFAULT_TIER_DAYS.map((days, i) => ({
  tier: i,
  days,
  multiplierBps: DEFAULT_TIER_MULT_BPS[i],
}));
let earlyUnlockBps = DEFAULT_EARLY_UNLOCK_BPS;
let selectedTier = 0;

const fmt = (n, d = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
const short = (addr) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

function renderTierGrid() {
  const grid = document.getElementById('tierGrid');
  grid.innerHTML = tierData
    .map(
      (t) => `
      <label class="tier-option ${t.tier === selectedTier ? 'is-selected' : ''}" data-tier="${t.tier}">
        <input type="radio" name="tier" value="${t.tier}" ${t.tier === selectedTier ? 'checked' : ''} />
        <div class="tier-option__mult">${(t.multiplierBps / 10000).toFixed(1)}&times;</div>
        <div class="tier-option__len">${t.days}d</div>
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
  document.getElementById('metaLockLength').textContent = `${t.days} days`;
  document.getElementById('metaMultiplier').textContent = `${(t.multiplierBps / 10000).toFixed(1)}×`;
  const earlyUnlockDays = (t.days * earlyUnlockBps) / 10000;
  document.getElementById('metaEarlyUnlock').textContent = `~${earlyUnlockDays.toFixed(1)} days`;
}

async function loadTierDataFromChain() {
  if (!isDeployed()) return;
  try {
    const roProvider = provider || new ethers.BrowserProvider(window.ethereum);
    const ro = new ethers.Contract(STAKING_CONTRACT_ADDRESS, STAKING_ABI, roProvider);
    const days = [];
    const mults = [];
    for (let i = 0; i < 5; i++) {
      const [d, m] = await Promise.all([ro.tierDuration(i), ro.tierMultiplierBps(i)]);
      days.push(Number(d) / 86400);
      mults.push(Number(m));
    }
    tierData = days.map((d, i) => ({ tier: i, days: d, multiplierBps: mults[i] }));
    earlyUnlockBps = Number(await ro.earlyUnlockThresholdBps());

    const totalStaked = await ro.totalPrincipalStaked();
    document.getElementById('statTotalStaked').textContent = fmt(ethers.formatUnits(totalStaked, 18));
    const unalloc = await ro.unallocatedUsdc();
    document.getElementById('statRewardPool').textContent = `${fmt(ethers.formatEther(unalloc), 2)} USDC`;
  } catch (err) {
    console.error('Could not load live tier data, using documented defaults:', err);
  }
  renderTierGrid();
  updateMetaRow();
}

async function connectWallet() {
  if (!window.ethereum) {
    alert('No wallet found. Install MetaMask or another injected wallet to continue.');
    return false;
  }
  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send('eth_requestAccounts', []);
  signer = await provider.getSigner();
  userAddress = await signer.getAddress();

  sdoge = new ethers.Contract(SDOGE_TOKEN_ADDRESS, ERC20_ABI, signer);
  if (isDeployed()) staking = new ethers.Contract(STAKING_CONTRACT_ADDRESS, STAKING_ABI, signer);

  document.getElementById('overviewWallet').textContent = short(userAddress);
  document.getElementById('connectOrStakeBtn').textContent = isDeployed() ? 'Stake' : 'Staking not live yet';
  document.getElementById('connectOrStakeBtn').disabled = !isDeployed();
  document.getElementById('claimAllBtn').disabled = !isDeployed();

  await refreshBalance();
  if (isDeployed()) await refreshOverview();
  return true;
}

async function refreshBalance() {
  if (!sdoge || !userAddress) return;
  try {
    const bal = await sdoge.balanceOf(userAddress);
    document.getElementById('sdogeBalance').textContent = fmt(ethers.formatUnits(bal, 18));
  } catch (err) {
    console.error('balanceOf failed:', err);
  }
}

async function refreshOverview() {
  if (!staking || !userAddress) return;
  try {
    const ids = await staking.getStakeIds(userAddress);
    let totalStaked = 0n;
    let totalRewards = 0n;
    const rows = [];

    for (const id of ids) {
      const s = await staking.stakes(id);
      if (s.closed) continue;
      const reward = await staking.pendingReward(id);
      totalStaked += s.amount;
      totalRewards += reward;
      const unlockAt = await staking.effectiveUnlockTime(id);
      const unlocked = BigInt(Math.floor(Date.now() / 1000)) >= unlockAt;
      rows.push({ id, tier: s.tier, amount: s.amount, reward, unlocked });
    }

    document.getElementById('overviewStaked').textContent = `${fmt(ethers.formatUnits(totalStaked, 18))} SDOGE`;
    document.getElementById('overviewRewards').textContent = `${fmt(ethers.formatEther(totalRewards), 4)} USDC`;
    document.getElementById('overviewCount').textContent = String(rows.length);

    const list = document.getElementById('myStakesList');
    list.innerHTML = rows.length
      ? rows
          .map(
            (r) => `
        <div class="stake-row">
          <span>#${r.id} &middot; Tier ${r.tier} &middot; ${fmt(ethers.formatUnits(r.amount, 18))} SDOGE</span>
          <span class="stake-row__tag">${r.unlocked ? 'Unlocked' : 'Locked'}</span>
          <button class="chip-btn" data-exit="${r.id}">Exit</button>
        </div>`
          )
          .join('')
      : '<p class="empty-state">No stakes yet.</p>';

    list.querySelectorAll('[data-exit]').forEach((btn) => {
      btn.addEventListener('click', () => exitStake(BigInt(btn.dataset.exit)));
    });
  } catch (err) {
    console.error('refreshOverview failed:', err);
  }
}

async function ensureAllowance(amountWei) {
  const allowance = await sdoge.allowance(userAddress, STAKING_CONTRACT_ADDRESS);
  if (allowance < amountWei) {
    const tx = await sdoge.approve(STAKING_CONTRACT_ADDRESS, ethers.MaxUint256);
    await tx.wait();
  }
}

async function doStake() {
  const raw = document.getElementById('stakeAmount').value;
  if (!raw || Number(raw) <= 0) return alert('Enter an amount to stake.');
  const amountWei = ethers.parseUnits(raw, 18);

  try {
    await ensureAllowance(amountWei);
    const tx = await staking.stake(selectedTier, amountWei);
    await tx.wait();
    document.getElementById('stakeAmount').value = '';
    await refreshBalance();
    await refreshOverview();
  } catch (err) {
    console.error(err);
    alert('Stake failed - see console for details.');
  }
}

async function exitStake(stakeId) {
  try {
    const tx = await staking.exitStake(stakeId);
    await tx.wait();
    await refreshBalance();
    await refreshOverview();
  } catch (err) {
    console.error(err);
    alert('Exit failed - see console for details.');
  }
}

async function claimAll() {
  if (!staking || !userAddress) return;
  try {
    const ids = await staking.getStakeIds(userAddress);
    for (const id of ids) {
      const reward = await staking.pendingReward(id);
      if (reward > 0n) {
        const tx = await staking.claimReward(id);
        await tx.wait();
      }
    }
    await refreshOverview();
  } catch (err) {
    console.error(err);
    alert('Claim failed - see console for details.');
  }
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
    if (!sdoge || !userAddress) return connectWallet();
    const bal = await sdoge.balanceOf(userAddress);
    document.getElementById('stakeAmount').value = ethers.formatUnits(bal, 18);
  });

  document.querySelectorAll('.percent-row button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!sdoge || !userAddress) return connectWallet();
      const bal = await sdoge.balanceOf(userAddress);
      const pct = Number(btn.dataset.pct);
      const amount = (bal * BigInt(pct)) / 100n;
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
