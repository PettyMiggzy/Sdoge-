// $SDOGE NFT Marketplace UI - resale for both NFT contracts.
//
// Deliberately reuses nft.js's page-shared wallet state (provider/signer/
// userAddress, connectWallet(), fmt(), COLLECTIBLES_CONTRACT_ADDRESS)
// instead of redeclaring it: nft.js and marketplace.js both load as plain
// (non-module) scripts on nft.html, so their top-level `let`/`const`
// bindings and function declarations already share one global scope -
// redeclaring any of those names here would throw a SyntaxError and break
// both scripts. This file only introduces new names.
//
// Same two-mode pattern as staking.js/nft.js: fully browsable today
// (listings panel shows a clear "not deployed yet" state), switches to
// live contract reads/writes the moment the addresses below are set.
const MARKETPLACE_CONTRACT_ADDRESS = ''; // e.g. '0x...' - see contracts/contracts/SDOGENFTMarketplace.sol
const COMMUNITY_MINT_CONTRACT_ADDRESS = ''; // e.g. '0x...' - see contracts/contracts/SDOGECommunityMint.sol
// COLLECTIBLES_CONTRACT_ADDRESS is nft.js's - reused as-is, not redeclared.

const MARKETPLACE_ABI = [
  'function listERC721(address nftContract, uint256 tokenId, uint256 pricePerUnit) returns (uint256)',
  'function listERC1155(address nftContract, uint256 tokenId, uint256 amount, uint256 pricePerUnit) returns (uint256)',
  'function updatePrice(uint256 listingId, uint256 newPricePerUnit)',
  'function cancelListing(uint256 listingId)',
  'function buy(uint256 listingId, uint256 amount) payable',
  'function getListing(uint256 listingId) view returns (tuple(address seller, address nftContract, uint8 standard, uint256 tokenId, uint256 amount, uint256 pricePerUnit, bool active))',
  'function nextListingId() view returns (uint256)',
  'function feeBps() view returns (uint256)',
];

const ERC721_MIN_ABI = [
  'function approve(address,uint256)',
  'function getApproved(uint256) view returns (address)',
  'function isApprovedForAll(address,address) view returns (bool)',
];

const ERC1155_MIN_ABI = [
  'function balanceOf(address,uint256) view returns (uint256)',
  'function isApprovedForAll(address,address) view returns (bool)',
  'function setApprovalForAll(address,bool)',
];

const marketIsDeployed = () => MARKETPLACE_CONTRACT_ADDRESS && MARKETPLACE_CONTRACT_ADDRESS.length === 42;

let marketplace;
let marketActiveFilter = 'all';

const collectionAddressFor = (kind) => (kind === 'community' ? COMMUNITY_MINT_CONTRACT_ADDRESS : COLLECTIBLES_CONTRACT_ADDRESS);
const kindOf = (nftAddress) =>
  COMMUNITY_MINT_CONTRACT_ADDRESS && nftAddress.toLowerCase() === COMMUNITY_MINT_CONTRACT_ADDRESS.toLowerCase()
    ? 'community'
    : 'collectibles';

function ensureMarketplaceContract() {
  if (!signer || !marketIsDeployed()) return null;
  if (!marketplace) marketplace = new ethers.Contract(MARKETPLACE_CONTRACT_ADDRESS, MARKETPLACE_ABI, signer);
  return marketplace;
}

