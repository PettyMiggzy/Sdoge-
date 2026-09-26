// $SDOGE Staking page (staking.html).
//
// Two modes, automatically:
// - SDOGE_CONTRACTS.staking unset (today): the page shows the fixed terms and "—" for the live
//   numbers, and wallet actions are off ("Staking opens soon").
// - Set (after deploy, by contracts/scripts/sync-frontend.js): everything reads the live contract
//   on Arc and every action writes to it.
//
// Safety rules this file follows (from the audits):
// - Reads go to Arc's RPC (arc.js); every write first checks the wallet is on Arc and is pinned
//   to chain 5042.
// - Lock status uses chain time, never the browser clock.
// - The tier terms and NFT boosts are read from the contract and passed back to it, and it
//   refuses a stake on any other terms.
// - Connecting waits for the first chain read, and failed reads are retried.
// - Leaving early always shows the exact penalty and forfeited rewards and needs a confirm.
// - Approvals are for the exact amount being staked. An NFT stake sends that one NFT together
//   with the stake's terms: no blanket NFT approval is ever asked for.
// - Every number is real: from the chain, plus $SDOGE's price from DexScreener for the USDC part
//   of the APR, or "—".
const STAKING_CONTRACT_ADDRESS = SDOGE_CONTRACTS.staking;
const SDOGE_TOKEN_ADDRESS = SDOGE_CONTRACTS.token;

const YEAR_SECONDS = 365 * 86400;
const BPS = 10000n;
const DEFAULT_TIER_DAYS = [7, 30, 90, 180, 365];
const DEFAULT_TIER_MULT_BPS = [10000, 12000, 15000, 20000, 30000];

