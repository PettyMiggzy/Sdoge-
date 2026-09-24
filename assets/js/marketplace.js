// $SDOGE NFT marketplace UI: resale of SDOGE Collectibles designs, SDOGE Community Art and
// creators' own SDOGE Studio collections. Needs arc.js, wallet.js and nft.js (for ROSTER and the
// collectibles address) loaded first; it shares their globals and must not redeclare them.
//
// Safety rules this file follows (from the audit):
// - The marketplace is checked to be bound to this site's Studio and Collectibles, and only
//   listings from those are shown: Collectibles by exact address, ERC-721s only if the Studio's
//   registry says it made them.
// - Every row shows the collection and seller. Creator collections are labelled Verified or
//   "unverified creator collection"; their names are escaped, and nothing a seller controls (a
//   token URI, an image) is ever rendered into the page.
// - Prices are USDC with at most 6 decimals and at least 0.01, matching the contract.
// - Before a buy, the listing is re-read; a price change or a sold-out listing stops it.
// - Listing moves the NFT into escrow, so ownership is checked first and the user confirms.
const MARKETPLACE_CONTRACT_ADDRESS = SDOGE_CONTRACTS.marketplace;
const MARKET_STUDIO_ADDRESS = SDOGE_CONTRACTS.studio;

const LISTING_TUPLE =
  'tuple(address seller, address nftContract, uint8 standard, uint16 feeBps, bool active, uint16 royaltyBps, uint256 tokenId, uint256 amount, uint256 pricePerUnit)';
const MARKETPLACE_ABI = [
  'function listERC721(address nftContract, uint256 tokenId, uint256 pricePerUnit) returns (uint256 listingId)',
  'function listERC1155(address nftContract, uint256 tokenId, uint256 amount, uint256 pricePerUnit) returns (uint256 listingId)',
  'function updatePrice(uint256 listingId, uint256 newPricePerUnit)',
  'function cancelListing(uint256 listingId)',
  'function buy(uint256 listingId, uint256 amount) payable',
  'function withdrawProceeds(address to) returns (uint256 amount)',
  `function getListing(uint256 listingId) view returns (${LISTING_TUPLE})`,
  `function getActiveListings(uint256 offset, uint256 limit) view returns (uint256[] ids, ${LISTING_TUPLE}[] items)`,
  'function activeListingCount() view returns (uint256)',
  'function proceeds(address) view returns (uint256)',
  'function feeBps() view returns (uint256)',
  'function rewardsPool() view returns (address)',
  'function paused() view returns (bool)',
  'function studio() view returns (address)',
  'function collectibles() view returns (address)',
];
const MARKET_STUDIO_ABI = [
  'function isCollection(address) view returns (bool)',
  'function verified(address) view returns (bool)',
  'function communityCollection() view returns (address)',
];
const MARKET_ERC721_ABI = [
  'function name() view returns (string)',
  'function ownerOf(uint256) view returns (address)',
  'function getApproved(uint256) view returns (address)',
  'function isApprovedForAll(address,address) view returns (bool)',
  'function approve(address,uint256)',
];
const MARKET_ERC1155_ABI = [
  'function balanceOf(address,uint256) view returns (uint256)',
  'function isApprovedForAll(address,address) view returns (bool)',
  'function setApprovalForAll(address,bool)',
];

const MARKET_PAGE_SIZE = 50;
const MARKET_MAX_ROWS = 200;
const MIN_LISTING_PRICE = 10n ** 16n; // 0.01 USDC

const marketIsDeployed = () =>
  isAddressSet(MARKETPLACE_CONTRACT_ADDRESS) && isAddressSet(MARKET_STUDIO_ADDRESS) && collectiblesDeployed();

const marketRead = marketIsDeployed() ? new ethers.Contract(MARKETPLACE_CONTRACT_ADDRESS, MARKETPLACE_ABI, arcReadProvider) : null;
const marketStudioRead = marketIsDeployed() ? new ethers.Contract(MARKET_STUDIO_ADDRESS, MARKET_STUDIO_ABI, arcReadProvider) : null;
let marketWrite;
let marketActiveFilter = 'all';
let marketReady = false; // true once the marketplace was checked to be bound to our contracts
let marketPaused = false;
let marketFeeBps = 0n;
let marketCommunity = ''; // the Studio's Community Art collection
let marketListingsById = new Map(); // listing id (string) -> listing as shown
const collectionInfo = new Map(); // address (lowercase) -> { kind, name, verified }

