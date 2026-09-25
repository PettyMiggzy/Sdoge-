// $SDOGE NFT marketplace UI: resale of SDOGE Collectibles designs, SDOGE Community Art and
// creators' own SDOGE Studio collections. Needs arc.js, wallet.js and nft.js (for ROSTER and the
// collectibles address) loaded first; it shares their globals and must not redeclare them.
//
// Safety rules this file follows (from the audits):
// - The marketplace is checked to be bound to this site's Studio and Collectibles, and only
//   listings from those are shown: Collectibles by exact address, ERC-721s only if the Studio's
//   registry says it made them.
// - Every row shows the collection, seller, fee and royalty. Creator collections are labelled
//   Verified or "unverified creator collection"; their names are escaped, and nothing a seller
//   controls (a token URI, an image) is ever rendered into the page.
// - Every listing is reachable: Mine, Collectibles, Community Art and a single collection read the
//   contract's per-seller and per-collection indexes, and every tab pages to the end ("Load more"),
//   so nobody can push a listing out of view by listing more.
// - Reads are sequential and cached per collection, and one failed read never blanks the panel.
// - Prices are USDC with at most 6 decimals and at least 0.01, matching the contract.
// - Listing and repricing re-read the fee and royalty, quote them with the net amount, and pass
//   them as limits, so a rate raised in between makes the transaction revert instead.
// - Before a buy, the listing is re-read; a price change or a sold-out listing stops it.
const MARKETPLACE_CONTRACT_ADDRESS = SDOGE_CONTRACTS.marketplace;
const MARKET_STUDIO_ADDRESS = SDOGE_CONTRACTS.studio;

const LISTING_TUPLE =
  'tuple(address seller, address nftContract, uint8 standard, uint16 feeBps, bool active, uint16 royaltyBps, uint256 tokenId, uint256 amount, uint256 pricePerUnit)';
const LISTING_PAGE = `view returns (uint256[] ids, ${LISTING_TUPLE}[] items)`;
const MARKETPLACE_ABI = [
  'function listERC721(address nftContract, uint256 tokenId, uint256 pricePerUnit, uint256 maxFeeBps, uint256 maxRoyaltyBps) returns (uint256 listingId)',
  'function listERC1155(address nftContract, uint256 tokenId, uint256 amount, uint256 pricePerUnit, uint256 maxFeeBps) returns (uint256 listingId)',
  'function updatePrice(uint256 listingId, uint256 newPricePerUnit, uint256 maxFeeBps, uint256 maxRoyaltyBps)',
  'function cancelListing(uint256 listingId)',
  'function buy(uint256 listingId, uint256 amount) payable',
  'function withdrawProceeds(address to) returns (uint256 amount)',
  `function getListing(uint256 listingId) view returns (${LISTING_TUPLE})`,
  `function getActiveListings(uint256 offset, uint256 limit) ${LISTING_PAGE}`,
  `function getActiveListingsBySeller(address seller, uint256 offset, uint256 limit) ${LISTING_PAGE}`,
  `function getActiveListingsByCollection(address nftContract, uint256 offset, uint256 limit) ${LISTING_PAGE}`,
  'function activeListingCount() view returns (uint256)',
  'function activeListingCountBySeller(address seller) view returns (uint256)',
  'function activeListingCountByCollection(address nftContract) view returns (uint256)',
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
  'function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address receiver, uint256 amount)',
];
const MARKET_ERC1155_ABI = [
  'function balanceOf(address,uint256) view returns (uint256)',
  'function isApprovedForAll(address,address) view returns (bool)',
  'function setApprovalForAll(address,bool)',
];

const MARKET_PAGE_SIZE = 50;
const MARKET_MINE_MAX_PAGES = 40; // Mine reads all of a seller's listings (up to 2,000)
const MIN_LISTING_PRICE = 10n ** 16n; // 0.01 USDC
const MAX_ROYALTY_BPS = 1000n; // the marketplace never pays more, whatever a collection reports

const marketIsDeployed = () =>
  isAddressSet(MARKETPLACE_CONTRACT_ADDRESS) && isAddressSet(MARKET_STUDIO_ADDRESS) && collectiblesDeployed();