const STAKING_ABI = [
  'function stake(uint8 tier, uint256 amount, uint256 expectedDuration, uint256 expectedMultiplierBps) returns (uint256 stakeId)',
  'function exitStake(uint256 stakeId, bool allowEarly) returns (uint256 payout, uint256 reward, uint256 sdogeReward)',
  'function withdraw(uint256 stakeId, uint256 amount, address[] recipients, uint256[] splitAmounts, bool allowEarly) returns (uint256 payout, uint256 reward, uint256 sdogeReward)',
  'function claimReward(uint256 stakeId) returns (uint256 reward, uint256 sdogeReward)',
  'function claimDeferredRewards(address to) returns (uint256 amount)',
  'function claimDeferredNft(uint256 designId, address to)',
  'function deferredRewards(address) view returns (uint256)',
  'function deferredNfts(address, uint256) view returns (uint256)',
  'function getStakeIds(address user) view returns (uint256[])',
  'function getStake(uint256 stakeId) view returns ((address owner, uint8 tier, uint32 multiplierBps, uint16 penaltyBps, uint16 boostBps, bool closed, bool holdsNft, uint256 nftId, uint256 amount, uint256 weighted, uint256 startTime, uint256 unlockTime, uint256 matureTime, uint256 rewardPerWeightedSharePaid, uint256 accruedReward, uint256 sdogeRewardPerWeightedSharePaid, uint256 accruedSdogeReward))',
  'function pendingReward(uint256 stakeId) view returns (uint256)',
  'function pendingSdogeReward(uint256 stakeId) view returns (uint256)',
  'function previewExit(uint256 stakeId) view returns (uint256 payout, uint256 reward, uint256 sdogeReward, uint256 penalty, uint256 forfeitedReward, uint256 forfeitedSdogeReward, bool early)',
  'function tierDuration(uint256) view returns (uint256)',
  'function tierMultiplierBps(uint256) view returns (uint256)',
  'function earlyUnlockThresholdBps() view returns (uint256)',
  'function earlyWithdrawPenaltyBps() view returns (uint256)',
  'function totalPrincipalStaked() view returns (uint256)',
  'function totalWeightedSupply() view returns (uint256)',
  'function activeStakers() view returns (uint256)',
  'function totalSdogeRewardsPaid() view returns (uint256)',
  'function totalUsdcRewardsPaid() view returns (uint256)',
  'function rewardRate() view returns (uint256)',
  'function periodFinish() view returns (uint256)',
  'function sdogeRewardRate() view returns (uint256)',
  'function sdogePeriodFinish() view returns (uint256)',
  'function boostCollection() view returns (address)',
  'function designBoostBps(uint256) view returns (uint256)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];

const COLLECTION_ABI = [
  'function nextDesignId() view returns (uint256)',
  'function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])',
  'function designs(uint256) view returns (string name, uint256 maxSupply, uint256 minted, uint256 priceWei, uint256 reserved, uint256 ownerMinted, bool exists, bool publicMintOpen, bool supplyLocked)',
  'function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)',
];
const NFT_TERMS = ['uint8', 'uint256', 'uint256', 'uint256', 'uint256'];

const isDeployed = () => isAddressSet(STAKING_CONTRACT_ADDRESS);

let provider, signer, userAddress;
let stakingWrite, sdogeWrite, collectionWrite;
const stakingRead = isDeployed() ? new ethers.Contract(STAKING_CONTRACT_ADDRESS, STAKING_ABI, arcReadProvider) : null;
const sdogeRead = new ethers.Contract(SDOGE_TOKEN_ADDRESS, ERC20_ABI, arcReadProvider);
let collectionAddress = null; // the staking contract's boostCollection(), once read
let collectionRead = null;

let tierData = DEFAULT_TIER_DAYS.map((d, i) => ({
  tier: i,
  duration: BigInt(d * 86400),
  multiplierBps: BigInt(DEFAULT_TIER_MULT_BPS[i]),
}));
let earlyUnlockBps = 8000n;
let penaltyBps = 1500n;
let liveReady = false; // true once the live contract and its terms have been read
let liveLoad = null; // the first loadTierDataFromChain(), which connecting waits for
let selectedTier = 0;
let pool = null; // { totalWeighted, usdcRate, sdogeRate }: a rate is 0 once its period is over
let sdogePriceUsd = null;
let myNfts = []; // the wallet's Collectibles: [{ id, name, boostBps, count }]
const designNames = new Map();

// ---------- formatting ----------
const toFloat = (wei) => Number(ethers.formatEther(wei)); // for display only
const fmtNum = (n, max = 2) => Number(n).toLocaleString('en-US', { maximumFractionDigits: max });
function fmtToken(wei, max = 2) {
  const n = toFloat(wei);
  if (n > 0 && n < 10 ** -max) return `<${(10 ** -max).toFixed(max)}`;
  return fmtNum(n, max);
}
const fmtSdoge = (wei, max = 2) => `${fmtToken(wei, max)} SDOGE`;
const fmtUsdc = (wei) => `${fmtToken(wei, 4)} USDC`;
const fmtPct = (x) => {
  const pct = x * 100;
  if (pct >= 100000) return '>99,999%';
  return `${pct.toLocaleString('en-US', { maximumFractionDigits: pct < 10 ? 2 : 1 })}%`;
};
const bpsPct = (bps) => fmtNum(Number(bps) / 100, 2);
const multText = (bps) => `${(Number(bps) / 10000).toFixed(1)}×`;
const tierDays = (t) => Number(t.duration) / 86400;
const errText = arcErrorText;
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const shortAddress = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;
function durationText(seconds) {
  const s = Number(seconds);
  if (s <= 0) return 'now';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(m, 1)}m`;
}
const setText = (id, text) => {
  document.getElementById(id).textContent = text;
};

// ---------- reward math (the contract's weights) ----------
const weightOf = (amount, multBps, boostBps) => (amount * multBps * (BPS + boostBps)) / (BPS * BPS);

// Rewards a year for a position of `weight` holding `amount` of SDOGE, at the current reward
// rates: { apr, sdogePerDay, usdcPerDay, usdcMissing }. apr is a fraction (0.25 = 25%): the SDOGE
// stream plus the USDC stream at $SDOGE's price (left out, with usdcMissing, when there's no
// price). `joining` adds the position's own weight to the pool first. null when nobody is staked.
function yieldFor(amount, weight, joining) {
  if (!pool || amount <= 0n || weight <= 0n || pool.totalWeighted === 0n) return null;
  const total = pool.totalWeighted + (joining ? weight : 0n);
  const share = Number((weight * 10n ** 12n) / total) / 1e12;
  const sdogePerYear = toFloat(pool.sdogeRate) * YEAR_SECONDS * share;
  const usdcPerYear = toFloat(pool.usdcRate) * YEAR_SECONDS * share;
  const amt = toFloat(amount);
  let apr = sdogePerYear / amt;
  let usdcMissing = false;
  if (usdcPerYear > 0) {
    if (sdogePriceUsd > 0) apr += usdcPerYear / (amt * sdogePriceUsd);
    else usdcMissing = true;
  }
  return { apr, sdogePerDay: sdogePerYear / 365, usdcPerDay: usdcPerYear / 365, usdcMissing };
}
const aprText = (y) => (y ? fmtPct(y.apr) + (y.usdcMissing ? '+' : '') : '—');

// ---------- the stake form ----------
function renderTiers() {
  const grid = document.getElementById('tierGrid');
  grid.innerHTML = tierData
    .map(
      (t) => `
      <button type="button" class="stk-tier${t.tier === selectedTier ? ' is-selected' : ''}" data-tier="${t.tier}" role="radio" aria-checked="${t.tier === selectedTier}">
        <b>${fmtNum(tierDays(t), 1)} days</b><span>${multText(t.multiplierBps)}</span>
      </button>`
    )
    .join('');
  grid.querySelectorAll('.stk-tier').forEach((el) => {
    el.addEventListener('click', () => {
      selectedTier = Number(el.dataset.tier);
      renderTiers();
      updateEstimates();
    });
  });
}

// "" when the field is empty, null when it isn't a valid amount.
function typedAmount() {
  const raw = String(document.getElementById('stakeAmount').value ?? '').trim().replace(/,/g, '');
  if (!raw) return '';
  if (!/^(\d+\.?\d{0,18}|\.\d{1,18})$/.test(raw)) return null;
  return ethers.parseUnits(`0${raw}`.replace(/\.$/, ''), 18);
}

function selectedNft() {
  const v = document.getElementById('nftSelect').value;
  return v ? myNfts.find((n) => String(n.id) === v && n.boostBps > 0n) || null : null;
}

function renderNftPicker() {
  const sel = document.getElementById('nftSelect');
  const keep = sel.value;
  const usable = myNfts.filter((n) => n.boostBps > 0n);
  sel.innerHTML =
    '<option value="">No NFT</option>' +
    usable
      .map((n) => `<option value="${n.id}">${esc(n.name)} (+${bpsPct(n.boostBps)}%)${n.count > 1n ? ` x${n.count}` : ''}</option>`)
      .join('');
  sel.value = usable.some((n) => String(n.id) === keep) ? keep : '';
  let hint = 'Stake one of your SDOGE NFTs with this stake to earn up to 50% more. It comes back when the stake ends.';
  if (userAddress && liveReady) {
    if (!collectionAddress) hint = "NFT boosts aren't switched on for this staking contract.";
    else if (!usable.length) hint = "You don't have an SDOGE NFT that boosts stakes yet. Get one on the NFT page.";
    else hint = 'The NFT is held with this stake and comes back to you when it ends, early or not. It is never penalized.';
  }
  setText('nftHint', hint);
}

function updateEstimates() {
  const t = tierData[selectedTier];
  const nft = selectedNft();
  const boost = nft ? nft.boostBps : 0n;
  setText('metaLockLength', `${fmtNum(tierDays(t), 1)} days`);
  setText('metaMultiplier', `${multText(t.multiplierBps)} rewards${boost > 0n ? `, +${bpsPct(boost)}% NFT` : ''}`);
  const matureDays = (tierDays(t) * Number(earlyUnlockBps)) / 10000;
  setText(
    'stakeTerms',
    `Penalty-free after ${fmtNum(matureDays, 1)} days (${bpsPct(earlyUnlockBps)}% of the lock). Leave before that and ` +
      `${bpsPct(penaltyBps)}% of what you take out stays in the pool for the stakers who stay, and the stake's rewards are forfeited.`
  );

  const typed = typedAmount();
  const amount = typed ? typed : 10n ** 18n; // the rate for 1 SDOGE until an amount is typed
  const y = yieldFor(amount, weightOf(amount, t.multiplierBps, boost), true);
  setText('estApr', aprText(y));
  if (y && typed) {
    setText('estDaily', `${fmtNum(y.sdogePerDay, 2)} SDOGE`);
    setText('estDailyUsdc', y.usdcPerDay > 0 ? `+ ${fmtNum(y.usdcPerDay, 4)} USDC` : '');
  } else {
    setText('estDaily', '0 SDOGE');
    setText('estDailyUsdc', '');
  }
}