const listingFields = (l) => ({
  seller: l.seller,
  nftContract: l.nftContract,
  standard: Number(l.standard),
  feeBps: Number(l.feeBps),
  active: l.active,
  royaltyBps: Number(l.royaltyBps),
  tokenId: l.tokenId,
  amount: l.amount,
  pricePerUnit: l.pricePerUnit,
});

const pct = (bps) => `${(Number(bps) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

function marketSigner() {
  if (!marketWrite) marketWrite = new ethers.Contract(MARKETPLACE_CONTRACT_ADDRESS, MARKETPLACE_ABI, signer);
  return marketWrite;
}

async function checkMarketplace() {
  if (!(await hasCodeOnArc(MARKETPLACE_CONTRACT_ADDRESS))) throw new Error(`no marketplace at ${MARKETPLACE_CONTRACT_ADDRESS} on Arc`);
  const [studio, collectibles, paused, feeBps, pool, community] = await Promise.all([
    marketRead.studio(),
    marketRead.collectibles(),
    marketRead.paused(),
    marketRead.feeBps(),
    marketRead.rewardsPool(),
    marketStudioRead.communityCollection(),
  ]);
  if (!sameAddr(studio, MARKET_STUDIO_ADDRESS) || !sameAddr(collectibles, COLLECTIBLES_CONTRACT_ADDRESS)) {
    throw new Error("the marketplace is bound to different contracts than this site's");
  }
  marketPaused = paused;
  marketFeeBps = feeBps;
  marketCommunity = community;
  const feeTo = pool === ethers.ZeroAddress ? 'goes to the treasury (staking not connected yet)' : 'goes to the $SDOGE staking reward pool';
  setMarketStatus(
    `Fee: ${pct(feeBps)} of each sale ${feeTo}.` +
      (paused ? ' The marketplace is paused: buying and new listings are off; you can still cancel and withdraw.' : '')
  );
  marketReady = true;
}

function setMarketStatus(text) {
  const el = document.getElementById('marketStatus');
  if (el) el.textContent = text;
}

// What a listing's collection is: 'collectibles', 'community', 'creator', or null (never shown).
async function describeCollection(address) {
  const key = address.toLowerCase();
  if (collectionInfo.has(key)) return collectionInfo.get(key);
  let info = { kind: null };
  if (sameAddr(address, COLLECTIBLES_CONTRACT_ADDRESS)) info = { kind: 'collectibles', name: 'SDOGE Collectibles', verified: true };
  else if (sameAddr(address, marketCommunity)) info = { kind: 'community', name: 'SDOGE Community Art', verified: true };
  else if (await marketStudioRead.isCollection(address)) {
    const nft = new ethers.Contract(address, MARKET_ERC721_ABI, arcReadProvider);
    const [name, verified] = await Promise.all([nft.name(), marketStudioRead.verified(address)]);
    info = { kind: 'creator', name, verified };
  }
  collectionInfo.set(key, info);
  return info;
}

function itemLabel(l, info) {
  if (info.kind === 'collectibles') {
    const design = ROSTER.find((d) => BigInt(d.designId) === l.tokenId);
    return design ? `${design.name} (Collectibles design #${l.tokenId})` : `Collectibles design #${l.tokenId}`;
  }
  if (info.kind === 'community') return `Community Art #${l.tokenId}`;
  return `${info.name} #${l.tokenId}`;
}

