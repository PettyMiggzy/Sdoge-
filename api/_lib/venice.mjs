// Venice calls for Studio AI. The key is VENICE_API_KEY on the server; it never reaches a page.
// AI_FAKE_VENICE=1 (tests only) answers with a tiny image instead of calling Venice.
import { veniceKey } from './config.mjs';

const API = 'https://api.venice.ai/api/v1';
const headers = () => ({ Authorization: `Bearer ${veniceKey()}`, 'Content-Type': 'application/json', 'User-Agent': 'sdoge-studio-ai/1.0' });
const fake = () => process.env.AI_FAKE_VENICE === '1';

// A 1x1 WebP, for tests.
const TINY_WEBP = Buffer.from('UklGRjwAAABXRUJQVlA4IDAAAAAQAgCdASoBAAEAAUAmJaACdLoB+AH4AAPIAP7paR/7snbK5H/L7/9Tgwc+fj/AAAA=', 'base64');

let balanceCache = { usd: null, at: 0 };

/** Venice's USD balance (cached for a minute), or null if it can't be read. */
export async function veniceBalance() {
  if (fake()) return Number(process.env.AI_FAKE_BALANCE ?? 100);
  if (Date.now() - balanceCache.at < 60_000 && balanceCache.usd !== null) return balanceCache.usd;
  try {
    const r = await fetch(`${API}/api_keys/rate_limits`, { headers: headers(), signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return null;
    const usd = Number((await r.json())?.data?.balances?.USD);
    balanceCache = { usd: Number.isFinite(usd) ? usd : null, at: Date.now() };
    return balanceCache.usd;
  } catch {
    return null;
  }
}

/**
 * Makes one square image. { bytes, refused } where refused means Venice flagged or blurred it;
 * throws when Venice fails.
 */
export async function veniceImage(model, prompt, negative, { timeoutMs = 100_000 } = {}) {
  if (fake()) {
    if (process.env.AI_FAKE_FAIL === '1') throw new Error('Venice is down (test)');
    return { bytes: TINY_WEBP, refused: process.env.AI_FAKE_REFUSE === '1' };
  }
  const body = {
    model: model.venice,
    prompt,
    format: 'webp',
    safe_mode: false,
    hide_watermark: true,
    return_binary: false,
    embed_exif_metadata: false,
    ...(model.size === 'wh' ? { width: 1024, height: 1024 } : { aspect_ratio: '1:1' }),
    ...(model.resolution ? { resolution: model.resolution } : {}),
    ...(negative ? { negative_prompt: negative } : {}),
  };
  const r = await fetch(`${API}/image/generate`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  // Only a real number updates the cached balance: a missing header must not read as $0.
  const balanceHeader = r.headers.get('x-venice-balance-usd');
  const balance = balanceHeader?.trim() ? Number(balanceHeader) : NaN;
  if (Number.isFinite(balance)) balanceCache = { usd: balance, at: Date.now() };
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 300);
    throw Object.assign(new Error(`Venice answered ${r.status}`), { status: r.status, detail });
  }
  const refused = ['x-venice-is-content-violation', 'x-venice-is-adult-model-content-violation', 'x-venice-is-blurred'].some(
    (h) => r.headers.get(h) === 'true',
  );
  const b64 = (await r.json())?.images?.[0];
  if (!b64) throw new Error('Venice sent no image');
  return { bytes: Buffer.from(b64, 'base64'), refused };
}
