// $SDOGE NFT collection UI.
//
// Same two-mode pattern as staking.js: works fully as a browsable preview
// today (roster/images/prices render, Mint is disabled), and switches to
// live contract reads/writes the moment a real address is set below.
const COLLECTIBLES_CONTRACT_ADDRESS = ''; // e.g. '0x...'

const COLLECTIBLES_ABI = [
  'function mint(uint256 designId, uint256 amount) payable',
  'function designs(uint256) view returns (string name, uint256 maxSupply, uint256 minted, uint256 priceWei, bool exists)',
];

const isDeployed = () => COLLECTIBLES_CONTRACT_ADDRESS && COLLECTIBLES_CONTRACT_ADDRESS.length === 42;

// designId matches the creation order documented in nft/README.md /
// nft/metadata/{id}.json. priceUsdc/maxSupply/tier are illustrative
// placeholders (the $20/$30/$40/$50 spread floated early on) pending a
// real decision - see "Open questions" in nft/README.md. Once deployed,
// price and supply are re-read live from designs(id) and these values are
// only used as the pre-connect display.
const ROSTER = [
  { designId: 1, name: 'SWAT Doge', file: 'nft/reference/swat-doge.jpg', video: 'nft/reference/animated/swat-doge.mp4', tier: 'epic', priceUsdc: 40, maxSupply: 300 },
  { designId: 2, name: 'Astronaut Doge', file: 'nft/reference/astronaut-doge.jpg', video: 'nft/reference/animated/astronaut-doge.mp4', tier: 'legendary', priceUsdc: 50, maxSupply: 200 },
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

let provider, signer, userAddress, collectibles;
let activeFilter = 'all';
let liveDesignData = {}; // designId -> { minted, maxSupply, priceUsdc }

const fmt = (n) => Number(n).toLocaleString('en-US');

function cardHtml(item) {
  const live = liveDesignData[item.designId];
  const minted = live ? live.minted : 0;
  const maxSupply = live ? live.maxSupply : item.maxSupply;
  const priceUsdc = live ? live.priceUsdc : item.priceUsdc;
  const soldOut = minted >= maxSupply;

  // webm (VP9) listed first: some browsers/webviews lack H.264 decode
  // support (confirmed in testing - the mp4 alone left the card blank
  // there), so give the browser both and let it pick what it can play.
  const media = item.video
    ? `<video autoplay muted loop playsinline>
         <source src="${item.video.replace('.mp4', '.webm')}" type="video/webm" />
         <source src="${item.video}" type="video/mp4" />
       </video>`
    : `<img src="${item.file}" alt="${item.name}" loading="lazy" />`;

  return `
    <div class="nft-card" data-tier="${item.tier}">
      <div class="nft-card__media">
        ${media}
        <span class="nft-card__badge nft-card__badge--${item.tier}">${item.tier}</span>
        ${item.video ? '<span class="nft-card__animated">&#9679; Animated</span>' : ''}
      </div>
      <div class="nft-card__body">
        <div class="nft-card__name">${item.name}</div>
        <div class="nft-card__supply">${fmt(minted)} / ${fmt(maxSupply)} minted</div>
        <div class="nft-card__foot">
          <span class="nft-card__price">$${priceUsdc} USDC</span>
          <button class="nft-card__mint" data-design="${item.designId}" data-price="${priceUsdc}" ${soldOut ? 'disabled' : ''}>
            ${soldOut ? 'Sold Out' : isDeployed() ? 'Mint' : 'Preview'}
          </button>
        </div>
      </div>
    </div>`;
}

function renderGrid() {
  const grid = document.getElementById('nftGrid');
  const items = activeFilter === 'all' ? ROSTER : ROSTER.filter((i) => i.tier === activeFilter);
  grid.innerHTML = items.map(cardHtml).join('');

  grid.querySelectorAll('.nft-card__mint').forEach((btn) => {
    btn.addEventListener('click', () => mint(Number(btn.dataset.design), Number(btn.dataset.price)));
  });
}

async function loadLiveDesignData() {
  if (!isDeployed()) return;
  try {
    const ro = provider || new ethers.BrowserProvider(window.ethereum);
    const ro_contract = new ethers.Contract(COLLECTIBLES_CONTRACT_ADDRESS, COLLECTIBLES_ABI, ro);
    for (const item of ROSTER) {
      const d = await ro_contract.designs(item.designId);
      if (!d.exists) continue;
      liveDesignData[item.designId] = {
        minted: Number(d.minted),
        maxSupply: Number(d.maxSupply),
        priceUsdc: Number(ethers.formatEther(d.priceWei)),
      };
    }
    renderGrid();
  } catch (err) {
    console.error('Could not load live design data, showing placeholders:', err);
  }
}

async function connectWallet() {
  if (!window.ethereum) {
    alert('No wallet found. Install MetaMask or another injected wallet to continue.');
    return;
  }
  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send('eth_requestAccounts', []);
  signer = await provider.getSigner();
  userAddress = await signer.getAddress();
  if (isDeployed()) collectibles = new ethers.Contract(COLLECTIBLES_CONTRACT_ADDRESS, COLLECTIBLES_ABI, signer);

  document.querySelectorAll('.js-connect-wallet').forEach((btn) => {
    btn.textContent = `${userAddress.slice(0, 6)}...${userAddress.slice(-4)}`;
  });
}

async function mint(designId, priceUsdc) {
  if (!isDeployed()) return alert('Not deployed yet - this is a preview. Connect Wallet just confirms your address for now.');
  if (!userAddress) {
    await connectWallet();
    if (!userAddress) return;
  }
  try {
    const tx = await collectibles.mint(designId, 1, { value: ethers.parseEther(String(priceUsdc)) });
    await tx.wait();
    await loadLiveDesignData();
  } catch (err) {
    console.error(err);
    alert('Mint failed - see console for details.');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  renderGrid();
  loadLiveDesignData();

  document.querySelectorAll('.js-connect-wallet').forEach((btn) => btn.addEventListener('click', connectWallet));

  document.querySelectorAll('.filter-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      activeFilter = tab.dataset.filter;
      renderGrid();
    });
  });
});