function listingRowHtml(l, info) {
  const mine = userAddress && sameAddr(l.seller, userAddress);
  const multi = l.amount > 1n;
  const link = `${ARC_EXPLORER_URL}/token/${l.nftContract}/instance/${l.tokenId}`;
  const badge =
    info.kind === 'creator'
      ? info.verified
        ? ' <span class="stake-row__tag">Verified</span>'
        : ' <span class="stake-row__tag stake-row__tag--warn">Unverified creator collection</span>'
      : '';
  const actions = mine
    ? `<button class="chip-btn" data-market-reprice="${l.id}">Change price</button>
       <button class="chip-btn" data-market-cancel="${l.id}">Cancel</button>`
    : `${multi ? `<input class="market-qty" type="number" min="1" max="${l.amount}" step="1" value="1" data-market-qty="${l.id}" aria-label="Quantity" />` : ''}
       <button class="btn btn--primary btn--small" data-market-buy="${l.id}" ${marketPaused ? 'disabled' : ''}>Buy</button>`;
  return `
    <div class="stake-row" data-market-kind="${info.kind}">
      <div>
        <div class="meta-row__label">${escHtml(itemLabel(l, info))}${badge} &middot; <a href="${link}" target="_blank" rel="noopener">view</a></div>
        <div class="meta-row__value">${usdcText(l.pricePerUnit)} USDC${multi ? ` each &middot; ${fmt(l.amount)} left` : ''}</div>
        <div class="meta-row__label">Seller ${mine ? 'you' : shortAddr(l.seller)} &middot; contract ${shortAddr(l.nftContract)}${
          l.royaltyBps > 0 ? ` &middot; creator royalty up to ${pct(l.royaltyBps)}` : ''
        }</div>
      </div>
      <div class="market-actions">${actions}</div>
    </div>`;
}

async function fetchActiveListings() {
  const total = Number(await marketRead.activeListingCount());
  const byId = new Map();
  for (let offset = 0; offset < Math.min(total, MARKET_MAX_ROWS); offset += MARKET_PAGE_SIZE) {
    const [ids, items] = await marketRead.getActiveListings(offset, MARKET_PAGE_SIZE);
    ids.forEach((id, i) => byId.set(String(id), { id, ...listingFields(items[i]) }));
  }
  return { rows: [...byId.values()], total };
}

async function loadListings() {
  const container = document.getElementById('marketListings');
  if (!container || !marketIsDeployed()) return;
  try {
    if (!marketReady) await checkMarketplace();
    const { rows, total } = await fetchActiveListings();
    const infos = await Promise.all(rows.map((l) => describeCollection(l.nftContract)));
    const proceedsWei = userAddress ? await marketRead.proceeds(userAddress) : 0n;
    marketListingsById = new Map(rows.map((l) => [String(l.id), l]));

    const html = [];
    rows.forEach((l, i) => {
      const info = infos[i];
      if (!info.kind) return; // never show anything outside the SDOGE collections
      const mine = userAddress && sameAddr(l.seller, userAddress);
      const show =
        marketActiveFilter === 'all' ||
        (marketActiveFilter === 'mine' && mine) ||
        (marketActiveFilter === 'creators' && info.kind === 'creator') ||
        marketActiveFilter === info.kind;
      if (show) html.push(listingRowHtml(l, info));
    });
    if (proceedsWei > 0n) {
      html.unshift(`
        <div class="stake-row">
          <span>Sale proceeds waiting for you: ${usdcText(proceedsWei)} USDC</span>
          <button class="chip-btn" data-market-withdraw="1">Withdraw</button>
        </div>`);
    }
    if (total > MARKET_MAX_ROWS) html.push(`<p class="empty-state">Showing the first ${MARKET_MAX_ROWS} of ${fmt(total)} listings.</p>`);
    const empty =
      marketActiveFilter === 'mine'
        ? userAddress
          ? 'You have no active listings.'
          : 'Connect your wallet to see your listings.'
        : 'No active listings here yet.';
    container.innerHTML = html.length ? html.join('') : `<p class="empty-state">${empty}</p>`;

    container.querySelectorAll('[data-market-buy]').forEach((b) => b.addEventListener('click', () => buyListing(b.dataset.marketBuy)));
    container.querySelectorAll('[data-market-cancel]').forEach((b) => b.addEventListener('click', () => cancelMarketListing(b.dataset.marketCancel)));
    container.querySelectorAll('[data-market-reprice]').forEach((b) => b.addEventListener('click', () => repriceListing(b.dataset.marketReprice)));
    container.querySelectorAll('[data-market-withdraw]').forEach((b) => b.addEventListener('click', withdrawMarketProceeds));
  } catch (err) {
    console.error('Could not load the marketplace:', err);
    marketReady = false;
    container.innerHTML = '<p class="empty-state">Marketplace unavailable right now.</p>';
  }
  updateListButton();
}

