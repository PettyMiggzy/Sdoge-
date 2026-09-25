// Small helpers shared by the api/ai/* endpoints.
import { MIN_VENICE_BALANCE_USD, blobToken, veniceKey } from './config.mjs';
import { veniceBalance } from './venice.mjs';

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/** The JSON body (Vercel parses it; a plain Node request gives a string or nothing). */
export function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length <= 20_000) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

// Off-switch: Studio AI stays closed on the live site, even with VENICE_API_KEY set, until the
// fixes from the 2026-09-25 audit (prompt screening, credit storage) are in. Test runs use the
// in-memory store and aren't affected.
const STUDIO_AI_READY = false;

/** Whether Studio AI can take money right now, and if not, why (in words for the page). */
export async function availability() {
  if (!STUDIO_AI_READY && process.env.AI_STORE !== 'memory') return { ok: false, reason: "Studio AI isn't switched on yet." };
  if (!veniceKey()) return { ok: false, reason: "Studio AI isn't switched on yet." };
  if (!blobToken() && process.env.AI_STORE !== 'memory') return { ok: false, reason: "Studio AI isn't switched on yet." };
  const usd = await veniceBalance();
  if (usd === null) return { ok: false, reason: "Studio AI can't reach its image service right now. Try again soon." };
  if (usd < MIN_VENICE_BALANCE_USD) return { ok: false, reason: 'Studio AI is taking a short break while it tops up. Try again soon.' };
  return { ok: true };
}

/** Logs a server-side failure without anything secret in it. */
export function logError(where, err) {
  console.error(`[studio-ai] ${where}: ${String(err?.message ?? err).slice(0, 300)}${err?.detail ? ` | ${err.detail}` : ''}`);
}
