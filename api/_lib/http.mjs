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

// Requests per minute from one address, per endpoint. Kept in the function's memory, so it's a
// speed bump (each running instance counts on its own), enough to stop one script hammering the
// store or Arc's RPC.
const hits = new Map(); // `${key}:${ip}` -> [times]
export function limited(req, key, perMinute) {
  const h = req.headers ?? {};
  const ip = String(h['x-real-ip'] ?? String(h['x-forwarded-for'] ?? '').split(',')[0] ?? '').trim();
  if (!ip) return false; // Vercel always sets these; only local runs and tests have none
  const id = `${key}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(id) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(id, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] >= 60_000) hits.delete(k);
  return recent.length > perMinute;
}

/** Whether Studio AI can take money right now, and if not, why (in words for the page). */
export async function availability() {
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