function setStakeButton() {
  const btn = document.getElementById('connectOrStakeBtn');
  if (!userAddress) return;
  const live = isDeployed() && liveReady;
  btn.textContent = !isDeployed() ? 'Staking opens soon' : live ? 'Stake' : 'Staking unavailable';
  btn.disabled = !live;
}

function showUnavailable(message) {
  liveReady = false;
  for (const id of ['statTotalStaked', 'statApr', 'statStakers', 'statRewardsPaid', 'estApr']) setText(id, 'Unavailable');
  setStakeButton();
  console.error(message);
}

// ---------- reading the chain ----------
async function readTier(i) {
  const [duration, multiplierBps] = await Promise.all([stakingRead.tierDuration(i), stakingRead.tierMultiplierBps(i)]);
  return { tier: i, duration, multiplierBps };
}

async function loadPool() {
  const [totalStaked, totalWeighted, stakers, sdogePaid, usdcPaid, usdcRate, usdcFinish, sdogeRate, sdogeFinish, now] =
    await arcRetry(() =>
      Promise.all([
        stakingRead.totalPrincipalStaked(),
        stakingRead.totalWeightedSupply(),
        stakingRead.activeStakers(),
        stakingRead.totalSdogeRewardsPaid(),
        stakingRead.totalUsdcRewardsPaid(),
        stakingRead.rewardRate(),
        stakingRead.periodFinish(),
        stakingRead.sdogeRewardRate(),
        stakingRead.sdogePeriodFinish(),
        arcNow(),
      ])
    );
  pool = { totalWeighted, usdcRate: now < usdcFinish ? usdcRate : 0n, sdogeRate: now < sdogeFinish ? sdogeRate : 0n };
  setText('statTotalStaked', fmtToken(totalStaked, 0));
  setText('statStakers', fmtNum(stakers, 0));
  setText('statRewardsPaid', fmtToken(sdogePaid, 0));
  setText('statRewardsPaidUsdc', `SDOGE + ${fmtToken(usdcPaid, 2)} USDC`);
  const one = 10n ** 18n;
  setText('statApr', aprText(yieldFor(one, weightOf(one, BigInt(DEFAULT_TIER_MULT_BPS[0]), 0n), false)));
}

async function loadPrice() {
  if (typeof fetch !== 'function') return;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${SDOGE_TOKEN_ADDRESS}`, { signal: ctl.signal });
    clearTimeout(timer);
    const d = await r.json();
    const pairs = (d.pairs || []).filter((p) => p.chainId === 'arc');
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const price = Number(pairs[0]?.priceUsd);
    sdogePriceUsd = price > 0 ? price : null;
  } catch {
    sdogePriceUsd = null;
  }
}

async function loadTierDataFromChain() {
  if (!isDeployed()) return;
  try {
    if (!(await arcRetry(() => hasCodeOnArc(STAKING_CONTRACT_ADDRESS)))) {
      showUnavailable(`No staking contract at ${STAKING_CONTRACT_ADDRESS} on Arc.`);
      return;
    }
    tierData = await arcRetry(() => Promise.all([0, 1, 2, 3, 4].map(readTier)));
    const [unlock, penalty, collection] = await arcRetry(() =>
      Promise.all([stakingRead.earlyUnlockThresholdBps(), stakingRead.earlyWithdrawPenaltyBps(), stakingRead.boostCollection()])
    );
    earlyUnlockBps = unlock;
    penaltyBps = penalty;
    collectionAddress = collection === ethers.ZeroAddress ? null : collection;
    collectionRead = collectionAddress ? new ethers.Contract(collectionAddress, COLLECTION_ABI, arcReadProvider) : null;
    await loadPool();
    liveReady = true;
  } catch (err) {
    // Never fall back to the defaults here: they may not be the real terms.
    showUnavailable(`Could not read the staking contract: ${errText(err)}`);
    return;
  }
  renderTiers();
  updateEstimates();
}

async function designName(id) {
  if (!designNames.has(String(id))) {
    let name = `Design #${id}`;
    try {
      if (collectionRead) name = (await arcRetry(() => collectionRead.designs(id))).name || name;
    } catch (err) {
      console.error('designs() failed:', err);
    }
    designNames.set(String(id), name);
  }
  return designNames.get(String(id));
}

