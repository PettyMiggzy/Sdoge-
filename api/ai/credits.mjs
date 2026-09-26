// POST /api/ai/credits { address, txs?: [hash] }
// Registers the wallet's new AI payments (each is checked on Arc first) and answers with the
// credits it has left: { credits, payments: [{ hash, credits, remaining }], problems, unchecked }.
// It checks at most MAX_NEW new hashes per call, newest first; `unchecked` lists the ones left
// for the next call, so the page keeps them. Reading credits needs no sign-in; spending them does
// (see generate).
import { isAddress, isTxHash, verifyPayment } from '../_lib/chain.mjs';
import { body, limited, logError, send } from '../_lib/http.mjs';
import { balances, getStore, listPayments, recordPayment } from '../_lib/store.mjs';

const MAX_NEW = 10;

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  if (limited(req, 'credits', 30)) return send(res, 429, { error: 'Too many requests. Wait a minute and try again.' });
  const { address, txs } = body(req);
  if (!isAddress(address)) return send(res, 400, { error: 'Connect your wallet.' });
  const payer = address.toLowerCase();
  const store = getStore();
  try {
    const known = new Set((await listPayments(store, payer)).map((p) => p.hash));
    // The page sends its pending hashes oldest first, so the newest are at the end.
    const fresh = [...new Set((Array.isArray(txs) ? txs : []).filter(isTxHash).map((h) => h.toLowerCase()))].filter((h) => !known.has(h)).reverse();
    const problems = [];
    for (const hash of fresh.slice(0, MAX_NEW)) {
      const p = await verifyPayment(hash, payer);
      if (p.ok) await recordPayment(store, p);
      else problems.push({ hash, reason: p.reason, retry: !!p.retry });
    }
    const payments = await balances(store, payer);
    return send(res, 200, { credits: payments.reduce((s, p) => s + p.remaining, 0), payments, problems, unchecked: fresh.slice(MAX_NEW) });
  } catch (err) {
    logError('credits', err);
    return send(res, 502, { error: "Couldn't check your credits right now. Try again in a moment." });
  }
}