const marketRead = marketIsDeployed() ? new ethers.Contract(MARKETPLACE_CONTRACT_ADDRESS, MARKETPLACE_ABI, arcReadProvider) : null;
const marketStudioRead = marketIsDeployed() ? new ethers.Contract(MARKET_STUDIO_ADDRESS, MARKET_STUDIO_ABI, arcReadProvider) : null;
let marketWrite;
let marketActiveFilter = 'all';
let marketCollectionFilter = ''; // set by ?collection=0x...: one collection's listings
let marketReady = false; // true once the marketplace was checked to be bound to our contracts
let marketPaused = false;
let marketCommunity = ''; // the Studio's Community Art collection
let marketListingsById = new Map(); // listing id (string) -> listing as shown
let marketView = null; // what the current tab has read so far
const collectionInfo = new Map(); // address (lowercase) -> Promise<{ kind, name, verified }>

const listingFields = (l) => ({
  seller: l.seller,
  nftContract: l.nftContract,
  standard: Number(l.standard),
  feeBps: BigInt(l.feeBps),
  active: l.active,
  royaltyBps: BigInt(l.royaltyBps),
  tokenId: l.tokenId,
  amount: l.amount,
  pricePerUnit: l.pricePerUnit,
});

const pct = (bps) => `${(Number(bps) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
const netOf = (price, feeBps, royaltyBps) => (price * (10000n - feeBps - royaltyBps)) / 10000n;

function marketSigner() {
  if (!marketWrite) marketWrite = new ethers.Contract(MARKETPLACE_CONTRACT_ADDRESS, MARKETPLACE_ABI, signer);
  return marketWrite;
}

async function checkMarketplace() {
  if (!(await hasCodeOnArc(MARKETPLACE_CONTRACT_ADDRESS))) throw new Error(`no marketplace at ${MARKETPLACE_CONTRACT_ADDRESS} on Arc`);
  const studio = await marketRead.studio();
  const collectibles = await marketRead.collectibles();
  if (!sameAddr(studio, MARKET_STUDIO_ADDRESS) || !sameAddr(collectibles, COLLECTIBLES_CONTRACT_ADDRESS)) {
    throw new Error("the marketplace is bound to different contracts than this site's");
  }
  const paused = await marketRead.paused();
  const feeBps = await marketRead.feeBps();
  const pool = await marketRead.rewardsPool();
  marketCommunity = await marketStudioRead.communityCollection();
  marketPaused = paused;
  const feeTo =
    pool === ethers.ZeroAddress
      ? 'goes to the treasury (staking not connected yet)'
      : sameAddr(pool, SDOGE_CONTRACTS.staking)
        ? 'goes to the $SDOGE staking reward pool'
        : `goes to ${pool}, which is not this site's staking contract`;
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

// What a collection is: 'collectibles', 'community', 'creator', or null (never shown). One lookup
// in flight per address; a failed lookup is forgotten so the next load retries it.
function describeCollection(address) {
  const key = address.toLowerCase();
  if (!collectionInfo.has(key)) {
    const lookup = lookupCollection(address);
    collectionInfo.set(key, lookup);
    lookup.catch(() => collectionInfo.delete(key));
  }
  return collectionInfo.get(key);
}

async function lookupCollection(address) {
  if (sameAddr(address, COLLECTIBLES_CONTRACT_ADDRESS)) return { kind: 'collectibles', name: 'SDOGE Collectibles', verified: true };
  if (sameAddr(address, marketCommunity)) return { kind: 'community', name: 'SDOGE Community Art', verified: true };
  if (!(await marketStudioRead.isCollection(address))) return { kind: null };
  const name = await new ethers.Contract(address, MARKET_ERC721_ABI, arcReadProvider).name();
  const verified = await marketStudioRead.verified(address);
  return { kind: 'creator', name, verified };
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
  const more =
    info.kind === 'creator' && !marketCollectionFilter
      ? ` &middot; <a href="?collection=${l.nftContract}#marketplace">more from this collection</a>`
      : '';
  const actions = mine
    ? `<button class="chip-btn" data-market-reprice="${l.id}">Change price</button>
       <button class="chip-btn" data-market-cancel="${l.id}">Cancel</button>`
    : `${multi ? `<input class="market-qty" type="number" min="1" max="${l.amount}" step="1" value="1" data-market-qty="${l.id}" aria-label="Quantity" />` : ''}
       <button class="btn btn--primary btn--small" data-market-buy="${l.id}" ${marketPaused ? 'disabled' : ''}>Buy</button>`;
  return `
    <div class="stake-row" data-market-kind="${info.kind}">
      <div>
        <div class="meta-row__label">${escHtml(itemLabel(l, info))}${badge} &middot; <a href="${link}" target="_blank" rel="noopener">view</a>${more}</div>
        <div class="meta-row__value">${usdcText(l.pricePerUnit)} USDC${multi ? ` each &middot; ${fmt(l.amount)} left` : ''}</div>
        <div class="meta-row__label">Seller ${mine ? 'you' : shortAddr(l.seller)} &middot; contract ${shortAddr(l.nftContract)} &middot; fee up to ${pct(l.feeBps)}${
          l.royaltyBps > 0n ? ` &middot; creator royalty up to ${pct(l.royaltyBps)}` : ''
        }</div>
      </div>
      <div class="market-actions">${actions}</div>
    </div>`;
}