async function loadMyNfts() {
  myNfts = [];
  if (collectionRead && userAddress && liveReady) {
    try {
      const next = await arcRetry(() => collectionRead.nextDesignId());
      const ids = [];
      for (let i = 1n; i < next; i++) ids.push(i);
      const balances = ids.length ? await arcRetry(() => collectionRead.balanceOfBatch(ids.map(() => userAddress), ids)) : [];
      for (let i = 0; i < ids.length; i++) {
        if (balances[i] === 0n) continue;
        const boostBps = await arcRetry(() => stakingRead.designBoostBps(ids[i]));
        myNfts.push({ id: ids[i], name: await designName(ids[i]), boostBps, count: balances[i] });
      }
    } catch (err) {
      console.error('loadMyNfts failed:', err);
    }
  }
  renderNftPicker();
  updateEstimates();
}

// ---------- wallet ----------
async function connectWallet() {
  if (!window.ethereum) {
    alert('No wallet found. Open this page in your wallet app, or install MetaMask or another wallet.');
    return false;
  }
  try {
    if (!(await ensureArcNetwork())) return false;
    provider = new ethers.BrowserProvider(arcWalletBridge(window.ethereum));
    await provider.send('eth_requestAccounts', []);
    signer = await provider.getSigner();
    userAddress = await signer.getAddress();
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`Could not connect: ${errText(err)}`);
    return false;
  }
  arcTrackSigner(userAddress);

  sdogeWrite = new ethers.Contract(SDOGE_TOKEN_ADDRESS, ERC20_ABI, signer);
  if (isDeployed()) {
    stakingWrite = new ethers.Contract(STAKING_CONTRACT_ADDRESS, STAKING_ABI, signer);
    await (liveLoad ||= loadTierDataFromChain()); // don't judge the page before its first read
  }
  setText('overviewWallet', shortAddress(userAddress));
  setStakeButton();

  await refreshBalance();
  if (isDeployed() && liveReady) {
    if (collectionAddress) collectionWrite = new ethers.Contract(collectionAddress, COLLECTION_ABI, signer);
    await loadMyNfts();
    await refreshOverview();
  }
  return true;
}

async function refreshBalance() {
  if (!userAddress) return;
  try {
    const bal = await arcRetry(() => sdogeRead.balanceOf(userAddress));
    setText('sdogeBalance', fmtToken(bal, 2));
  } catch (err) {
    console.error('balanceOf failed:', err);
  }
}

// ---------- the wallet's stakes ----------
async function loadMyStakes(closedNftIds) {
  const [ids, now] = await arcRetry(() => Promise.all([stakingRead.getStakeIds(userAddress), arcNow()]));
  const rows = [];
  for (const id of ids) {
    const s = await arcRetry(() => stakingRead.getStake(id));
    if (s.closed) {
      if (s.boostBps > 0n) closedNftIds.add(s.nftId);
      continue;
    }
    const [usdc, sdoge] = await arcRetry(() => Promise.all([stakingRead.pendingReward(id), stakingRead.pendingSdogeReward(id)]));
    rows.push({
      id,
      tier: Number(s.tier),
      multiplierBps: BigInt(s.multiplierBps),
      boostBps: BigInt(s.boostBps),
      nftId: s.nftId,
      nftName: s.boostBps > 0n ? await designName(s.nftId) : null,
      amount: s.amount,
      weighted: s.weighted,
      usdc,
      sdoge,
      mature: now >= s.matureTime,
      matureTime: s.matureTime,
      now,
    });
  }
  return rows;
}

function stakeRowHtml(r) {
  const days = fmtNum(tierDays(tierData[r.tier] || { duration: 0n }), 1);
  const earned = `Earned <b>${fmtSdoge(r.sdoge)}</b>${r.usdc > 0n ? ` + <b>${fmtUsdc(r.usdc)}</b>` : ''}`;
  const status = r.mature
    ? 'free to claim or unstake'
    : `matures in ${durationText(r.matureTime - r.now)}; leaving before then forfeits these rewards`;
  const hasReward = r.sdoge > 0n || r.usdc > 0n;
  return `
    <div class="stk-stake">
      <div class="stk-stake__top">
        <span class="stk-stake__amount">${fmtSdoge(r.amount)}</span>
        <span class="stk-tag">${days} days · ${multText(r.multiplierBps)}</span>
        ${r.boostBps > 0n ? `<span class="stk-tag stk-tag--nft">${esc(r.nftName)} +${bpsPct(r.boostBps)}%</span>` : ''}
        ${r.mature ? '<span class="stk-tag stk-tag--ok">Matured</span>' : ''}
      </div>
      <div class="stk-stake__meta">${earned} · ${status}</div>
      <div class="stk-stake__actions">
        ${r.mature && hasReward ? `<button type="button" class="stk-btn stk-btn--soft" data-claim="${r.id}">Claim</button>` : ''}
        <button type="button" class="stk-btn ${r.mature ? 'stk-btn--ghost' : 'stk-btn--warn'}" data-exit="${r.id}">${r.mature ? 'Unstake' : 'Unstake early'}</button>
        <button type="button" class="stk-btn stk-btn--ghost" data-split="${r.id}">Send to other wallets</button>
      </div>
    </div>`;
}

