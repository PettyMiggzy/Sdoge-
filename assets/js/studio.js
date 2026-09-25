// SDOGE Studio UI: buy mint credits, mint your own 1-of-1s into Community Art, launch your own
// collection (batch mints, airdrops, a public drop), and mint from someone's drop
// (studio.html?drop=0x...). Needs arc.js and wallet.js.
//
// Safety rules this file follows (same as the other pages):
// - Reads go to Arc's RPC; every write first checks the wallet is on Arc and is pinned to 5042.
// - Package terms and drop prices are re-read right before paying. Buyers pass the mints they
//   expect and pay an exact price, so a change landing first reverts instead of costing them.
// - Anything a creator controls (collection names and symbols) is escaped, and other people's
//   token URIs and images are never rendered.
// - SDOGE approvals are for the exact amount being burned.
// - The drop form always shows the saved terms (schedule included); saving asks before it removes
//   a schedule or makes a drop free or cheaper than a credit, and opening a drop confirms the
//   SAVED terms, never what's typed.
// - The drop page shows who owns the collection, where sales go, and what the owner can still
//   change (no cap, metadata not frozen).
// - Collections load one at a time; one that fails doesn't hide the others.
const STUDIO_CONTRACT_ADDRESS = SDOGE_CONTRACTS.studio;
const STUDIO_TOKEN_ADDRESS = SDOGE_CONTRACTS.token;

const PACKAGE_TUPLE = 'tuple(uint64 mints, bool active, uint128 priceWei, uint128 priceSdoge)';
const STUDIO_ABI = [
  'function buyCredits(uint256 packageId, uint256 expectedMints, address to) payable',
  'function buyCreditsWithSdoge(uint256 packageId, uint256 expectedMints, uint256 maxSdoge, address to)',
  'function mintCommunity(string uri) returns (uint256 tokenId)',
  'function createCollection(string name, string symbol, uint256 maxSupply, address royaltyReceiver, uint96 royaltyBps, string contractURI) returns (address collection)',
  'function credits(address) view returns (uint256)',
  `function getPackages() view returns (${PACKAGE_TUPLE}[])`,
  `function getPackage(uint256 packageId) view returns (${PACKAGE_TUPLE})`,
  'function communityCollection() view returns (address)',
  'function collectionsOf(address creator) view returns (address[])',
  'function isCollection(address) view returns (bool)',
  'function verified(address) view returns (bool)',
  'function rewardsPool() view returns (address)',
  'function poolShareBps() view returns (uint256)',
];
const COLLECTION_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function owner() view returns (address)',
  'function totalMinted() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
  'function baseURI() view returns (string)',
  'function uriSuffix() view returns (string)',
  'function metadataFrozen() view returns (bool)',
  'function payout() view returns (address)',
  'function publicMinted(address) view returns (uint256)',
  'function drop() view returns (uint128 priceWei, uint32 maxPerWallet, uint40 start, uint40 end, bool open)',
  'function dropConfigured() view returns (bool)',
  'function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address receiver, uint256 amount)',
  'function mintBatch(address to, uint256 quantity) returns (uint256 firstId)',
  'function mintWithURIs(address to, string[] uris) returns (uint256 firstId)',
  'function airdrop(address[] recipients) returns (uint256 firstId)',
  'function setBaseURI(string newBaseURI, string newSuffix)',
  'function freezeMetadata()',
  'function setDrop(uint256 priceWei, uint256 maxPerWallet, uint256 start, uint256 end)',
  'function setDropOpen(bool open)',
  'function publicMint(uint256 quantity) payable returns (uint256 firstId)',
  'function withdraw()',
  'function setMaxSupply(uint256 newMaxSupply)',
  'function setRoyalty(address receiver, uint96 bps)',
  'function setPayout(address newPayout)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];
const STUDIO_ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];

// Shown before launch. Must match nft/studio.json (checked by the front-end tests).
const PREVIEW_PACKAGES = [
  { mints: 1n, active: true, priceWei: ethers.parseEther('5'), priceSdoge: ethers.parseEther('1000000') },
  { mints: 10n, active: true, priceWei: ethers.parseEther('20'), priceSdoge: 0n },
  { mints: 100n, active: true, priceWei: ethers.parseEther('50'), priceSdoge: 0n },
  { mints: 1000n, active: true, priceWei: ethers.parseEther('100'), priceSdoge: 0n },
];
const PACKAGE_NAMES = { 1: 'Single', 10: 'Starter', 100: 'Creator', 1000: 'Project' };
const MAX_URI_BYTES = 512;
const MAX_URI_BATCH = 50; // mintWithURIs: tokens per transaction...
const MAX_URI_BATCH_BYTES = 6000; // ...and URI bytes, to stay well inside Arc's per-transaction gas cap
const MAX_BATCH = 200;
const MAX_PUBLIC_MINT = 20;

const studioDeployed = () => isAddressSet(STUDIO_CONTRACT_ADDRESS);
const studioRead = studioDeployed() ? new ethers.Contract(STUDIO_CONTRACT_ADDRESS, STUDIO_ABI, arcReadProvider) : null;
const studioSdogeRead = new ethers.Contract(STUDIO_TOKEN_ADDRESS, STUDIO_ERC20_ABI, arcReadProvider);
let studioWrite;
let studioReady = false;
let packages = PREVIEW_PACKAGES.map((p) => ({ ...p }));
let myCredits = 0n;
let communityAddress = '';
let dropAddress = '';
let dropShown = null; // the drop terms on screen, to catch changes before paying
const managed = new Set(); // collections the wallet owns but didn't create (handed over to it)

