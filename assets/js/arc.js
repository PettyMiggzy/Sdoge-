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

// Arc's public RPC allows about 20 eth_calls per second per IP. Over the limit, an item inside a
// batched request comes back as error -32005 in an HTTP 200 (which ethers never retries), and a
// lone request gets HTTP 429 (which ethers does retry). So: never batch, stay under the limit on
// our side, and retry anything that still comes back rate-limited.
const ARC_RPC_MAX_PER_SECOND = 12;
const arcSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// When Arc's public RPC doesn't answer at all (down, an HTTP error), reads go to this site's
// /api/rpc instead: a read-only relay to a backup RPC whose key stays on the server
// (api/rpc.mjs). Only on the site itself (http or https), never from a file or a test.
let arcBackupProvider;
function arcBackup() {
  if (arcBackupProvider === undefined) {
    const origin = typeof location !== 'undefined' ? String(location.origin || '') : '';
    arcBackupProvider = /^https?:\/\//.test(origin) && typeof window !== 'undefined' && window.fetch
      ? new ethers.JsonRpcProvider(`${origin}/api/rpc`, Number(ARC_CHAIN_ID), { staticNetwork: true, batchMaxCount: 1 })
      : null;
  }
  return arcBackupProvider;
}

class ArcRpcProvider extends ethers.JsonRpcProvider {
  #sent = []; // send times in the last second

  async #slot() {
    for (;;) {
      const now = Date.now();
      while (this.#sent.length && now - this.#sent[0] >= 1000) this.#sent.shift();
      if (this.#sent.length < ARC_RPC_MAX_PER_SECOND) break;
      await arcSleep(1000 - (now - this.#sent[0]) + 5);
    }
    this.#sent.push(Date.now());
  }

  async _send(payload) {
    for (let attempt = 0; ; attempt++) {
      await this.#slot();
      let results;
      try {
        results = await super._send(payload);
      } catch (err) {
        const backup = arcBackup();
        if (!backup) throw err;
        return backup._send(payload);
      }
      if (attempt >= 5 || !results.some((r) => r?.error?.code === -32005)) return results;
      await arcSleep(1100);
    }
  }
}

const arcReadProvider = new ArcRpcProvider(ARC_RPC_URL, Number(ARC_CHAIN_ID), { staticNetwork: true, batchMaxCount: 1 });

// Retries a read a few times with backoff when the RPC itself failed (network trouble, a
// rate-limit answer that surfaced as "missing revert data"), so one failed call doesn't leave a
// page blank until reload. Anything the chain answered for real (a revert, a wrong contract) is
// thrown at once.
const arcTransient = (err) =>
  ['NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT', 'UNKNOWN_ERROR', 'BAD_DATA'].includes(err?.code) ||
  (err?.code === 'CALL_EXCEPTION' && err?.data == null && !err?.reason);

async function arcRetry(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries || !arcTransient(err)) throw err;
      await arcSleep(500 * 2 ** i);
    }
  }
}

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

// True if `address` has contract code on Arc. Guards against a wrong or placeholder address. An
// RPC error is thrown, not read as "no contract", so callers can retry.
async function hasCodeOnArc(address) {
  return (await arcReadProvider.getCode(address)) !== '0x';
}

// Copy that's only true before launch carries data-preview-copy. Once the page's contract is
// deployed it's replaced by its data-live-copy text, or hidden if it has none.
function arcShowLiveCopy(live) {
  if (!live) return;
  document.querySelectorAll('[data-preview-copy]').forEach((el) => {
    if (el.dataset.liveCopy !== undefined) el.textContent = el.dataset.liveCopy;
    else el.style.display = 'none';
  });
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