async function refreshOverview() {
  if (!stakingRead || !userAddress || !liveReady) return;
  try {
    const closedNftIds = new Set();
    const rows = await loadMyStakes(closedNftIds);
    const deferred = await arcRetry(() => stakingRead.deferredRewards(userAddress));
    const waitingNfts = [];
    for (const id of closedNftIds) {
      const n = await arcRetry(() => stakingRead.deferredNfts(userAddress, id));
      if (n > 0n) waitingNfts.push({ id, name: await designName(id) });
    }

    let staked = 0n;
    let weighted = 0n;
    let sdogeAll = 0n;
    let usdcAll = 0n;
    let sdogeReady = 0n;
    let usdcReady = 0n;
    let nextMature = null;
    const now = rows[0]?.now;
    for (const r of rows) {
      staked += r.amount;
      weighted += r.weighted;
      sdogeAll += r.sdoge;
      usdcAll += r.usdc;
      if (r.mature) {
        sdogeReady += r.sdoge;
        usdcReady += r.usdc;
      } else if (nextMature === null || r.matureTime < nextMature) nextMature = r.matureTime;
    }
    const readyNow = sdogeReady > 0n || usdcReady > 0n;

    setText('overviewStaked', fmtSdoge(staked));
    setText('overviewRewards', fmtSdoge(sdogeAll));
    const extra = [];
    if (usdcAll > 0n) extra.push(`+ ${fmtUsdc(usdcAll)}`);
    if (rows.length && (sdogeAll > 0n || usdcAll > 0n)) {
      extra.push(readyNow ? `${fmtSdoge(sdogeReady)}${usdcReady > 0n ? ` + ${fmtUsdc(usdcReady)}` : ''} ready to claim` : 'claimable once your stake matures');
    }
    setText('overviewRewardsUsdc', extra.join(' · '));
    document.getElementById('claimAllBtn').disabled = !readyNow;
    setText('overviewApr', aprText(yieldFor(staked, weighted, false)));
    setText('overviewLock', !rows.length ? '—' : rows.length === 1 ? `${fmtNum(tierDays(tierData[rows[0].tier]), 1)} days` : `${rows.length} stakes`);
    setText('overviewNext', readyNow ? 'Now' : nextMature !== null ? `in ${durationText(nextMature - now)}` : '--');

    const html = rows.map(stakeRowHtml);
    if (deferred > 0n) {
      html.unshift(`
        <div class="stk-stake">
          <div class="stk-stake__meta">A USDC payout your wallet couldn't take is waiting for you: <b>${fmtUsdc(deferred)}</b></div>
          <div class="stk-stake__actions"><button type="button" class="stk-btn stk-btn--soft" data-deferred="usdc">Collect</button></div>
        </div>`);
    }
    for (const n of waitingNfts) {
      html.unshift(`
        <div class="stk-stake">
          <div class="stk-stake__meta">Your NFT couldn't be sent back to your wallet and is waiting for you: <b>${esc(n.name)}</b></div>
          <div class="stk-stake__actions"><button type="button" class="stk-btn stk-btn--soft" data-deferred-nft="${n.id}">Collect</button></div>
        </div>`);
    }
    const list = document.getElementById('myStakesList');
    list.innerHTML = html.length ? html.join('') : '<p class="stk-empty">No stakes yet.</p>';
    list.querySelectorAll('[data-exit]').forEach((b) => b.addEventListener('click', () => exitStake(BigInt(b.dataset.exit))));
    list.querySelectorAll('[data-split]').forEach((b) => b.addEventListener('click', () => openSplit(BigInt(b.dataset.split))));
    list.querySelectorAll('[data-claim]').forEach((b) => b.addEventListener('click', () => claimOne(BigInt(b.dataset.claim))));
    list.querySelectorAll('[data-deferred]').forEach((b) => b.addEventListener('click', collectDeferred));
    list.querySelectorAll('[data-deferred-nft]').forEach((b) =>
      b.addEventListener('click', () => collectDeferredNft(BigInt(b.dataset.deferredNft)))
    );
  } catch (err) {
    console.error('refreshOverview failed:', err);
  }
}

// After a transaction: everything it can have changed.
async function refreshAll() {
  await refreshBalance();
  try {
    await loadPool();
  } catch (err) {
    console.error('loadPool failed:', err);
  }
  await loadMyNfts();
  await refreshOverview();
}

// ---------- actions ----------
async function ready() {
  if (!userAddress && !(await connectWallet())) return false;
  if (!liveReady) return false;
  return ensureArcNetwork();
}

async function doStake() {
  const amountWei = typedAmount();
  if (amountWei === '' || amountWei === 0n) return alert('Enter an amount to stake.');
  if (amountWei === null) return alert('Enter a valid amount.');
  if (!(await ready())) return;
  const nft = selectedNft();

  try {
    // Re-read the terms right now; the contract rejects the stake if they change again.
    const live = await arcRetry(() => readTier(selectedTier));
    const shown = tierData[selectedTier];
    if (live.duration !== shown.duration || live.multiplierBps !== shown.multiplierBps) {
      tierData[selectedTier] = live;
      renderTiers();
      updateEstimates();
      return alert("This tier's terms just changed. Check the new lock length and multiplier, then stake again.");
    }
    const balance = await arcRetry(() => sdogeRead.balanceOf(userAddress));
    if (balance < amountWei) return alert(`You have ${fmtSdoge(balance)}: not enough for this stake.`);

    let boost = 0n;
    if (nft) {
      boost = await arcRetry(() => stakingRead.designBoostBps(nft.id));
      if (boost !== nft.boostBps) {
        nft.boostBps = boost;
        renderNftPicker();
        updateEstimates();
        return alert(boost > 0n ? "This NFT's boost just changed. Check it, then stake again." : "This NFT doesn't boost stakes any more.");
      }
    }

    const allowance = await arcRetry(() => sdogeRead.allowance(userAddress, STAKING_CONTRACT_ADDRESS));
    if (allowance < amountWei) await (await sdogeWrite.approve(STAKING_CONTRACT_ADDRESS, amountWei, arcTx())).wait();
    if (nft) {
      // The NFT goes to the staking contract with the stake's terms; the contract opens the stake.
      const terms = ethers.AbiCoder.defaultAbiCoder().encode(NFT_TERMS, [selectedTier, amountWei, live.duration, live.multiplierBps, boost]);
      await (await collectionWrite.safeTransferFrom(userAddress, STAKING_CONTRACT_ADDRESS, nft.id, 1, terms, arcTx())).wait();
    } else {
      await (await stakingWrite.stake(selectedTier, amountWei, live.duration, live.multiplierBps, arcTx())).wait();
    }
    document.getElementById('stakeAmount').value = '';
    document.getElementById('nftSelect').value = '';
    await refreshAll();
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`Stake failed: ${errText(err)}`);
  }
}