function updateListButton() {
  const btn = document.getElementById('marketListBtn');
  if (!btn) return;
  const [text, enabled] = !marketIsDeployed()
    ? ['Listing not live yet', false]
    : !marketReady
      ? ['Marketplace unavailable', false]
      : marketPaused
        ? ['Listing paused', false]
        : ['Approve & List', true];
  btn.textContent = text;
  btn.disabled = !enabled;
}

async function buyListing(id) {
  if (!(await walletReady())) return;
  const shown = marketListingsById.get(String(id));
  const qtyInput = document.querySelector(`[data-market-qty="${id}"]`);
  const qtyRaw = qtyInput ? qtyInput.value.trim() : '1';
  if (!/^\d+$/.test(qtyRaw) || BigInt(qtyRaw) < 1n) {
    alert('Enter how many copies to buy (a whole number).');
    return;
  }
  const qty = BigInt(qtyRaw);
  let fresh;
  try {
    fresh = listingFields(await marketRead.getListing(id));
  } catch (err) {
    console.error(err);
    alert(`Could not read the listing: ${reason(err)}`);
    return;
  }
  if (!fresh.active || fresh.amount === 0n) {
    await loadListings();
    alert('This listing just sold out or was cancelled.');
    return;
  }
  if (!shown || fresh.pricePerUnit !== shown.pricePerUnit) {
    await loadListings();
    alert(`The price just changed to ${usdcText(fresh.pricePerUnit)} USDC each. Check it, then buy again.`);
    return;
  }
  if (qty > fresh.amount) {
    alert(`Only ${fmt(fresh.amount)} left in this listing.`);
    return;
  }
  try {
    await (await marketSigner().buy(id, qty, arcTx({ value: fresh.pricePerUnit * qty }))).wait();
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`Purchase failed: ${reason(err)}`);
  }
  await loadListings();
}

// Which contract the form is about: [address, 'erc721' | 'erc1155'] or null.
async function listingTarget(kind) {
  if (kind === 'collectibles') return [COLLECTIBLES_CONTRACT_ADDRESS, 'erc1155'];
  if (kind === 'community') return [marketCommunity, 'erc721'];
  const raw = document.getElementById('marketCollectionAddress')?.value.trim() ?? '';
  if (!ethers.isAddress(raw) || !(await marketStudioRead.isCollection(raw))) {
    alert("That address isn't a SDOGE Studio collection.");
    return null;
  }
  return [ethers.getAddress(raw), 'erc721'];
}

