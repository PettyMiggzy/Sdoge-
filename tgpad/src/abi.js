// Interfaces the bot relies on, matching ../launchpad/src. If a signature
// changes there, this is the one place to update it.
export const FACTORY_ABI = [
  'function launch(string name, string symbol, string uri) payable returns (address token, address vault, bytes32 id)',
  'function launchFee() view returns (uint256)',
  'event Launched(uint256 indexed index, bytes32 indexed poolId, address token, address vault, address creator, string name, string symbol, string uri)',
];

export const HOOK_ABI = [
  'function owed(address) view returns (uint256)',
  'function claim(address account) returns (uint256)',
];

// MemeVault: backing is shared by every token (supply = total supply minus
// dEaD and vault-held tokens), so the floor only ever goes up.
export const VAULT_ABI = [
  'function backing() view returns (uint256)',
  'function effectiveSupply() view returns (uint256)',
  'function floorPrice() view returns (uint256)',
  'function quoteRedeem(uint256 amount) view returns (uint256)',
  'function redeem(uint256 amount, uint256 minUsdcOut, address to) returns (uint256 pay)',
];

export const ROUTER_ABI = [
  'function buy(address token, uint256 usdcIn, uint256 minTokensOut, address to, uint256 deadline) returns (uint256 tokensOut)',
  'function buyWithNative(address token, uint256 minTokensOut, address to, uint256 deadline) payable returns (uint256 tokensOut)',
  'function sell(address token, uint256 tokensIn, uint256 minUsdcOut, address to, uint256 deadline) returns (uint256 usdcOut)',
  'function quoteBuy(address token, uint256 usdcIn) returns (uint256 tokensOut)',
  'function quoteSell(address token, uint256 tokensIn) returns (uint256 usdcOut)',
];

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

// keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"),
// verified against live SDOGE-pool logs by the buy bot.
export const SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
