// $SDOGE NFT collection UI: the 12 SDOGECollectibles designs. Needs arc.js and wallet.js.
//
// Two modes, automatically:
// - SDOGE_CONTRACTS.collectibles unset (today): the roster renders as a preview with the
//   placeholder prices below, and Mint only explains that it isn't live yet.
// - Set (after deploy): every card's price, supply and sale state come from the contract on Arc,
//   and Mint writes to it.
//
// Safety rules this file follows (from the audit):
// - Reads go to Arc's RPC; every write first checks the wallet is on Arc and is pinned to 5042.
// - A design is only mintable if its on-chain name matches the roster's name for that id, so a
//   misnumbered deploy can't sell one design's art under another's terms.
// - Once the contract is live nothing falls back to the placeholders: a read that still fails
//   after retries shows "Unavailable" and disables Mint.
// - Each card says whether the design's cap is locked (it can only ever be raised while it isn't).
// - The price is re-read right before minting and paid exactly, as a BigInt.
const COLLECTIBLES_CONTRACT_ADDRESS = SDOGE_CONTRACTS.collectibles;

const COLLECTIBLES_ABI = [
  'function mint(uint256 designId, uint256 amount) payable',
  'function designs(uint256) view returns (string name, uint256 maxSupply, uint256 minted, uint256 priceWei, uint256 reserved, uint256 ownerMinted, bool exists, bool publicMintOpen, bool supplyLocked)',
];

const collectiblesDeployed = () => isAddressSet(COLLECTIBLES_CONTRACT_ADDRESS);

// Must match nft/designs.json (the deploy manifest) and nft/metadata/{id}.json; the front-end
// tests check both. priceUsdc/maxSupply/tier are the preview placeholders ("Open questions" in
// nft/README.md); once deployed, price and supply come from the contract.
const ROSTER = [
  { designId: 1, name: 'SWAT Doge', file: 'nft/reference/swat-doge.jpg', video: 'nft/reference/animated/swat-doge.mp4', tier: 'epic', priceUsdc: 40, maxSupply: 300 },
  { designId: 2, name: 'Space Doge', file: 'nft/reference/astronaut-doge.jpg', video: 'nft/reference/animated/astronaut-doge.mp4', tier: 'legendary', priceUsdc: 50, maxSupply: 200 },
  { designId: 3, name: 'Bucket Hat Doge', file: 'nft/reference/bucket-hat-doge.jpg', video: 'nft/reference/animated/bucket-hat-doge.mp4', tier: 'rare', priceUsdc: 30, maxSupply: 400 },
  { designId: 4, name: 'Rich Doge', file: 'nft/reference/rich-doge.jpg', video: 'nft/reference/animated/rich-doge.mp4', tier: 'epic', priceUsdc: 40, maxSupply: 300 },
  { designId: 5, name: 'Hoodie Doge', file: 'nft/reference/hoodie-doge.jpg', video: 'nft/reference/animated/hoodie-doge.mp4', tier: 'rare', priceUsdc: 30, maxSupply: 400 },
  { designId: 6, name: 'Cap Doge', file: 'nft/reference/cap-doge.jpg', video: 'nft/reference/animated/cap-doge.mp4', tier: 'og', priceUsdc: 20, maxSupply: 500 },
  { designId: 7, name: 'Blazed Doge', file: 'nft/reference/blazed-doge.jpg', video: 'nft/reference/animated/blazed-doge.mp4', tier: 'og', priceUsdc: 20, maxSupply: 500 },
  { designId: 8, name: 'Degen Doge', file: 'nft/reference/degen-doge.jpg', video: 'nft/reference/animated/degen-doge.mp4', tier: 'rare', priceUsdc: 30, maxSupply: 400 },
  { designId: 9, name: 'Samurai Doge', file: 'nft/reference/samurai-doge.png', video: null, tier: 'epic', priceUsdc: 40, maxSupply: 300 },
  { designId: 10, name: 'Viking Doge', file: 'nft/reference/viking-doge.png', video: null, tier: 'legendary', priceUsdc: 50, maxSupply: 200 },
  { designId: 11, name: 'Cyberpunk Doge', file: 'nft/reference/cyberpunk-doge.png', video: null, tier: 'epic', priceUsdc: 40, maxSupply: 300 },
  { designId: 12, name: 'Champion Doge', file: 'nft/reference/champion-doge.png', video: null, tier: 'legendary', priceUsdc: 50, maxSupply: 200 },
];