async function listNft() {
  const kind = document.getElementById('marketCollection').value;
  const tokenIdRaw = document.getElementById('marketTokenId').value.trim();
  const amountRaw = kind === 'collectibles' ? document.getElementById('marketAmount').value.trim() || '1' : '1';
  const price = parseUsdc(document.getElementById('marketPrice').value);
  if (!/^\d+$/.test(tokenIdRaw)) return alert('Enter the token ID (a whole number).');
  if (!/^\d+$/.test(amountRaw) || BigInt(amountRaw) < 1n) return alert('Enter how many copies to list (a whole number, at least 1).');
  if (price === null || price < MIN_LISTING_PRICE) return alert('Enter a price of at least 0.01 USDC, with up to 6 decimals.');
  if (!marketReady) return alert('The marketplace is unavailable right now.');
  if (marketPaused) return alert('The marketplace is paused, so new listings are off for now.');
  if (!(await walletReady())) return;

  const tokenId = BigInt(tokenIdRaw);
  const amount = BigInt(amountRaw);
  const market = marketSigner();
  try {
    const target = await listingTarget(kind);
    if (!target) return;
    const [nftAddress, standard] = target;
    const info = await describeCollection(nftAddress);
    const label = itemLabel({ tokenId }, info);
    if (standard === 'erc721') {
      const nft = new ethers.Contract(nftAddress, MARKET_ERC721_ABI, arcReadProvider);
      let owner;
      try {
        owner = await nft.ownerOf(tokenId);
      } catch {
        return alert(`${label} doesn't exist.`);
      }
      if (!sameAddr(owner, userAddress)) return alert(`${label} isn't in your wallet.`);
    } else {
      const nft = new ethers.Contract(nftAddress, MARKET_ERC1155_ABI, arcReadProvider);
      const have = await nft.balanceOf(userAddress, tokenId);
      if (have < amount) return alert(`You have ${fmt(have)} of ${label}, fewer than ${fmt(amount)}.`);
    }
    const each = amount > 1n ? ' each' : '';
    const royalty = info.kind === 'creator' ? " plus the creator's royalty (up to 10%, shown on the listing)" : '';
    if (!confirm(
      `List ${amount > 1n ? `${fmt(amount)} x ` : ''}${label} for ${usdcText(price)} USDC${each}?\n\n` +
        'It moves into the marketplace contract until it sells or you cancel (cancelling returns it).\n' +
        `The ${pct(marketFeeBps)} marketplace fee${royalty} comes off the sale price.`
    )) return;

    if (standard === 'erc721') {
      const nft = new ethers.Contract(nftAddress, MARKET_ERC721_ABI, signer);
      const approved =
        sameAddr(await nft.getApproved(tokenId), MARKETPLACE_CONTRACT_ADDRESS) ||
        (await nft.isApprovedForAll(userAddress, MARKETPLACE_CONTRACT_ADDRESS));
      if (!approved) await (await nft.approve(MARKETPLACE_CONTRACT_ADDRESS, tokenId, arcTx())).wait();
      await (await market.listERC721(nftAddress, tokenId, price, arcTx())).wait();
    } else {
      const nft = new ethers.Contract(nftAddress, MARKET_ERC1155_ABI, signer);
      if (!(await nft.isApprovedForAll(userAddress, MARKETPLACE_CONTRACT_ADDRESS))) {
        await (await nft.setApprovalForAll(MARKETPLACE_CONTRACT_ADDRESS, true, arcTx())).wait();
      }
      await (await market.listERC1155(nftAddress, tokenId, amount, price, arcTx())).wait();
    }
    document.getElementById('marketTokenId').value = '';
    document.getElementById('marketPrice').value = '';
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`Listing failed: ${reason(err)}`);
  }
  await loadListings();
}

async function repriceListing(id) {
  if (!(await walletReady())) return;
  const raw = prompt('New price per copy, in USDC (at least 0.01, up to 6 decimals):');
  if (raw === null) return;
  const price = parseUsdc(raw);
  if (price === null || price < MIN_LISTING_PRICE) return alert('Enter a price of at least 0.01 USDC, with up to 6 decimals.');
  try {
    await (await marketSigner().updatePrice(id, price, arcTx())).wait();
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`Price change failed: ${reason(err)}`);
  }
  await loadListings();
}

async function cancelMarketListing(id) {
  if (!(await walletReady())) return;
  if (!confirm('Cancel this listing? The NFT goes straight back to your wallet.')) return;
  try {
    await (await marketSigner().cancelListing(id, arcTx())).wait();
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`Cancel failed: ${reason(err)}`);
  }
  await loadListings();
}

async function withdrawMarketProceeds() {
  if (!(await walletReady())) return;
  try {
    await (await marketSigner().withdrawProceeds(userAddress, arcTx())).wait();
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`Withdraw failed: ${reason(err)}`);
  }
  await loadListings();
}

document.addEventListener('DOMContentLoaded', () => {
  const collectionSelect = document.getElementById('marketCollection');
  const amountField = document.getElementById('marketAmountField');
  const addressField = document.getElementById('marketCollectionAddressField');
  collectionSelect?.addEventListener('change', () => {
    amountField.style.display = collectionSelect.value === 'collectibles' ? 'block' : 'none';
    if (addressField) addressField.style.display = collectionSelect.value === 'creator' ? 'block' : 'none';
  });
  document.getElementById('marketListBtn')?.addEventListener('click', listNft);

  document.querySelectorAll('#marketFilterTabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#marketFilterTabs .tab').forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      marketActiveFilter = tab.dataset.marketFilter;
      loadListings();
    });
  });

  document.addEventListener('sdoge:wallet-connected', loadListings);
  updateListButton();
  loadListings();
});
