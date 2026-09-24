// Arc mainnet helpers shared by the staking and NFT pages.
//
// - Reads go straight to Arc's public RPC, whatever network the wallet is on, so the page never
//   shows another chain's data.
// - Every transaction first makes sure the wallet is on Arc (chain 5042), switching or adding the
//   network if needed. On any other chain a "Mint" or "Stake" would send that chain's coin to an
//   address with no code there, and it would be gone.
const ARC_CHAIN_ID = 5042n;
const ARC_CHAIN_HEX = '0x13b2';
const ARC_RPC_URL = 'https://rpc.mainnet.arc.io';
const ARC_CHAIN_PARAMS = {
  chainId: ARC_CHAIN_HEX,
  chainName: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: [ARC_RPC_URL],
  blockExplorerUrls: ['https://explorer.arc.io'],
};

const arcReadProvider = new ethers.JsonRpcProvider(ARC_RPC_URL, Number(ARC_CHAIN_ID), { staticNetwork: true });

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

// A network or account change makes every signer stale; start fresh.
if (window.ethereum?.on) {
  window.ethereum.on('chainChanged', () => window.location.reload());
  window.ethereum.on('accountsChanged', () => window.location.reload());
}
