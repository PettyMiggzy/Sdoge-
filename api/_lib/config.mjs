// SDOGE Studio "Create with AI": prices, models and limits.
//
// How it works: a buyer pays native USDC on Arc to the payee wallet (the owner's), with MEMO as
// the transaction data so it can't be mistaken for any other payment. Each payment is worth AI
// credits (CREDIT_PACKS). The page asks the buyer's wallet to sign a short session message once
// a day, which proves the credits are theirs; then every image spends credits from their
// payments. Images are made with Venice (the key stays on the server) and stored in this site's
// public Blob store, ready to mint in the Studio.
//
// Every image costs the buyer more than Venice charges for it: the difference is the owner's
// profit, and it's paid up front.

const env = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || String(v).trim() === '' ? fallback : String(v).trim();
};

export const CHAIN_ID = BigInt(env('AI_CHAIN_ID', '5042')); // Arc; tests run on a local chain
export const ARC_RPC_URL = env('ARC_RPC_URL', 'https://rpc.mainnet.arc.io');
/** A backup RPC (a paid provider, its key in the URL), tried when Arc's public RPC fails. Vercel env only. */
export const arcRpcFallbackUrl = () => env('ARC_RPC_FALLBACK_URL', '');

/** Where AI payments go: the owner's wallet. */
export const PAYEE = env('AI_PAYEE', '0x5899a0576A94327a6316E01190f951edf7645914').toLowerCase();

/** The data every AI payment carries: "SDOGE Studio AI" in hex. */
export const MEMO = `0x${Buffer.from('SDOGE Studio AI').toString('hex')}`;

const USDC = 10n ** 18n; // native USDC on Arc has 18 decimals

/** What a payment of exactly this much buys. Anything else buys floor(value / single price). */
export const CREDIT_PACKS = [
  { credits: 1, priceWei: USDC / 4n }, // 0.25 USDC
  { credits: 10, priceWei: 2n * USDC }, // 2 USDC (0.20 each)
  { credits: 50, priceWei: 8n * USDC }, // 8 USDC (0.16 each)
];
export const SINGLE_PRICE_WEI = CREDIT_PACKS[0].priceWei;

export function creditsFor(valueWei) {
  const v = BigInt(valueWei);
  const pack = CREDIT_PACKS.find((p) => p.priceWei === v);
  if (pack) return pack.credits;
  return Number(v / SINGLE_PRICE_WEI);
}

/**
 * The models on offer. `credits` is what one image costs the buyer; `veniceUsd` what Venice
 * charges (Venice's price list, 2026-09): every model costs the buyer at least 2.5x Venice's
 * price, even at the 50-pack rate.
 * `size`: 'wh' models take width/height, 'ar' models an aspect ratio (and some a resolution).
 */
export const MODELS = [
  { id: 'fast', venice: 'z-image-turbo', label: 'Fast', credits: 1, veniceUsd: 0.01, size: 'wh', blurb: 'Quick and cheap: a few seconds.' },
  { id: 'quality', venice: 'qwen-image', label: 'Quality', credits: 1, veniceUsd: 0.03, size: 'ar', blurb: 'Sharper detail; takes about 20 seconds.' },
  { id: 'anime', venice: 'wai-Illustrious', label: 'Anime', credits: 1, veniceUsd: 0.01, size: 'wh', blurb: 'Anime and cartoon styles.' },
  { id: 'uncensored', venice: 'lustify-v8', label: 'Uncensored', credits: 1, veniceUsd: 0.01, size: 'wh', blurb: 'The least filtered model.' },
  { id: 'text', venice: 'ideogram-v4', label: 'Text in image', credits: 1, veniceUsd: 0.06, size: 'ar', blurb: 'Best at lettering and logos.' },
  { id: 'premium', venice: 'nano-banana-pro', label: 'Premium', credits: 3, veniceUsd: 0.18, size: 'ar', resolution: '1K', blurb: 'Top quality; costs 3 credits.' },
];
export const modelById = (id) => MODELS.find((m) => m.id === id) || null;

export const MAX_PROMPT_CHARS = 1500;
/** Images a day across the whole site, so a flood can't drain the Venice balance at once. */
export const DAILY_LIMIT = Number(env('AI_DAILY_LIMIT', '400'));
/** Below this Venice balance, the site stops selling credits and making images. */
export const MIN_VENICE_BALANCE_USD = Number(env('AI_MIN_VENICE_BALANCE_USD', '3'));
/** How long a signed session lasts at most (the page asks for a day). */
export const SESSION_MAX_SECONDS = 24 * 3600;
/** Payments this many blocks deep are final (Arc finalizes in one block; one more for margin). */
export const MIN_CONFIRMATIONS = 1n;

/**
 * The message a wallet signs to use its credits. The page builds exactly the same text. It names
 * the site, so a wallet showing it on any other site is a warning sign.
 */
export function sessionMessage(address, expires) {
  return [
    'SDOGE Studio: use my AI credits',
    'Site: stabledoge.site',
    `Wallet: ${String(address).toLowerCase()}`,
    `Valid until: ${new Date(Number(expires) * 1000).toISOString()}`,
  ].join('\n');
}

export const veniceKey = () => env('VENICE_API_KEY', '');
export const blobToken = () => env('BLOB_READ_WRITE_TOKEN', '');