// Where the current tab's listings come from: the whole list, or one of the contract's indexes.
function marketSource() {
  if (marketCollectionFilter) {
    return { key: `c:${marketCollectionFilter}`, read: (o, n, tag) => marketRead.getActiveListingsByCollection(marketCollectionFilter, o, n, tag) };
  }
  if (marketActiveFilter === 'mine') {
    return { key: `s:${userAddress}`, all: true, read: (o, n, tag) => marketRead.getActiveListingsBySeller(userAddress, o, n, tag) };
  }
  if (marketActiveFilter === 'collectibles') {
    return { key: 'c:collectibles', read: (o, n, tag) => marketRead.getActiveListingsByCollection(COLLECTIBLES_CONTRACT_ADDRESS, o, n, tag) };
  }
  if (marketActiveFilter === 'community') {
    return { key: 'c:community', read: (o, n, tag) => marketRead.getActiveListingsByCollection(marketCommunity, o, n, tag) };
  }
  return { key: 'all', read: (o, n, tag) => marketRead.getActiveListings(o, n, tag) }; // All and Creators
}

// Reads the next page (or, for Mine, every page) into marketView. Pages of one load are read at
// the same block, so a listing ending mid-read can't shift another one out of view. (The block
// number is asked for directly: ethers' getBlockNumber() can answer from a 250 ms cache, which
// right after a transaction would read the listings from before it.)
async function readMoreListings() {
  const view = marketView;
  const blockTag = Number(await arcReadProvider.send('eth_blockNumber', []));
  for (let page = 0; page < (view.source.all ? MARKET_MINE_MAX_PAGES : 1) && !view.done; page++) {
    const [ids, items] = await view.source.read(view.offset, MARKET_PAGE_SIZE, { blockTag });
    ids.forEach((id, i) => {
      if (!view.byId.has(String(id))) view.byId.set(String(id), { id, ...listingFields(items[i]) });
    });
    view.offset += ids.length;
    if (ids.length < MARKET_PAGE_SIZE) view.done = true;
  }
}

async function loadListings() {
  const container = document.getElementById('marketListings');
  if (!container || !marketIsDeployed()) return;
  try {
    if (!marketReady) await arcRetry(checkMarketplace);
    if (marketActiveFilter === 'mine' && !marketCollectionFilter && !userAddress) {
      marketView = null;
      marketListingsById = new Map();
      container.innerHTML = `${await proceedsRowHtml()}<p class="empty-state">Connect your wallet to see your listings.</p>`;
      bindMarketButtons(container);
      updateListButton();
      return;
    }
    const source = marketSource();
    marketView = { source, offset: 0, done: false, byId: new Map() };
    await arcRetry(readMoreListings);
    await renderListings();
  } catch (err) {
    console.error('Could not load the marketplace:', err);
    marketReady = false;
    container.innerHTML = '<p class="empty-state">Marketplace unavailable right now. Reload to try again.</p>';
  }
  updateListButton();
}

async function loadMoreListings() {
  if (!marketView || marketView.done) return;
  try {
    await arcRetry(readMoreListings);
    await renderListings();
  } catch (err) {
    console.error('Could not load more listings:', err);
    alert(`Could not load more listings: ${reason(err)}`);
  }
}

async function proceedsRowHtml() {
  if (!userAddress) return '';
  try {
    const proceedsWei = await marketRead.proceeds(userAddress);
    if (proceedsWei === 0n) return '';
    return `
      <div class="stake-row">
        <span>Sale proceeds waiting for you: ${usdcText(proceedsWei)} USDC</span>
        <button class="chip-btn" data-market-withdraw="1">Withdraw</button>
      </div>`;
  } catch (err) {
    console.error('Could not read your proceeds:', err);
    return '';
  }
}