const collectionRead = (address) => new ethers.Contract(address, COLLECTION_ABI, arcReadProvider);
const collectionWrite = (address) => new ethers.Contract(address, COLLECTION_ABI, signer);
const packageFields = (p) => ({ mints: BigInt(p.mints), active: p.active, priceWei: BigInt(p.priceWei), priceSdoge: BigInt(p.priceSdoge) });
const $ = (id) => document.getElementById(id);
const when = (t) => new Date(Number(t) * 1000).toLocaleString();
const plainUsdc = (wei) => ethers.formatEther(wei).replace(/\.0$/, ''); // no thousands separators, so it re-saves as typed
const explorerAddr = (a) => `<a href="${ARC_EXPLORER_URL}/address/${a}" target="_blank" rel="noopener">${shortAddr(a)}</a>`;

// unix seconds -> a datetime-local value in the viewer's time zone (seconds kept); '' when unset
function inputFromUnix(ts) {
  const n = Number(ts);
  if (!n) return '';
  const d = new Date(n * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// The cheapest a credit can be bought for in USDC right now (per mint), or null.
function cheapestCreditWei() {
  const each = packages.filter((p) => p.active && p.priceWei > 0n).map((p) => p.priceWei / p.mints);
  return each.length ? each.reduce((a, b) => (b < a ? b : a)) : null;
}

function studioSigner() {
  if (!studioWrite) studioWrite = new ethers.Contract(STUDIO_CONTRACT_ADDRESS, STUDIO_ABI, signer);
  return studioWrite;
}

// A URI the contracts accept: 1-512 bytes of printable ASCII, no spaces.
const isUriText = (s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_URI_BYTES && /^[\x21-\x7e]+$/.test(s);
const isImageUrl = (s) => isUriText(s) && /^(ipfs:\/\/|https:\/\/)/.test(s);

async function sendTx(label, txPromise) {
  try {
    const receipt = await (await txPromise()).wait();
    return receipt;
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`${label} failed: ${reason(err)}`);
    return null;
  }
}

async function studioWalletReady() {
  if (!studioDeployed()) {
    alert('SDOGE Studio isn\'t live yet. This page is a preview.');
    return false;
  }
  if (!studioReady) {
    alert('SDOGE Studio is unavailable right now.');
    return false;
  }
  return walletReady();
}

// ---------- Packages and credits ----------

function renderPackages() {
  const grid = $('packageGrid');
  if (!grid) return;
  const shown = packages.map((p, id) => ({ ...p, id })).filter((p) => p.active);
  const eachWei = (p) => (p.priceWei > 0n ? p.priceWei / p.mints : null);
  const best = shown.filter((p) => eachWei(p) !== null).sort((a, b) => (eachWei(a) < eachWei(b) ? -1 : 1))[0];
  grid.innerHTML = shown
    .map((p) => {
      const name = PACKAGE_NAMES[Number(p.mints)] || `${fmt(p.mints)} mints`;
      const usdc = p.priceWei > 0n ? `${usdcText(p.priceWei)} USDC` : null;
      const each = p.priceWei > 0n ? `${usdcText(p.priceWei / p.mints)} USDC per mint` : '';
      return `
        <div class="package-card ${best && best.id === p.id && shown.length > 1 ? 'package-card--best' : ''}">
          <div class="package-card__name">${name}${best && best.id === p.id && shown.length > 1 ? ' &middot; best value' : ''}</div>
          <div class="package-card__mints">${fmt(p.mints)} ${p.mints === 1n ? 'mint' : 'mints'}</div>
          ${usdc ? `<div class="package-card__price">${usdc}</div><div class="package-card__each">${each}</div>` : ''}
          ${p.priceSdoge > 0n ? `<div class="package-card__each">or burn ${tokenText(p.priceSdoge)} SDOGE</div>` : ''}
          ${usdc ? `<button class="btn btn--primary btn--small" data-buy-usdc="${p.id}">Buy with USDC</button>` : ''}
          ${p.priceSdoge > 0n ? `<button class="btn btn--ghost btn--small" data-buy-sdoge="${p.id}">Burn SDOGE</button>` : ''}
        </div>`;
    })
    .join('');
  grid.querySelectorAll('[data-buy-usdc]').forEach((b) => b.addEventListener('click', () => buyPackage(Number(b.dataset.buyUsdc), 'usdc')));
  grid.querySelectorAll('[data-buy-sdoge]').forEach((b) => b.addEventListener('click', () => buyPackage(Number(b.dataset.buySdoge), 'sdoge')));
}

async function refreshCredits() {
  const el = $('creditBalance');
  if (!el) return;
  if (!userAddress) {
    el.textContent = 'Connect your wallet';
    return;
  }
  if (!studioReady) {
    el.textContent = studioDeployed() ? 'Unavailable' : 'Not live yet';
    return;
  }
  try {
    myCredits = await studioRead.credits(userAddress);
    el.textContent = `${fmt(myCredits)} ${myCredits === 1n ? 'credit' : 'credits'}`;
  } catch (err) {
    console.error(err);
    el.textContent = 'Unavailable';
  }
}

async function buyPackage(id, currency) {
  if (!(await studioWalletReady())) return;
  let fresh;
  try {
    fresh = packageFields(await studioRead.getPackage(id));
  } catch (err) {
    console.error(err);
    alert(`Could not read the package: ${reason(err)}`);
    return;
  }
  const shown = packages[id];
  const changed = !shown || !fresh.active || fresh.mints !== shown.mints || fresh.priceWei !== shown.priceWei || fresh.priceSdoge !== shown.priceSdoge;
  if (changed) {
    packages[id] = fresh;
    renderPackages();
    alert('This package just changed. Check the new terms, then buy again.');
    return;
  }
  const s = studioSigner();
  if (currency === 'usdc') {
    await sendTx('Purchase', () => s.buyCredits(id, fresh.mints, userAddress, arcTx({ value: fresh.priceWei })));
  } else {
    const have = await studioSdogeRead.balanceOf(userAddress);
    if (have < fresh.priceSdoge) {
      alert(`You need ${tokenText(fresh.priceSdoge)} SDOGE; you have ${tokenText(have)}.`);
      return;
    }
    if (!confirm(`Burn ${tokenText(fresh.priceSdoge)} SDOGE for ${fmt(fresh.mints)} mint ${fresh.mints === 1n ? 'credit' : 'credits'}? Burned SDOGE is gone for good.`)) return;
    const token = new ethers.Contract(STUDIO_TOKEN_ADDRESS, STUDIO_ERC20_ABI, signer);
    if ((await studioSdogeRead.allowance(userAddress, STUDIO_CONTRACT_ADDRESS)) < fresh.priceSdoge) {
      if (!(await sendTx('Approval', () => token.approve(STUDIO_CONTRACT_ADDRESS, fresh.priceSdoge, arcTx())))) return;
    }
    await sendTx('Purchase', () => s.buyCreditsWithSdoge(id, fresh.mints, fresh.priceSdoge, userAddress, arcTx()));
  }
  await refreshCredits();
}

// ---------- Community Art: your own 1-of-1 ----------

// The token URI for the form: your own metadata URI, or metadata built right here (name,
// description, image link) and stored on-chain as a data: URI, so only the image needs hosting.
function communityUri() {
  if ($('cmOwnUri')?.checked) {
    const uri = $('cmUri').value.trim();
    return isUriText(uri) ? { uri } : { error: 'Enter your metadata URI (ipfs:// or https://, no spaces, up to 512 characters).' };
  }
  const name = $('cmName').value.trim();
  const description = $('cmDescription').value.trim();
  const image = $('cmImage').value.trim();
  if (!name) return { error: 'Give your NFT a name.' };
  if (!isImageUrl(image)) return { error: 'Enter your image link: ipfs://... or https://..., no spaces.' };
  const json = JSON.stringify({ name, description, image });
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  const uri = `data:application/json;base64,${btoa(bin)}`;
  if (uri.length > MAX_URI_BYTES) {
    return { error: `That's ${uri.length - MAX_URI_BYTES} characters too long to store on-chain. Shorten the description or name.` };
  }
  return { uri };
}

function updateCommunityPreview() {
  const own = $('cmOwnUri')?.checked;
  if ($('cmUriField')) $('cmUriField').style.display = own ? 'block' : 'none';
  if ($('cmBuiltFields')) $('cmBuiltFields').style.display = own ? 'none' : 'block';
  const img = $('cmPreview');
  const image = $('cmImage')?.value.trim() ?? '';
  if (img) {
    // Your own image, shown only to you. ipfs:// goes through a public gateway for the preview.
    const src = image.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${image.slice(7)}` : image.startsWith('https://') ? image : '';
    img.style.display = src && !own ? 'block' : 'none';
    if (src && !own) img.src = src;
  }
  const r = communityUri();
  const info = $('cmUriLength');
  if (info) info.textContent = r.error ? '' : `Metadata: ${r.uri.length} of ${MAX_URI_BYTES} characters.`;
}

async function mintCommunityArt() {
  if (!(await studioWalletReady())) return;
  const r = communityUri();
  if (r.error) {
    alert(r.error);
    return;
  }
  await refreshCredits();
  if (myCredits < 1n) {
    alert('You need a mint credit first: 1 mint is 5 USDC (see the packages above).');
    return;
  }
  const receipt = await sendTx('Mint', () => studioSigner().mintCommunity(r.uri, arcTx()));
  if (receipt) {
    const iface = new ethers.Interface(COLLECTION_ABI);
    const log = receipt.logs.find((l) => sameAddr(l.address, communityAddress) && l.topics[0] === iface.getEvent('Transfer').topicHash);
    const tokenId = log ? iface.parseLog(log).args.tokenId : null;
    const out = $('cmResult');
    if (out && tokenId !== null) {
      out.innerHTML = `Minted <a href="${ARC_EXPLORER_URL}/token/${communityAddress}/instance/${tokenId}" target="_blank" rel="noopener">Community Art #${tokenId}</a>. It's yours; list it on the marketplace any time.`;
    }
  }
  await refreshCredits();
}

// ---------- Your own collections ----------

// "7.5" (%) -> 750 bps; null if invalid or above 10%.
function parseRoyaltyBps(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return 0;
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(s)) return null;
  const bps = Math.round(Number(s) * 100);
  return bps <= 1000 ? bps : null;
}

