// Arc mainnet helpers shared by the staking, NFT and Studio pages.
//
// - Reads go straight to Arc's public RPC, whatever network the wallet is on, so the page never
//   shows another chain's data.
// - Every transaction first makes sure the wallet is on Arc (chain 5042), switching or adding the
//   network if needed, and is pinned to chain 5042 (arcTx), so a wallet that changed network
//   mid-flow refuses it instead of sending another chain's coin to an address with no code there.
const ARC_CHAIN_ID = 5042n;
const ARC_CHAIN_HEX = '0x13b2';
const ARC_RPC_URL = 'https://rpc.mainnet.arc.io';
const ARC_EXPLORER_URL = 'https://explorer.arc.io';
const ARC_CHAIN_PARAMS = {
  chainId: ARC_CHAIN_HEX,
  chainName: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: [ARC_RPC_URL],
  blockExplorerUrls: [ARC_EXPLORER_URL],
};

// Deployed addresses on Arc. contracts/scripts/sync-frontend.js fills these in from
// contracts/deployments/arc.json; an empty string means "not deployed yet".
const SDOGE_CONTRACTS = Object.freeze({
  token: '0xf8df98fda14cabb2e8b6efe920081ffcbb0bb405',
  staking: '',
  collectibles: '',
  studio: '',
  marketplace: '',
});

const arcReadProvider = new ethers.JsonRpcProvider(ARC_RPC_URL, Number(ARC_CHAIN_ID), { staticNetwork: true });

const isAddressSet = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

// Transaction overrides pinned to Arc, e.g. contract.mint(1, 1, arcTx({ value })).
const arcTx = (extra = {}) => ({ chainId: ARC_CHAIN_ID, ...extra });

// The user clicked "reject" in their wallet: not an error worth an alert.
const userRejected = (err) =>
  err?.code === 'ACTION_REJECTED' || err?.code === 4001 || err?.info?.error?.code === 4001 || err?.error?.code === 4001;

async function walletChainId() {
  return BigInt(await window.ethereum.request({ method: 'eth_chainId' }));
}

// Returns true once the wallet is on Arc; false if the user declined to switch.
async function ensureArcNetwork() {
  if (!window.ethereum) return false;
  if ((await walletChainId()) === ARC_CHAIN_ID) return true;
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ARC_CHAIN_HEX }] });
  } catch (err) {
    const code = err?.code ?? err?.data?.originalError?.code;
    if (code !== 4902) {
      alert('Switch your wallet to the Arc network (chain 5042) to continue.');
      return false;
    }
    try {
      await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [ARC_CHAIN_PARAMS] });
    } catch {
      alert('Add the Arc network (chain 5042) to your wallet to continue.');
      return false;
    }
  }
  return (await walletChainId()) === ARC_CHAIN_ID;
}

// True if `address` has contract code on Arc. Guards against a wrong or placeholder address.
async function hasCodeOnArc(address) {
  try {
    return (await arcReadProvider.getCode(address)) !== '0x';
  } catch {
    return false;
  }
}

// Chain time, not the browser clock: lock status and deadlines must match what the contract sees.
async function arcNow() {
  const block = await arcReadProvider.getBlock('latest');
  return BigInt(block.timestamp);
}

// Once a page holds a wallet signer, a network or account change makes it stale: start fresh.
// Before that there's nothing stale, and the network switch and account approval that connecting
// itself causes must not reload the page in the middle of the click that asked for them.
let arcSignerAddress = null;

function arcTrackSigner(address) {
  arcSignerAddress = address.toLowerCase();
}

if (window.ethereum?.on) {
  window.ethereum.on('chainChanged', () => {
    if (arcSignerAddress) window.location.reload();
  });
  window.ethereum.on('accountsChanged', (accounts) => {
    if (arcSignerAddress && String(accounts?.[0] ?? '').toLowerCase() !== arcSignerAddress) window.location.reload();
  });
}