async function listNft() {
  const kind = document.getElementById('marketCollection').value;
  const tokenId = document.getElementById('marketTokenId').value;
  const amountRaw = document.getElementById('marketAmount').value || '1';
  const priceRaw = document.getElementById('marketPrice').value;

  if (tokenId === '' || priceRaw === '' || Number(priceRaw) <= 0) {
    return alert('Enter a token ID and a price greater than 0.');
  }

  const nftAddress = collectionAddressFor(kind);
  if (!nftAddress) {
    return alert(`${kind === 'community' ? 'SDOGECommunityMint' : 'SDOGECollectibles'} isn't deployed yet either.`);
  }

  const priceWei = ethers.parseEther(priceRaw); // native USDC, 18 decimals - same convention as staking.js/nft.js
  const market = ensureMarketplaceContract();

  try {
    if (kind === 'community') {
      const nft = new ethers.Contract(nftAddress, ERC721_MIN_ABI, signer);
      const alreadyApproved =
        (await nft.getApproved(tokenId)).toLowerCase() === MARKETPLACE_CONTRACT_ADDRESS.toLowerCase() ||
        (await nft.isApprovedForAll(userAddress, MARKETPLACE_CONTRACT_ADDRESS));
      if (!alreadyApproved) {
        const tx = await nft.approve(MARKETPLACE_CONTRACT_ADDRESS, tokenId);
        await tx.wait();
      }
      const tx2 = await market.listERC721(nftAddress, tokenId, priceWei);
      await tx2.wait();
    } else {
      const nft = new ethers.Contract(nftAddress, ERC1155_MIN_ABI, signer);
      const alreadyApproved = await nft.isApprovedForAll(userAddress, MARKETPLACE_CONTRACT_ADDRESS);
      if (!alreadyApproved) {
        const tx = await nft.setApprovalForAll(MARKETPLACE_CONTRACT_ADDRESS, true);
        await tx.wait();
      }
      const tx2 = await market.listERC1155(nftAddress, tokenId, amountRaw, priceWei);
      await tx2.wait();
    }
    document.getElementById('marketTokenId').value = '';
    document.getElementById('marketPrice').value = '';
    await loadListings();
  } catch (err) {
    console.error(err);
    alert('Listing failed - see console for details.');
  }
}

async function buyListing(listingId, amount, pricePerUnitWei) {
  if (!userAddress) {
    const ok = await connectWallet();
    if (!ok) return;
  }
  const market = ensureMarketplaceContract();
  if (!market) return;

  try {
    const totalValue = pricePerUnitWei * BigInt(amount);
    const tx = await market.buy(listingId, amount, { value: totalValue });
    await tx.wait();
    await loadListings();
  } catch (err) {
    console.error(err);
    alert('Purchase failed - see console for details.');
  }
}

function listingRowHtml(listing, id) {
  const kind = kindOf(listing.nftContract);
  const priceDisplay = fmt(ethers.formatEther(listing.pricePerUnit));
  const label = kind === 'community' ? 'Community Art' : 'Collectibles';
  return `
    <div class="stake-row" data-market-kind="${kind}">
      <div>
        <div class="meta-row__label">${label} &middot; Token #${listing.tokenId}</div>
        <div class="meta-row__value">${fmt(listing.amount)} available &middot; ${priceDisplay} USDC each</div>
      </div>
      <button class="btn btn--primary btn--small" data-buy-listing="${id}" data-price="${listing.pricePerUnit}">Buy</button>
    </div>`;
}

async function loadListings() {
  const container = document.getElementById('marketListings');
  if (!container || !marketIsDeployed()) return; // keep the static "not deployed yet" message

  try {
    const ro = provider || new ethers.BrowserProvider(window.ethereum);
    const roMarket = new ethers.Contract(MARKETPLACE_CONTRACT_ADDRESS, MARKETPLACE_ABI, ro);
    const count = Number(await roMarket.nextListingId());

    const rows = [];
    for (let id = 1; id < count; id++) {
      const listing = await roMarket.getListing(id);
      if (!listing.active) continue;
      const kind = kindOf(listing.nftContract);
      if (marketActiveFilter !== 'all' && marketActiveFilter !== kind) continue;
      rows.push(listingRowHtml(listing, id));
    }
    container.innerHTML = rows.length ? rows.join('') : '<p class="empty-state">No active listings match this filter.</p>';

    container.querySelectorAll('[data-buy-listing]').forEach((btn) => {
      btn.addEventListener('click', () => buyListing(Number(btn.dataset.buyListing), 1, BigInt(btn.dataset.price)));
    });
  } catch (err) {
    console.error('Could not load listings, leaving the placeholder up:', err);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const collectionSelect = document.getElementById('marketCollection');
  const amountField = document.getElementById('marketAmountField');
  const listBtn = document.getElementById('marketListBtn');

  collectionSelect?.addEventListener('change', () => {
    amountField.style.display = collectionSelect.value === 'collectibles' ? 'block' : 'none';
  });

  listBtn?.addEventListener('click', async () => {
    if (!userAddress) {
      await connectWallet();
    }
    listBtn.textContent = marketIsDeployed() ? 'Approve & List' : 'Listing not live yet';
    if (marketIsDeployed() && userAddress) await listNft();
  });

  document.querySelectorAll('#marketFilterTabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#marketFilterTabs .tab').forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      marketActiveFilter = tab.dataset.marketFilter;
      loadListings();
    });
  });

  loadListings();
});