async function createMyCollection() {
  if (!(await studioWalletReady())) return;
  const name = $('ccName').value.trim();
  const symbol = $('ccSymbol').value.trim();
  const capRaw = $('ccMaxSupply').value.trim();
  const bps = parseRoyaltyBps($('ccRoyalty').value);
  if (!/^[\x20-\x7e]{1,64}$/.test(name)) return alert('Name: 1-64 characters (letters, numbers, spaces, basic punctuation).');
  if (!/^[\x21-\x7e]{1,16}$/.test(symbol)) return alert('Symbol: 1-16 characters, no spaces (e.g. DOGE).');
  if (capRaw !== '' && !/^[1-9]\d*$/.test(capRaw)) return alert('Max supply: a whole number, or leave it empty for no cap yet.');
  if (bps === null) return alert('Royalty: 0-10%, up to 2 decimals.');
  const cap = capRaw === '' ? 0n : BigInt(capRaw);
  const receipt = await sendTx('Creating the collection', () =>
    studioSigner().createCollection(name, symbol, cap, ethers.ZeroAddress, bps, '', arcTx())
  );
  if (receipt) {
    $('ccName').value = '';
    $('ccSymbol').value = '';
    await loadMyCollections();
  }
}

async function readCollection(address) {
  const c = collectionRead(address);
  const [name, symbol, owner, minted, cap, base, suffix, frozen, drop, configured, payout, balance, royalty, verified] =
    await Promise.all([
      c.name(),
      c.symbol(),
      c.owner(),
      c.totalMinted(),
      c.maxSupply(),
      c.baseURI(),
      c.uriSuffix(),
      c.metadataFrozen(),
      c.drop(),
      c.dropConfigured(),
      c.payout(),
      arcReadProvider.getBalance(address),
      c.royaltyInfo(1, 10000n),
      studioRead.verified(address),
    ]);
  return { address, name, symbol, owner, minted, cap, base, suffix, frozen, drop, configured, payout, balance, royaltyBps: royalty[1], verified };
}