const MINT_LABEL = {
  preview: 'Preview',
  loading: 'Loading...',
  unavailable: 'Unavailable',
  closed: 'Not open yet',
  soldout: 'Sold Out',
  open: 'Mint',
};

// Staking one of these with $SDOGE raises the stake's share of the rewards, by design. Once the
// staking contract is live each card shows its on-chain boost; before any launch, the placeholder
// tiers in nft/staking-boosts.json (the front-end tests check they match). With the NFT contract
// live but staking not yet, no boost is shown rather than a number nobody has set.
const PREVIEW_BOOST_BPS = { og: 1000, rare: 2000, epic: 3000, legendary: 5000 };
const STAKING_BOOST_ABI = ['function designBoostBps(uint256) view returns (uint256)'];
const stakingBoostsLive = () => isAddressSet(SDOGE_CONTRACTS.staking);
const designBoost = {}; // designId -> boost in basis points, read from the staking contract

const collectiblesRead = collectiblesDeployed()
  ? new ethers.Contract(COLLECTIBLES_CONTRACT_ADDRESS, COLLECTIBLES_ABI, arcReadProvider)
  : null;
let collectiblesWrite;
let activeFilter = 'all';
let collectiblesUnavailable = false;
const designState = {}; // designId -> { status, minted, maxSupply, priceWei, left }

function boostBpsOf(item) {
  if (stakingBoostsLive()) return designBoost[item.designId];
  return collectiblesDeployed() ? undefined : PREVIEW_BOOST_BPS[item.tier];
}

// On-chain design -> what the card shows.
function designStatus(item, d) {
  if (!d.exists || d.name !== item.name) return { status: 'unavailable' };
  const left = d.maxSupply - d.minted - (d.reserved - d.ownerMinted);
  const status = !d.publicMintOpen || d.priceWei === 0n ? 'closed' : left <= 0n ? 'soldout' : 'open';
  return { status, minted: d.minted, maxSupply: d.maxSupply, priceWei: d.priceWei, left, supplyLocked: d.supplyLocked };
}

function statusOf(item) {
  if (!collectiblesDeployed()) return { status: 'preview' };
  return designState[item.designId] || { status: collectiblesUnavailable ? 'unavailable' : 'loading' };
}

function cardHtml(item) {
  const s = statusOf(item);
  const live = s.maxSupply !== undefined;
  const supply = live
    ? `${fmt(s.minted)} / ${fmt(s.maxSupply)} minted &middot; ${s.supplyLocked ? 'cap locked' : 'cap not locked yet'}`
    : s.status === 'preview'
      ? `0 / ${fmt(item.maxSupply)} minted`
      : '';
  const boost = boostBpsOf(item);
  const price = live
    ? s.priceWei > 0n
      ? `$${usdcText(s.priceWei)} USDC`
      : 'Giveaway only'
    : s.status === 'preview'
      ? `$${item.priceUsdc} USDC`
      : '&mdash;';
  const clickable = s.status === 'preview' || s.status === 'open';

  // webm (VP9) listed first: some browsers/webviews lack H.264 decode
  // support (confirmed in testing - the mp4 alone left the card blank
  // there), so give the browser both and let it pick what it can play.
  const media = item.video
    ? `<video autoplay muted loop playsinline>
         <source src="${item.video.replace('.mp4', '.webm')}" type="video/webm" />
         <source src="${item.video}" type="video/mp4" />
       </video>`
    : `<img src="${item.file}" alt="${item.name}" loading="lazy" />`;

  // Every copy of a design is the same ERC-1155 token, so the card shows the design's token number
  // (what the marketplace's "Token ID" asks for), never a made-up edition number.
  return `
    <div class="nft-card" data-tier="${item.tier}">
      <div class="nft-card__media">
        ${media}
        ${item.video ? '<span class="nft-card__animated">&#9679; Animated</span>' : ''}
      </div>
      <div class="nft-card__body">
        <div class="nft-card__row">
          <div class="nft-card__name">${item.name}</div>
          <span class="nft-card__badge nft-card__badge--${item.tier}">${item.tier}</span>
        </div>
        <div class="nft-card__supply">Token #${item.designId}${supply ? ` &middot; ${supply}` : ''}</div>
        ${boost > 0 ? `<div class="nft-card__boost">+${boost / 100}% staking boost</div>` : ''}
        <div class="nft-card__foot">
          <span class="nft-card__price">${price}</span>
          <button class="nft-card__mint" data-design="${item.designId}" ${clickable ? '' : 'disabled'}>${MINT_LABEL[s.status]}</button>
        </div>
      </div>
    </div>`;
}

