// Wallet connection and formatting helpers shared by the NFT page (nft.js, marketplace.js) and
// the Studio page (studio.js). Needs arc.js loaded first.
//
// These load as plain scripts that share one global scope, so the names defined here are used
// as-is by the other files and must never be redeclared there.
let provider, signer, userAddress;

const fmt = (n) => Number(n).toLocaleString('en-US');
const shortAddr = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const reason = arcErrorText;
const sameAddr = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const escHtml = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// Exact text for an 18-decimal amount (native USDC or SDOGE): no float rounding, trailing zeros
// trimmed, thousands separated.
function tokenText(wei) {
  const [whole, frac = ''] = ethers.formatEther(wei).split('.');
  const f = frac.replace(/0+$/, '');
  return BigInt(whole).toLocaleString('en-US') + (f ? `.${f}` : '');
}
const usdcText = tokenText;

// "12.5" -> wei, for USDC amounts typed by the user: digits, at most 6 decimals. null if invalid.
function parseUsdc(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return null;
  return ethers.parseEther(s);
}

async function connectWallet() {
  if (!window.ethereum) {
    alert('No wallet found. Install MetaMask or another injected wallet to continue.');
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
    if (!userRejected(err)) alert(`Could not connect: ${reason(err)}`);
    return false;
  }
  arcTrackSigner(userAddress);
  document.querySelectorAll('.js-connect-wallet').forEach((btn) => {
    btn.textContent = shortAddr(userAddress);
  });
  document.dispatchEvent(new CustomEvent('sdoge:wallet-connected'));
  return true;
}

// Before any transaction: connected, and still on Arc.
async function walletReady() {
  if (!userAddress && !(await connectWallet())) return false;
  return ensureArcNetwork();
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.js-connect-wallet').forEach((btn) => btn.addEventListener('click', connectWallet));
});