async function exitStake(stakeId) {
  if (!(await ready())) return;
  try {
    const [p, s] = await arcRetry(() => Promise.all([stakingRead.previewExit(stakeId), stakingRead.getStake(stakeId)]));
    if (!p.early) {
      await (await stakingWrite.exitStake(stakeId, false, arcTx())).wait();
    } else {
      const ok = confirm(
        "This stake hasn't matured yet.\n\n" +
          `Leaving now costs ${fmtSdoge(p.penalty)}: the ${bpsPct(s.penaltyBps)}% early-exit penalty, which stays in the pool for the stakers who stay. ` +
          `It also forfeits ${fmtSdoge(p.forfeitedSdogeReward)} and ${fmtUsdc(p.forfeitedReward)} of rewards.\n` +
          `You would get back ${fmtSdoge(p.payout)}${s.holdsNft ? ' and your NFT' : ''}.\n\nUnstake early anyway?`
      );
      if (!ok) return;
      await (await stakingWrite.exitStake(stakeId, true, arcTx())).wait();
    }
    await refreshAll();
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`Unstake failed: ${errText(err)}`);
  }
}

// ---------- unstake to up to 4 wallets ----------
const MAX_SPLIT = 4;
// The open "Send to other wallets" window: { id, stakeAmount, penaltyBps, matureTime, holdsNft, now, rows: [{ addr, pct }] }
let splitState = null;

// "33.33" -> 3333 (hundredths of a percent), or null.
function pctToBps(p) {
  const s = String(p ?? '').trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * 100n + BigInt(`${frac}00`.slice(0, 2));
}

// Same parse as the stake form: "" when empty, null when it isn't an amount.
function parseSdoge(value) {
  const raw = String(value ?? '').trim().replace(/,/g, '');
  if (!raw) return '';
  if (!/^(\d+\.?\d{0,18}|\.\d{1,18})$/.test(raw)) return null;
  return ethers.parseUnits(`0${raw}`.replace(/\.$/, ''), 18);
}

