// POST /api/ai/credits { address, txs?: [hash] }
// Registers the wallet's new AI payments (each is checked on Arc first) and answers with the
// credits it has left: { credits, payments: [{ hash, credits, remaining }], problems }.
// Reading credits needs no sign-in; spending them does (see generate).
import { isAddress, isTxHash, verifyPayment } from '../_lib/chain.mjs';
import { body, logError, send } from '../_lib/http.mjs';
import { balances, getStore, listPayments, recordPayment } from '../_lib/store.mjs';

const MAX_NEW = 10;

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  const { address, txs } = body(req);
  if (!isAddress(address)) return send(res, 400, { error: 'Connect your wallet.' });
  const payer = address.toLowerCase();
  const store = getStore();
  try {
    const known = new Set((await listPayments(store, payer)).map((p) => p.hash));
    const fresh = [...new Set((Array.isArray(txs) ? txs : []).filter(isTxHash).map((h) => h.toLowerCase()))]
      .filter((h) => !known.has(h))
      .slice(0, MAX_NEW);
    const problems = [];
    for (const hash of fresh) {
      const p = await verifyPayment(hash, payer);
      if (p.ok) await recordPayment(store, p);
      else problems.push({ hash, reason: p.reason, retry: !!p.retry });
    }
    const payments = await balances(store, payer);
    return send(res, 200, { credits: payments.reduce((s, p) => s + p.remaining, 0), payments, problems });
  } catch (err) {
    logError('credits', err);
    return send(res, 502, { error: "Couldn't check your credits right now. Try again in a moment." });
  }
}