async function renderListings() {
  const container = document.getElementById('marketListings');
  const rows = [...marketView.byId.values()];
  // Collection lookups: one at a time per new collection, cached; a failure only hides its rows.
  const infos = new Map();
  for (const l of rows) {
    const key = l.nftContract.toLowerCase();
    if (infos.has(key)) continue;
    try {
      infos.set(key, await describeCollection(l.nftContract));
    } catch (err) {
      console.error(`Could not check collection ${l.nftContract}:`, err);
      infos.set(key, null);
    }
  }
  marketListingsById = new Map(rows.map((l) => [String(l.id), l]));

  const html = [];
  let unchecked = 0;
  if (marketCollectionFilter) {
    const info = infos.get(marketCollectionFilter.toLowerCase()) || (await describeCollection(marketCollectionFilter).catch(() => null));
    const name = info?.kind ? escHtml(info.name) : shortAddr(marketCollectionFilter);
    html.push(`<p class="fine-print">Listings from ${name} (${shortAddr(marketCollectionFilter)}) &middot; <button class="chip-btn" data-market-all="1">Show all</button></p>`);
  }
  for (const l of rows) {
    const info = infos.get(l.nftContract.toLowerCase());
    if (info === null) {
      unchecked += 1;
      continue;
    }
    if (!info.kind) continue; // never show anything outside the SDOGE collections
    if (!marketCollectionFilter && marketActiveFilter === 'creators' && info.kind !== 'creator') continue;
    html.push(listingRowHtml(l, info));
  }
  const shown = html.length - (marketCollectionFilter ? 1 : 0);
  if (unchecked) html.push(`<p class="empty-state">${fmt(unchecked)} listing(s) couldn't be checked right now. Reload to try again.</p>`);
  if (!marketView.done) html.push('<button class="chip-btn" data-market-more="1">Load more</button>');
  if (!shown && marketView.done && !unchecked) {
    html.push(`<p class="empty-state">${marketActiveFilter === 'mine' && !marketCollectionFilter ? 'You have no active listings.' : 'No active listings here yet.'}</p>`);
  }
  container.innerHTML = (await proceedsRowHtml()) + html.join('');
  bindMarketButtons(container);
}