// What withdrawing `amountWei` pays out (after the penalty when it's early, exactly as the
// contract computes it) and each wallet's share of it. The last wallet takes the rounding
// remainder, so the shares add up to the payout exactly, as the contract requires.
// { penalty, payout, recipients, amounts } or { error }.
function splitPlan(amountWei, stakeAmount, penaltyBpsOfStake, early, rows) {
  if (amountWei === '' || amountWei === null || amountWei <= 0n) return { error: 'Enter how much to unstake.' };
  if (amountWei > stakeAmount) return { error: `This stake holds ${fmtSdoge(stakeAmount)}.` };
  if (!rows.length || rows.length > MAX_SPLIT) return { error: 'Send it to 1 to 4 wallets.' };
  for (const r of rows) {
    const a = String(r.addr ?? '').trim();
    if (!ethers.isAddress(a)) return { error: `${a ? `"${a}" isn't` : 'Fill in'} a wallet address.` };
    if (/^0x0{40}$/i.test(a) || a.toLowerCase() === String(STAKING_CONTRACT_ADDRESS).toLowerCase()) return { error: "That address can't receive SDOGE." };
  }
  const bps = rows.map((r) => pctToBps(r.pct));
  if (bps.some((b) => b === null || b === 0n)) return { error: 'Give every wallet a share above 0%, with at most two decimals.' };
  const total = bps.reduce((s, b) => s + b, 0n);
  if (total !== BPS) return { error: `The shares add up to ${bpsPct(total)}%, not 100%.` };
  const penalty = early ? (amountWei * penaltyBpsOfStake) / BPS : 0n;
  const payout = amountWei - penalty;
  const amounts = bps.map((b) => (payout * b) / BPS);
  amounts[amounts.length - 1] = payout - amounts.slice(0, -1).reduce((s, a) => s + a, 0n);
  return { penalty, payout, recipients: rows.map((r) => ethers.getAddress(String(r.addr).trim())), amounts };
}

// Equal shares, the last one taking the remainder: 33.33 / 33.33 / 33.34.
function evenShares() {
  const n = BigInt(splitState.rows.length);
  splitState.rows.forEach((r, i) => {
    const b = i === splitState.rows.length - 1 ? BPS - (BPS / n) * (n - 1n) : BPS / n;
    r.pct = bpsPct(b).replace(/,/g, '');
  });
}

function renderSplitRows() {
  const box = document.getElementById('splitRows');
  box.innerHTML = splitState.rows
    .map(
      (r, i) => `
      <div class="stk-split__row">
        <input type="text" autocomplete="off" spellcheck="false" placeholder="0x... wallet address" aria-label="Wallet ${i + 1}" data-split-i="${i}" data-split-field="addr" value="${esc(r.addr)}" />
        <span class="stk-split__pct"><input type="text" inputmode="decimal" autocomplete="off" aria-label="Share for wallet ${i + 1}, percent" data-split-i="${i}" data-split-field="pct" value="${esc(r.pct)}" /></span>
        <button type="button" class="stk-chip" data-split-remove="${i}" aria-label="Remove wallet ${i + 1}"${splitState.rows.length === 1 ? ' disabled' : ''}>&times;</button>
      </div>`
    )
    .join('');
  box.querySelectorAll('[data-split-remove]').forEach((b) =>
    b.addEventListener('click', () => {
      splitState.rows.splice(Number(b.dataset.splitRemove), 1);
      evenShares();
      renderSplitRows();
      updateSplitSummary();
    })
  );
  document.getElementById('splitAddRow').disabled = splitState.rows.length >= MAX_SPLIT;
}

function currentSplitPlan() {
  const early = splitState.now < splitState.matureTime;
  const plan = splitPlan(parseSdoge(document.getElementById('splitAmount').value), splitState.stakeAmount, splitState.penaltyBps, early, splitState.rows);
  return { ...plan, early };
}

function updateSplitSummary() {
  if (!splitState) return;
  const plan = currentSplitPlan();
  setText(
    'splitInfo',
    plan.early
      ? `This stake hasn't matured (it does in ${durationText(splitState.matureTime - splitState.now)}). Unstaking now leaves ${bpsPct(splitState.penaltyBps)}% of what you take out in the pool for the stakers who stay, and forfeits this stake's rewards.`
      : 'This stake has matured: no penalty. Its rewards go to your own wallet.'
  );
  const el = document.getElementById('splitSummary');
  el.innerHTML = plan.error
    ? `<span class="is-bad">${esc(plan.error)}</span>`
    : `Sends <b>${fmtSdoge(plan.payout, 4)}</b>${plan.penalty > 0n ? ` (${fmtSdoge(plan.penalty, 4)} stays in the pool)` : ''}:<br>` +
      plan.recipients.map((a, i) => `${fmtSdoge(plan.amounts[i], 4)} to ${shortAddress(a)}`).join('<br>');
  document.getElementById('splitGo').disabled = Boolean(plan.error);
}

async function openSplit(stakeId) {
  if (!(await ready())) return;
  let s;
  let now;
  try {
    [s, now] = await arcRetry(() => Promise.all([stakingRead.getStake(stakeId), arcNow()]));
  } catch (err) {
    console.error(err);
    return alert(`Could not read the stake: ${errText(err)}`);
  }
  if (s.closed) return alert('That stake is already closed.');
  splitState = {
    id: stakeId,
    stakeAmount: s.amount,
    penaltyBps: BigInt(s.penaltyBps),
    matureTime: s.matureTime,
    holdsNft: s.holdsNft,
    now,
    rows: [{ addr: '', pct: '100' }],
  };
  document.getElementById('splitAmount').value = ethers.formatUnits(s.amount, 18).replace(/\.0$/, '');
  renderSplitRows();
  updateSplitSummary();
  document.getElementById('splitModal').hidden = false;
}

function closeSplit() {
  splitState = null;
  document.getElementById('splitModal').hidden = true;
}

async function submitSplit() {
  if (!splitState || !(await ready())) return;
  try {
    // Maturity is decided by the chain's clock at the moment the transaction lands.
    splitState.now = await arcRetry(arcNow);
    const plan = currentSplitPlan();
    if (plan.error) return alert(plan.error);
    const amountWei = plan.payout + plan.penalty;
    const closes = amountWei === splitState.stakeAmount;
    const lines = plan.recipients.map((a, i) => `  ${fmtSdoge(plan.amounts[i], 4)} to ${a}`).join('\n');
    const ok = confirm(
      `Unstake ${fmtSdoge(amountWei, 4)} and send:\n${lines}\n\n` +
        (plan.early
          ? `This stake hasn't matured: ${fmtSdoge(plan.penalty, 4)} (${bpsPct(splitState.penaltyBps)}%) stays in the pool for the stakers who stay, and this stake's rewards are forfeited.\n`
          : "This stake has matured: no penalty, and its rewards go to your own wallet.\n") +
        (closes && splitState.holdsNft ? 'This closes the stake, and its NFT goes back to your own wallet.\n' : '') +
        '\nGo ahead?'
    );
    if (!ok) return;
    await (await stakingWrite.withdraw(splitState.id, amountWei, plan.recipients, plan.amounts, plan.early, arcTx())).wait();
    closeSplit();
    await refreshAll();
  } catch (err) {
    console.error(err);
    if (userRejected(err)) return;
    const msg = errText(err);
    alert(
      /split amounts must sum|exit would be early/.test(msg)
        ? 'The stake matured while you were signing, so the amounts changed. Check them and send again.'
        : `Unstake failed: ${msg}`
    );
  }
}

async function claimOne(stakeId) {
  if (!(await ready())) return;
  try {
    await (await stakingWrite.claimReward(stakeId, arcTx())).wait();
    await refreshAll();
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`Claim failed: ${errText(err)}`);
  }
}

// Claims every matured stake with something to claim. Locked stakes are skipped (their rewards are
// still at risk), and one failure doesn't stop the rest.
async function claimAll() {
  if (!(await ready())) return;
  let rows;
  try {
    rows = (await loadMyStakes(new Set())).filter((r) => r.mature && (r.sdoge > 0n || r.usdc > 0n));
  } catch (err) {
    console.error(err);
    return alert(`Could not read your stakes: ${errText(err)}`);
  }
  if (!rows.length) return alert('Nothing ready to claim yet. Rewards on a stake unlock when it matures.');
  const failed = [];
  for (const r of rows) {
    try {
      await (await stakingWrite.claimReward(r.id, arcTx())).wait();
    } catch (err) {
      console.error(err);
      if (userRejected(err)) break; // the user cancelled: stop asking for the rest
      failed.push(`#${r.id}: ${errText(err)}`);
    }
  }
  await refreshAll();
  if (failed.length) alert(`Some claims failed:\n${failed.join('\n')}`);
}