function dropSummary(d, configured) {
  if (!configured) return 'Drop terms not saved yet';
  const schedule = `${d.start > 0n ? `, starts ${when(d.start)}` : ''}${d.end > 0n ? `, ends ${when(d.end)}` : ''}`;
  const price = d.priceWei > 0n ? `${usdcText(d.priceWei)} USDC` : 'free';
  return `${d.open ? 'Drop open' : 'Drop closed'}: ${price} each${d.maxPerWallet > 0n ? `, ${d.maxPerWallet} per wallet` : ''}${schedule}`;
}

function collectionCardHtml(c) {
  const mine = sameAddr(c.owner, userAddress);
  const d = c.drop;
  const link = `${location.origin}${location.pathname}?drop=${c.address}`;
  const supply = c.cap > 0n ? `${fmt(c.minted)} / ${fmt(c.cap)} minted` : `${fmt(c.minted)} minted, no supply cap yet`;
  const payout = sameAddr(c.payout, c.owner) ? 'sales go to the owner' : `sales go to ${explorerAddr(c.payout)}`;
  const a = c.address;
  return `
    <div class="panel collection-card" data-collection="${a}">
      <div class="panel__head">
        <span class="panel__title">${escHtml(c.name)} <span class="studio-note">${escHtml(c.symbol)}</span>${c.verified ? ' <span class="stake-row__tag">Verified</span>' : ''}</span>
        <a class="studio-note" href="${ARC_EXPLORER_URL}/address/${a}" target="_blank" rel="noopener">${shortAddr(a)}</a>
      </div>
      <p class="studio-note">${supply} &middot; ${escHtml(dropSummary(d, c.configured))} &middot; royalty ${(Number(c.royaltyBps) / 100).toFixed(2)}% &middot; ${payout} &middot; sales waiting: ${usdcText(c.balance)} USDC &middot; ${c.frozen ? 'metadata frozen' : 'metadata not frozen'}</p>
      ${
        !mine
          ? `<p class="studio-note">You no longer own this collection (the owner is ${explorerAddr(c.owner)}).</p>`
          : `
      <div class="studio-row">
        <label class="studio-field">Mint to (address)<input class="studio-input" data-f="to" value="${userAddress}" /></label>
        <label class="studio-field">How many (base URI tokens)<input class="studio-input" data-f="qty" type="number" min="1" max="${MAX_BATCH}" value="1" /></label>
      </div>
      <div class="studio-actions"><button class="chip-btn" data-act="mintBatch">Mint (1 credit each)</button></div>
      <label class="studio-field">Or one token per URI, one per line (up to ${MAX_URI_BATCH}, ${fmt(MAX_URI_BATCH_BYTES)} characters in all)<textarea class="studio-input" data-f="uris" placeholder="ipfs://.../1.json"></textarea></label>
      <div class="studio-actions"><button class="chip-btn" data-act="mintWithURIs">Mint these to the address above</button></div>
      <label class="studio-field">Airdrop: one token to each address, one per line (up to ${MAX_BATCH})<textarea class="studio-input" data-f="airdrop" placeholder="0x..."></textarea></label>
      <div class="studio-actions"><button class="chip-btn" data-act="airdrop">Airdrop</button></div>
      <div class="studio-row">
        <label class="studio-field">Base URI (for drop and batch tokens)<input class="studio-input" data-f="base" value="${escHtml(c.base)}" placeholder="ipfs://CID/" ${c.frozen ? 'disabled' : ''} /></label>
        <label class="studio-field">Suffix<input class="studio-input" data-f="suffix" value="${escHtml(c.suffix)}" placeholder=".json" ${c.frozen ? 'disabled' : ''} /></label>
      </div>
      <div class="studio-actions">
        <button class="chip-btn" data-act="setBaseURI" ${c.frozen ? 'disabled' : ''}>Save base URI</button>
        <button class="chip-btn" data-act="freeze" ${c.frozen || !c.base ? 'disabled' : ''}>Freeze metadata</button>
      </div>
      <div class="studio-row">
        <label class="studio-field">Drop price (USDC, 0 = free)<input class="studio-input" data-f="price" value="${c.configured ? plainUsdc(d.priceWei) : ''}" /></label>
        <label class="studio-field">Per wallet (0 = no limit)<input class="studio-input" data-f="perWallet" type="number" min="0" value="${d.maxPerWallet}" /></label>
        <label class="studio-field">Starts (empty = as soon as it's open)<input class="studio-input" data-f="start" type="datetime-local" step="1" value="${inputFromUnix(d.start)}" /></label>
        <label class="studio-field">Ends (empty = no end)<input class="studio-input" data-f="end" type="datetime-local" step="1" value="${inputFromUnix(d.end)}" /></label>
      </div>
      <div class="studio-actions">
        <button class="chip-btn" data-act="setDrop">Save drop terms</button>
        <button class="chip-btn" data-act="toggleDrop">${d.open ? 'Close the drop' : 'Open the drop'}</button>
        <button class="chip-btn" data-act="copyLink" data-link="${link}">Copy drop link</button>
      </div>
      <div class="studio-actions">
        <button class="chip-btn" data-act="withdraw" ${c.balance > 0n ? '' : 'disabled'}>Withdraw sales</button>
        <button class="chip-btn" data-act="setPayout">Change where sales go</button>
        <button class="chip-btn" data-act="setCap">${c.cap > 0n ? 'Lower the cap' : 'Set a supply cap'}</button>
        <button class="chip-btn" data-act="setRoyalty">Change royalty</button>
      </div>`
      }
    </div>`;
}

async function loadMyCollections() {
  const box = $('myCollections');
  if (!box) return;
  if (!userAddress || !studioReady) {
    box.innerHTML = `<p class="empty-state">${studioReady ? 'Connect your wallet to see your collections.' : 'Collections open once SDOGE Studio is live.'}</p>`;
    return;
  }
  let created;
  try {
    created = await arcRetry(() => studioRead.collectionsOf(userAddress));
  } catch (err) {
    console.error(err);
    box.innerHTML = '<p class="empty-state">Could not load your collections right now. Reload to try again.</p>';
    return;
  }
  const addresses = [...new Set([...created.map((a) => ethers.getAddress(a)), ...managed])];
  if (!addresses.length) {
    box.innerHTML = '<p class="empty-state">No collections yet. Create one above.</p>';
    return;
  }
  const cards = [];
  for (const a of addresses) {
    try {
      cards.push(collectionCardHtml(await arcRetry(() => readCollection(a))));
    } catch (err) {
      console.error(`Could not load collection ${a}:`, err);
      cards.push(`<div class="panel collection-card"><p class="studio-note">Couldn't load ${explorerAddr(a)} right now. Reload to try again.</p></div>`);
    }
  }
  box.innerHTML = cards.join('');
  box.querySelectorAll('[data-act]').forEach((btn) => {
    const card = btn.closest('[data-collection]');
    btn.addEventListener('click', () => collectionAction(card.dataset.collection, btn.dataset.act, card, btn));
  });
}

// Shows a collection this wallet owns but didn't create (for example one handed over to it).
async function manageCollection() {
  const raw = $('manageAddress')?.value.trim() ?? '';
  if (!ethers.isAddress(raw)) return alert("Enter the collection's address.");
  if (!(await studioWalletReady())) return;
  const a = ethers.getAddress(raw);
  try {
    if (!(await studioRead.isCollection(a))) return alert("That isn't a SDOGE Studio collection.");
    if (!sameAddr(await collectionRead(a).owner(), userAddress)) return alert("Your wallet doesn't own that collection.");
  } catch (err) {
    console.error(err);
    return alert(`Could not check that collection: ${reason(err)}`);
  }
  managed.add(a);
  $('manageAddress').value = '';
  await loadMyCollections();
}

// Owner mints skip the NFT receiver check, so tokens sent to a contract that can't handle them
// are stuck there. Refuses this site's own contracts and asks before sending to any contract.
async function recipientsOk(addresses, collection) {
  const known = [STUDIO_CONTRACT_ADDRESS, communityAddress, collection, SDOGE_CONTRACTS.marketplace, SDOGE_CONTRACTS.staking,
    SDOGE_CONTRACTS.collectibles, SDOGE_CONTRACTS.token].filter(isAddressSet);
  const bad = addresses.find((a) => known.some((k) => sameAddr(a, k)));
  if (bad) {
    alert(`${bad} is one of the SDOGE contracts; an NFT sent there is stuck for good. Remove it.`);
    return false;
  }
  const contracts = [];
  for (const a of [...new Set(addresses.map((x) => x.toLowerCase()))]) {
    if ((await arcRetry(() => arcReadProvider.getCode(a))) !== '0x') contracts.push(a);
  }
  if (!contracts.length) return true;
  return confirm(
    `${contracts.length === 1 ? 'This address is a contract' : `${contracts.length} of these addresses are contracts`}: ` +
      `${contracts.slice(0, 5).join(', ')}${contracts.length > 5 ? ', ...' : ''}.\n\n` +
      'Owner mints skip the receiver check, so a contract that can\'t handle NFTs keeps them for good. Send anyway?'
  );
}

// The drop terms typed on a card differ from what's saved on-chain.
function formDiffersFromSaved(card, d) {
  const price = parseUsdc(field(card, 'price'));
  const perWallet = field(card, 'perWallet') || '0';
  const start = unixFromInput(field(card, 'start'));
  const end = unixFromInput(field(card, 'end'));
  return (
    price === null ||
    price !== d.priceWei ||
    !/^\d+$/.test(perWallet) ||
    BigInt(perWallet) !== BigInt(d.maxPerWallet) ||
    start === null ||
    end === null ||
    BigInt(start) !== BigInt(d.start) ||
    BigInt(end) !== BigInt(d.end)
  );
}

const field = (card, name) => card.querySelector(`[data-f="${name}"]`)?.value.trim() ?? '';
const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

function unixFromInput(value) {
  if (!value) return 0;
  const t = Math.floor(new Date(value).getTime() / 1000);
  return Number.isFinite(t) && t > 0 ? t : null;
}

async function collectionAction(address, act, card, btn) {
  if (act === 'copyLink') {
    try {
      await navigator.clipboard.writeText(btn.dataset.link);
      btn.textContent = 'Copied!';
    } catch {
      prompt('Copy your drop link:', btn.dataset.link);
    }
    return;
  }
  if (!(await studioWalletReady())) return;
  const c = collectionWrite(address);
  await refreshCredits();
  const needCredits = (n) => {
    if (myCredits < BigInt(n)) {
      alert(`That needs ${fmt(n)} mint ${n === 1 ? 'credit' : 'credits'}; you have ${fmt(myCredits)}. Buy a package above.`);
      return false;
    }
    return true;
  };

  let done = null;
  if (act === 'mintBatch') {
    const to = field(card, 'to');
    const qty = field(card, 'qty');
    if (!ethers.isAddress(to)) return alert('Enter the address to mint to.');
    if (!/^\d+$/.test(qty) || Number(qty) < 1 || Number(qty) > MAX_BATCH) return alert(`Mint 1-${MAX_BATCH} at a time.`);
    if (!needCredits(Number(qty))) return;
    if (!(await recipientsOk([to], address))) return;
    done = await sendTx('Mint', () => c.mintBatch(to, qty, arcTx()));
  } else if (act === 'mintWithURIs') {
    const to = field(card, 'to');
    const uris = lines(field(card, 'uris'));
    if (!ethers.isAddress(to)) return alert('Enter the address to mint to.');
    if (!uris.length || uris.length > MAX_URI_BATCH) return alert(`Enter 1-${MAX_URI_BATCH} URIs, one per line (split bigger batches).`);
    const bad = uris.find((u) => !isUriText(u));
    if (bad) return alert(`Not a valid URI (no spaces, up to 512 characters): ${bad.slice(0, 80)}`);
    const bytes = uris.reduce((sum, u) => sum + u.length, 0);
    if (bytes > MAX_URI_BATCH_BYTES) {
      return alert(`These URIs add up to ${fmt(bytes)} characters; one transaction takes up to ${fmt(MAX_URI_BATCH_BYTES)}. Split them into smaller batches.`);
    }
    if (!needCredits(uris.length)) return;
    if (!(await recipientsOk([to], address))) return;
    done = await sendTx('Mint', () => c.mintWithURIs(to, uris, arcTx()));
  } else if (act === 'airdrop') {
    const list = lines(field(card, 'airdrop'));
    if (!list.length || list.length > MAX_BATCH) return alert(`Enter 1-${MAX_BATCH} addresses, one per line.`);
    const bad = list.find((a) => !ethers.isAddress(a));
    if (bad) return alert(`Not an address: ${bad.slice(0, 80)}`);
    if (!needCredits(list.length)) return;
    if (!(await recipientsOk(list, address))) return;
    done = await sendTx('Airdrop', () => c.airdrop(list.map((a) => ethers.getAddress(a)), arcTx()));
  } else if (act === 'setBaseURI') {
    const base = field(card, 'base');
    const suffix = field(card, 'suffix');
    if (!isUriText(base)) return alert('Base URI: ipfs://CID/ or https://..., no spaces.');
    if (suffix && !/^[\x21-\x7e]{1,16}$/.test(suffix)) return alert('Suffix: up to 16 characters, no spaces (e.g. .json).');
    if (!/[/=]$/.test(base) && !confirm(`Token 1 would point at ${base}1${suffix}: there's no "/" between the folder and the number. Save anyway?`)) return;
    done = await sendTx('Saving the base URI', () => c.setBaseURI(base, suffix, arcTx()));
  } else if (act === 'freeze') {
    const r = collectionRead(address);
    const [base, suffix] = await Promise.all([r.baseURI(), r.uriSuffix()]);
    if (!base) return alert('Save a base URI first: frozen with none, drop and batch tokens would stay blank forever.');
    if (!confirm(
      'Freeze the metadata for good? The base URI and collection metadata can never change again.\n\n' +
        `Token 1 points at ${base}1${suffix}. Open that link and check it first.`
    )) return;
    done = await sendTx('Freezing', () => c.freezeMetadata(arcTx()));
  } else if (act === 'setDrop') {
    const price = parseUsdc(field(card, 'price'));
    const perWallet = field(card, 'perWallet') || '0';
    const start = unixFromInput(field(card, 'start'));
    const end = unixFromInput(field(card, 'end'));
    if (price === null || (price > 0n && price < 10n ** 16n)) return alert('Drop price: 0 (free) or at least 0.01 USDC, up to 6 decimals.');
    if (!/^\d+$/.test(perWallet)) return alert('Per wallet: a whole number (0 = no limit).');
    if (start === null || end === null) return alert('Check the start and end times.');
    if (end && end <= start) return alert('The drop must end after it starts.');
    const r = collectionRead(address);
    const [cur, cap] = await Promise.all([r.drop(), r.maxSupply()]);
    if (price === 0n && cap === 0n) return alert('A free drop needs a supply cap (every free mint still uses one of your credits). Set a cap first.');
    const notes = [];
    if (cur.start > 0n && start === 0) notes.push("removes the drop's start time, so it's live as soon as it's open");
    if (cur.end > 0n && end === 0) notes.push("removes the drop's end time, so it never ends");
    const cheapest = cheapestCreditWei();
    if (price === 0n) notes.push('makes the drop free: collectors pay nothing and every mint uses one of your credits');
    else if (cheapest !== null && price < cheapest) {
      notes.push(`prices a mint below what a credit costs you (${usdcText(cheapest)} USDC at best), and every mint uses one of your credits`);
    }
    if (notes.length && !confirm(`This ${notes.join('; it ')}.${cur.open ? ' The drop is OPEN: this applies the moment it lands.' : ''} Continue?`)) return;
    done = await sendTx('Saving the drop', () => c.setDrop(price, perWallet, start, end, arcTx()));
  } else if (act === 'toggleDrop') {
    const r = collectionRead(address);
    const d = await r.drop();
    if (d.open) {
      done = await sendTx('Closing the drop', () => c.setDropOpen(false, arcTx()));
    } else {
      const [base, configured, cap, minted] = await Promise.all([r.baseURI(), r.dropConfigured(), r.maxSupply(), r.totalMinted()]);
      if (!base) return alert('Set a base URI first: drop tokens use it for their metadata.');
      if (!configured) return alert('Save the drop terms first ("Save drop terms"), then open the drop.');
      if (formDiffersFromSaved(card, d)) {
        return alert('The terms in the form aren\'t the saved ones. Click "Save drop terms" first (or reload to see the saved terms).');
      }
      if (d.priceWei === 0n && cap === 0n) return alert('A free drop needs a supply cap. Set one first.');
      if (!confirm(
        `Open the drop with the saved terms?\n\n${dropSummary({ priceWei: d.priceWei, maxPerWallet: d.maxPerWallet, start: d.start, end: d.end, open: false }, true).replace('Drop closed: ', '')}.\n` +
          `${d.priceWei === 0n ? 'FREE: collectors pay nothing. ' : ''}${cap > 0n ? `${fmt(cap - minted)} left under the cap.` : 'No supply cap.'}\n\n` +
          `Every mint uses one of your credits: you have ${fmt(myCredits)}, shared by all your collections.`
      )) return;
      done = await sendTx('Opening the drop', () => c.setDropOpen(true, arcTx()));
    }
  } else if (act === 'setPayout') {
    const raw = prompt('Send drop sales to which address? (It must be able to receive USDC.)');
    if (raw === null) return;
    if (!ethers.isAddress(raw.trim())) return alert("That isn't an address.");
    const to = ethers.getAddress(raw.trim());
    if (!confirm(`Send this collection's drop sales to ${to} from now on (including sales already waiting)?`)) return;
    done = await sendTx('Changing where sales go', () => c.setPayout(to, arcTx()));
  } else if (act === 'withdraw') {
    done = await sendTx('Withdraw', () => c.withdraw(arcTx()));
  } else if (act === 'setCap') {
    const raw = prompt('New supply cap (it can only go down from here, never up):');
    if (raw === null) return;
    if (!/^[1-9]\d*$/.test(raw.trim())) return alert('A whole number, at least what is already minted.');
    done = await sendTx('Setting the cap', () => c.setMaxSupply(raw.trim(), arcTx()));
  } else if (act === 'setRoyalty') {
    const raw = prompt('Royalty on resales, in % (0-10, paid to you by marketplaces that honor it):');
    if (raw === null) return;
    const bps = parseRoyaltyBps(raw);
    if (bps === null) return alert('0-10%, up to 2 decimals.');
    done = await sendTx('Setting the royalty', () => c.setRoyalty(userAddress, bps, arcTx()));
  }
  if (done) await loadMyCollections();
  await refreshCredits();
}

// ---------- Public drop page: studio.html?drop=0x... ----------

async function loadDrop() {
  const section = $('dropSection');
  if (!section || !dropAddress) return;
  section.style.display = 'block';
  const info = $('dropInfo');
  const btn = $('dropMintBtn');
  btn.disabled = true;
  if (!studioReady) {
    info.textContent = studioDeployed() ? 'SDOGE Studio is unavailable right now.' : 'SDOGE Studio isn\'t live yet.';
    return;
  }
  try {
    if (!(await studioRead.isCollection(dropAddress))) {
      $('dropTitle').textContent = 'Not a SDOGE Studio collection';
      info.textContent = 'This link doesn\'t point at a collection made with SDOGE Studio. Don\'t mint from it here.';
      return;
    }
    const c = collectionRead(dropAddress);
    const [name, symbol, owner, minted, cap, d, verified, now, payout, frozen] = await Promise.all([
      c.name(),
      c.symbol(),
      c.owner(),
      c.totalMinted(),
      c.maxSupply(),
      c.drop(),
      studioRead.verified(dropAddress),
      arcNow(),
      c.payout(),
      c.metadataFrozen(),
    ]);
    const [ownerCredits, mineMinted] = await Promise.all([
      studioRead.credits(owner),
      userAddress ? c.publicMinted(userAddress) : 0n,
    ]);
    dropShown = { priceWei: d.priceWei };
    $('dropTitle').textContent = `${name} (${symbol})`;
    const badge = verified
      ? '<span class="stake-row__tag">Verified by SDOGE</span>'
      : '<span class="stake-row__tag stake-row__tag--warn">Unverified creator collection</span> <span class="studio-note">Anyone can make a collection with SDOGE Studio. Check who is behind this one before you mint.</span>';
    const facts = [
      `Contract ${explorerAddr(dropAddress)}`,
      `owner ${explorerAddr(owner)}`,
      `sales go to ${sameAddr(payout, owner) ? 'the owner' : explorerAddr(payout)}`,
      cap > 0n ? `supply capped at ${fmt(cap)}` : 'no supply cap: the owner can mint more at any time',
      frozen ? 'metadata frozen' : 'metadata not frozen: the owner can still change it',
    ];
    $('dropBadge').innerHTML = `${badge}<br /><span class="studio-note">${facts.join(' &middot; ')}</span>`;
    const capLeft = cap > 0n ? cap - minted : null;
    const room = capLeft === null ? ownerCredits : capLeft < ownerCredits ? capLeft : ownerCredits;
    const parts = [
      `${d.priceWei > 0n ? `${usdcText(d.priceWei)} USDC` : 'Free'} each`,
      cap > 0n ? `${fmt(minted)} / ${fmt(cap)} minted` : `${fmt(minted)} minted`,
      d.maxPerWallet > 0n ? `${d.maxPerWallet} per wallet${userAddress ? ` (you've minted ${mineMinted})` : ''}` : 'no wallet limit',
    ];
    let state = '';
    if (!d.open) state = 'The drop is closed.';
    else if (d.start > 0n && now < d.start) state = `Opens ${new Date(Number(d.start) * 1000).toLocaleString()}.`;
    else if (d.end > 0n && now >= d.end) state = 'The drop has ended.';
    else if (capLeft !== null && capLeft === 0n) state = 'Sold out.';
    else if (ownerCredits === 0n) state = "Stopped for now: the creator is out of mint credits. It goes on when credits are added (by the creator or anyone else).";
    info.textContent = `${parts.join(' · ')}${state ? ` · ${state}` : ''}`;
    btn.disabled = Boolean(state) || room === 0n;
    btn.textContent = btn.disabled ? 'Not available' : 'Mint';
  } catch (err) {
    console.error(err);
    info.textContent = 'Could not load this drop right now.';
  }
}

async function mintFromDrop() {
  if (!(await studioWalletReady())) return;
  const qtyRaw = $('dropQty').value.trim() || '1';
  if (!/^\d+$/.test(qtyRaw) || Number(qtyRaw) < 1 || Number(qtyRaw) > MAX_PUBLIC_MINT) {
    alert(`Mint 1-${MAX_PUBLIC_MINT} at a time.`);
    return;
  }
  const qty = BigInt(qtyRaw);
  const d = await collectionRead(dropAddress).drop();
  if (!dropShown || d.priceWei !== dropShown.priceWei) {
    await loadDrop();
    alert(`The price just changed to ${usdcText(d.priceWei)} USDC. Check it, then mint again.`);
    return;
  }
  await sendTx('Mint', () => collectionWrite(dropAddress).publicMint(qty, arcTx({ value: d.priceWei * qty })));
  await loadDrop();
}

// ---------- Startup ----------

async function loadStudio() {
  const status = $('studioStatus');
  if (!studioDeployed()) {
    if (status) status.textContent = 'Not live yet · preview';
    renderPackages();
    return;
  }
  try {
    if (!(await arcRetry(() => hasCodeOnArc(STUDIO_CONTRACT_ADDRESS)))) throw new Error(`no Studio contract at ${STUDIO_CONTRACT_ADDRESS} on Arc`);
    const [onChain, community, pool, shareBps] = await arcRetry(() =>
      Promise.all([studioRead.getPackages(), studioRead.communityCollection(), studioRead.rewardsPool(), studioRead.poolShareBps()])
    );
    packages = onChain.map(packageFields);
    communityAddress = community;
    studioReady = true;
    if (status) status.textContent = 'Live on Arc';
    const share = $('studioShare');
    if (share) {
      share.textContent =
        pool === ethers.ZeroAddress || shareBps === 0n
          ? 'Right now credit sales go to the treasury; none are routed to the staking pool yet.'
          : sameAddr(pool, SDOGE_CONTRACTS.staking)
            ? `${Number(shareBps) / 100}% of every USDC credit sale is set aside for the $SDOGE staking reward pool at the moment you buy.`
            : `${Number(shareBps) / 100}% of every USDC credit sale goes to ${pool}, which is not this site's staking contract.`;
    }
  } catch (err) {
    console.error('Could not load SDOGE Studio:', err);
    if (status) status.textContent = 'Unavailable right now';
  }
  renderPackages();
}

document.addEventListener('DOMContentLoaded', async () => {
  const param = new URLSearchParams(location.search).get('drop');
  if (param && ethers.isAddress(param)) dropAddress = ethers.getAddress(param);

  $('cmMintBtn')?.addEventListener('click', mintCommunityArt);
  $('ccCreateBtn')?.addEventListener('click', createMyCollection);
  $('dropMintBtn')?.addEventListener('click', mintFromDrop);
  $('manageBtn')?.addEventListener('click', manageCollection);
  ['cmName', 'cmDescription', 'cmImage', 'cmUri', 'cmOwnUri'].forEach((id) => $(id)?.addEventListener('input', updateCommunityPreview));
  $('cmOwnUri')?.addEventListener('change', updateCommunityPreview);
  document.addEventListener('sdoge:wallet-connected', async () => {
    await refreshCredits();
    await loadMyCollections();
    await loadDrop();
  });

  await loadStudio();
  updateCommunityPreview();
  await refreshCredits();
  await loadMyCollections();
  await loadDrop();
  if (dropAddress) $('dropSection')?.scrollIntoView();
});