function bindMarketButtons(container) {
  container.querySelectorAll('[data-market-buy]').forEach((b) => b.addEventListener('click', () => buyListing(b.dataset.marketBuy)));
  container.querySelectorAll('[data-market-cancel]').forEach((b) => b.addEventListener('click', () => cancelMarketListing(b.dataset.marketCancel)));
  container.querySelectorAll('[data-market-reprice]').forEach((b) => b.addEventListener('click', () => repriceListing(b.dataset.marketReprice)));
  container.querySelectorAll('[data-market-withdraw]').forEach((b) => b.addEventListener('click', withdrawMarketProceeds));
  container.querySelectorAll('[data-market-more]').forEach((b) => b.addEventListener('click', loadMoreListings));
  container.querySelectorAll('[data-market-all]').forEach((b) =>
    b.addEventListener('click', () => {
      marketCollectionFilter = '';
      loadListings();
    })
  );
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

// The royalty rate the marketplace records for an ERC-721 when it's listed or repriced now.
async function royaltyBpsOf(nftAddress, tokenId) {
  const [receiver, amount] = await new ethers.Contract(nftAddress, MARKET_ERC721_ABI, arcReadProvider).royaltyInfo(tokenId, 10000n);
  if (receiver === ethers.ZeroAddress) return 0n;
  return amount > MAX_ROYALTY_BPS ? MAX_ROYALTY_BPS : amount;
}

// The fee and royalty a listing of this item gets right now, read fresh.
async function currentRates(nftAddress, standard, tokenId) {
  const feeBps = await marketRead.feeBps();
  const royaltyBps = standard === 'erc721' ? await royaltyBpsOf(nftAddress, tokenId) : 0n;
  return { feeBps, royaltyBps };
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
    const { feeBps, royaltyBps } = await currentRates(nftAddress, standard, tokenId);
    const each = amount > 1n ? ' each' : '';
    const royalty = royaltyBps > 0n ? ` + creator royalty ${pct(royaltyBps)}` : '';
    if (!confirm(
      `List ${amount > 1n ? `${fmt(amount)} x ` : ''}${label} for ${usdcText(price)} USDC${each}?\n\n` +
        'It moves into the marketplace contract until it sells or you cancel (cancelling returns it).\n' +
        `Marketplace fee ${pct(feeBps)}${royalty}: you receive ${usdcText(netOf(price, feeBps, royaltyBps))} USDC${each}. ` +
        'Neither rate can be higher on your listing than this.'
    )) return;

    if (standard === 'erc721') {
      const nft = new ethers.Contract(nftAddress, MARKET_ERC721_ABI, signer);
      const approved =
        sameAddr(await nft.getApproved(tokenId), MARKETPLACE_CONTRACT_ADDRESS) ||
        (await nft.isApprovedForAll(userAddress, MARKETPLACE_CONTRACT_ADDRESS));
      if (!approved) await (await nft.approve(MARKETPLACE_CONTRACT_ADDRESS, tokenId, arcTx())).wait();
      await (await market.listERC721(nftAddress, tokenId, price, feeBps, royaltyBps, arcTx())).wait();
    } else {
      const nft = new ethers.Contract(nftAddress, MARKET_ERC1155_ABI, signer);
      if (!(await nft.isApprovedForAll(userAddress, MARKETPLACE_CONTRACT_ADDRESS))) {
        await (await nft.setApprovalForAll(MARKETPLACE_CONTRACT_ADDRESS, true, arcTx())).wait();
      }
      await (await market.listERC1155(nftAddress, tokenId, amount, price, feeBps, arcTx())).wait();
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
  let current;
  try {
    current = listingFields(await marketRead.getListing(id));
  } catch (err) {
    console.error(err);
    return alert(`Could not read the listing: ${reason(err)}`);
  }
  if (!current.active) {
    await loadListings();
    return alert('This listing just sold out or was cancelled.');
  }
  const each = current.amount > 1n ? ' each' : '';
  const raw = prompt(`New price per copy, in USDC (now ${usdcText(current.pricePerUnit)}; at least 0.01, up to 6 decimals):`);
  if (raw === null) return;
  const price = parseUsdc(raw);
  if (price === null || price < MIN_LISTING_PRICE) return alert('Enter a price of at least 0.01 USDC, with up to 6 decimals.');
  try {
    const standard = current.standard === 0 ? 'erc721' : 'erc1155';
    const { feeBps, royaltyBps } = await currentRates(current.nftContract, standard, current.tokenId);
    const warning =
      price * 2n <= current.pricePerUnit
        ? `\n\nCareful: that's ${pct(10000n - (price * 10000n) / current.pricePerUnit)} below the current price.`
        : '';
    if (!confirm(
      `Change the price from ${usdcText(current.pricePerUnit)} to ${usdcText(price)} USDC${each}?\n\n` +
        `Marketplace fee ${pct(feeBps)}${royaltyBps > 0n ? ` + creator royalty ${pct(royaltyBps)}` : ''}: ` +
        `you receive ${usdcText(netOf(price, feeBps, royaltyBps))} USDC${each}. Anyone can buy at the new price the moment it lands.${warning}`
    )) return;
    await (await marketSigner().updatePrice(id, price, feeBps, royaltyBps, arcTx())).wait();
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

// Proceeds go to your wallet; if it can't take USDC (a contract without a payable receive, a
// blocklisted address), you're asked where to send them instead.
async function withdrawMarketProceeds() {
  if (!(await walletReady())) return;
  let to = userAddress;
  try {
    await marketSigner().withdrawProceeds.staticCall(to);
  } catch (err) {
    console.error(err);
    const other = prompt(`Your wallet can't receive the USDC right now (${reason(err)}). Send your proceeds to which address instead?`);
    if (other === null) return;
    if (!ethers.isAddress(other.trim())) return alert("That isn't an address.");
    to = ethers.getAddress(other.trim());
    if (!confirm(`Send all your waiting proceeds to ${to}?`)) return;
  }
  try {
    await (await marketSigner().withdrawProceeds(to, arcTx())).wait();
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

  const wanted = new URLSearchParams(location.search).get('collection');
  if (wanted && ethers.isAddress(wanted)) marketCollectionFilter = ethers.getAddress(wanted);

  document.querySelectorAll('#marketFilterTabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#marketFilterTabs .tab').forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      marketActiveFilter = tab.dataset.marketFilter;
      marketCollectionFilter = '';
      loadListings();
    });
  });

  document.addEventListener('sdoge:wallet-connected', loadListings);
  updateListButton();
  return loadListings();
});