function renderGrid() {
  const grid = document.getElementById('nftGrid');
  const items = activeFilter === 'all' ? ROSTER : ROSTER.filter((i) => i.tier === activeFilter);
  grid.innerHTML = items.map(cardHtml).join('');
  grid.querySelectorAll('.nft-card__mint').forEach((btn) => {
    btn.addEventListener('click', () => mint(Number(btn.dataset.design)));
  });
}

async function loadLiveDesignData() {
  if (!collectiblesDeployed()) return;
  let hasCode;
  try {
    hasCode = await arcRetry(() => hasCodeOnArc(COLLECTIBLES_CONTRACT_ADDRESS));
  } catch (err) {
    console.error('Could not reach Arc:', err);
  }
  if (!hasCode) {
    collectiblesUnavailable = true;
    if (hasCode === false) console.error(`No collectibles contract at ${COLLECTIBLES_CONTRACT_ADDRESS} on Arc.`);
    renderGrid();
    return;
  }
  const results = await Promise.allSettled(ROSTER.map((item) => arcRetry(() => collectiblesRead.designs(item.designId))));
  results.forEach((r, i) => {
    const item = ROSTER[i];
    if (r.status === 'fulfilled') {
      designState[item.designId] = designStatus(item, r.value);
      if (designState[item.designId].status === 'unavailable') {
        console.error(`Design ${item.designId} on-chain ("${r.value.name}") doesn't match the roster ("${item.name}").`);
      }
    } else {
      designState[item.designId] = { status: 'unavailable' };
      console.error(`Could not read design ${item.designId}:`, r.reason);
    }
  });
  renderGrid();
}

async function loadDesignBoosts() {
  if (!stakingBoostsLive()) return;
  const staking = new ethers.Contract(SDOGE_CONTRACTS.staking, STAKING_BOOST_ABI, arcReadProvider);
  const results = await Promise.allSettled(ROSTER.map((item) => arcRetry(() => staking.designBoostBps(item.designId))));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') designBoost[ROSTER[i].designId] = Number(r.value);
    else console.error(`Could not read the staking boost of design ${ROSTER[i].designId}:`, r.reason);
  });
  renderGrid();
}

async function mint(designId) {
  const item = ROSTER.find((i) => i.designId === designId);
  if (!collectiblesDeployed()) {
    alert('Not live yet: this is a preview of the collection. Minting opens once the contract is deployed.');
    return;
  }
  if (!(await walletReady())) return;
  let fresh;
  try {
    fresh = designStatus(item, await collectiblesRead.designs(designId));
  } catch (err) {
    console.error(err);
    alert(`Could not read ${item.name} from the contract: ${reason(err)}`);
    return;
  }
  const shown = designState[designId];
  designState[designId] = fresh;
  if (fresh.status !== 'open') {
    renderGrid();
    alert(`${item.name} can't be minted right now (${MINT_LABEL[fresh.status].toLowerCase()}).`);
    return;
  }
  if (!shown || shown.priceWei !== fresh.priceWei) {
    renderGrid();
    alert(`${item.name}'s price just changed to ${usdcText(fresh.priceWei)} USDC. Check it, then mint again.`);
    return;
  }
  if (!collectiblesWrite) collectiblesWrite = new ethers.Contract(COLLECTIBLES_CONTRACT_ADDRESS, COLLECTIBLES_ABI, signer);
  try {
    await (await collectiblesWrite.mint(designId, 1, arcTx({ value: fresh.priceWei }))).wait();
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`Mint failed: ${reason(err)}`);
  }
  await loadLiveDesignData();
}

document.addEventListener('DOMContentLoaded', () => {
  arcShowLiveCopy(collectiblesDeployed());
  renderGrid();
  loadLiveDesignData();
  loadDesignBoosts();

  document.querySelectorAll('.filter-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      activeFilter = tab.dataset.filter;
      renderGrid();
    });
  });
});
