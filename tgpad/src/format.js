import { formatUnits } from 'ethers';

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

// Fixed-point bigint -> human string with thousands separators, trimmed zeros.
export function fmtUnits(value, decimals, maxFrac = 4) {
  const neg = value < 0n;
  const s = formatUnits(neg ? -value : value, decimals);
  let [whole, frac = ''] = s.split('.');
  frac = frac.slice(0, maxFrac).replace(/0+$/, '');
  whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + whole + (frac ? `.${frac}` : '');
}

// Native USDC on Arc is 18-decimal wei; the pool's ERC-20 view is 6-decimal.
export const fmtUsdcWei = (wei, maxFrac = 2) => fmtUnits(wei, 18, maxFrac);
export const fmtUsdc6 = (v, maxFrac = 2) => fmtUnits(v, 6, maxFrac);
export const fmtTokens = (v) => fmtUnits(v, 18, v >= 10n ** 21n ? 0 : 4);

export function fmtPrice(usdPerToken) {
  if (!Number.isFinite(usdPerToken) || usdPerToken <= 0) return 'n/a';
  if (usdPerToken >= 1) return '$' + usdPerToken.toFixed(4);
  return '$' + usdPerToken.toFixed(Math.min(14, Math.max(4, 3 - Math.floor(Math.log10(usdPerToken)))));
}

export const fmtCompactUsd = (n) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(n);

export const addrLink = (explorer, a) => `<a href="${explorer}/address/${a}">${short(a)}</a>`;
export const tokenLink = (explorer, a) => `<a href="${explorer}/token/${a}">${short(a)}</a>`;
export const txLink = (explorer, h, label = 'view tx') => `<a href="${explorer}/tx/${h}">${esc(label)}</a>`;

// How a token is identified wherever it's confirmed or alerted: tickers aren't
// unique, so the name and contract address always come with them.
export const tokenLine = (l) => `<b>${esc(l.name)}</b> ($${esc(l.symbol)}) · <code>${short(l.token)}</code>`;

export function fmtAge(ms) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export const bpsToPct = (bps) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;