// Asks where to send something the wallet can't take: its own address first, another if it can't.
async function pickRecipient(check, what) {
  try {
    await check(userAddress);
    return userAddress;
  } catch (err) {
    console.error(err);
    const other = prompt(`Your wallet can't receive the ${what} right now (${errText(err)}). Send it to which address instead?`);
    if (other === null) return null;
    if (!ethers.isAddress(other.trim())) {
      alert("That isn't an address.");
      return null;
    }
    const to = ethers.getAddress(other.trim());
    return confirm(`Send it to ${to}?`) ? to : null;
  }
}

async function collectDeferred() {
  if (!(await ready())) return;
  const to = await pickRecipient((a) => stakingWrite.claimDeferredRewards.staticCall(a), 'USDC');
  if (!to) return;
  try {
    await (await stakingWrite.claimDeferredRewards(to, arcTx())).wait();
    await refreshAll();
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`Collect failed: ${errText(err)}`);
  }
}

async function collectDeferredNft(designId) {
  if (!(await ready())) return;
  const to = await pickRecipient((a) => stakingWrite.claimDeferredNft.staticCall(designId, a), 'NFT');
  if (!to) return;
  try {
    await (await stakingWrite.claimDeferredNft(designId, to, arcTx())).wait();
    await refreshAll();
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`Collect failed: ${errText(err)}`);
  }
}

async function fillPercent(pct) {
  if (!userAddress) return connectWallet();
  try {
    const bal = await arcRetry(() => sdogeRead.balanceOf(userAddress));
    document.getElementById('stakeAmount').value = ethers.formatUnits((bal * BigInt(pct)) / 100n, 18);
    updateEstimates();
  } catch (err) {
    console.error(err);
  }
}

// ---------- wire up ----------
document.addEventListener('DOMContentLoaded', () => {
  arcShowLiveCopy(isDeployed());
  // The FAQ's "unstake without this site" link: straight to the contract's Write tab.
  if (isDeployed()) {
    document.querySelectorAll('[data-staking-explorer]').forEach((a) => {
      a.href = `${ARC_EXPLORER_URL}/address/${STAKING_CONTRACT_ADDRESS}?tab=write_contract`;
    });
  }
  renderTiers();
  renderNftPicker();
  updateEstimates();
  loadPrice().then(() => {
    if (liveReady) {
      updateEstimates();
      loadPool().catch((err) => console.error(err));
    }
  });
  liveLoad ||= loadTierDataFromChain();

  document.getElementById('connectOrStakeBtn').addEventListener('click', async () => {
    if (!userAddress) {
      await connectWallet();
      return;
    }
    if (isDeployed()) await doStake();
  });
  document.getElementById('overviewConnectBtn').addEventListener('click', () => {
    if (!userAddress) connectWallet();
  });
  document.getElementById('claimAllBtn').addEventListener('click', claimAll);
  document.getElementById('maxStakeBtn').addEventListener('click', () => fillPercent(100));
  document.querySelectorAll('.stk-pcts button').forEach((btn) => btn.addEventListener('click', () => fillPercent(Number(btn.dataset.pct))));
  document.getElementById('stakeAmount').addEventListener('input', updateEstimates);
  document.getElementById('nftSelect').addEventListener('change', updateEstimates);

  // Unstake to other wallets
  document.getElementById('splitClose').addEventListener('click', closeSplit);
  document.getElementById('splitGo').addEventListener('click', submitSplit);
  document.getElementById('splitAmount').addEventListener('input', updateSplitSummary);
  document.getElementById('splitMax').addEventListener('click', () => {
    if (!splitState) return;
    document.getElementById('splitAmount').value = ethers.formatUnits(splitState.stakeAmount, 18).replace(/\.0$/, '');
    updateSplitSummary();
  });
  document.getElementById('splitAddRow').addEventListener('click', () => {
    if (!splitState || splitState.rows.length >= MAX_SPLIT) return;
    splitState.rows.push({ addr: '', pct: '' });
    evenShares();
    renderSplitRows();
    updateSplitSummary();
  });
  document.getElementById('splitRows').addEventListener('input', (e) => {
    const i = Number(e.target?.dataset?.splitI);
    const field = e.target?.dataset?.splitField;
    if (!splitState || !splitState.rows[i] || !field) return;
    splitState.rows[i][field] = e.target.value;
    updateSplitSummary();
  });
  document.getElementById('splitModal').addEventListener('click', (e) => {
    if (e.target?.id === 'splitModal') closeSplit(); // a click outside the box
  });

  document.querySelectorAll('.stk-seg__btn').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.stk-seg__btn').forEach((t) => {
        t.classList.toggle('is-active', t === tab);
        t.setAttribute('aria-selected', String(t === tab));
      });
      const isStake = tab.dataset.tab === 'stake';
      document.getElementById('tabPanelStake').hidden = !isStake;
      document.getElementById('tabPanelUnstake').hidden = isStake;
      if (!isStake && userAddress) refreshOverview();
    });
  });

  // Rewards build up every second: keep the numbers current while the page is open.
  if (typeof setInterval === 'function' && isDeployed()) {
    setInterval(() => {
      if (!liveReady || document.hidden) return;
      loadPool().then(updateEstimates).catch((err) => console.error(err));
      if (userAddress) refreshOverview();
    }, 30000);
  }
});
