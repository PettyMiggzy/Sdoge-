// POST /api/ai/history { address, expires, signature }: the signed-in wallet's last images.
import { verifySession } from '../_lib/chain.mjs';
import { body, limited, logError, send } from '../_lib/http.mjs';
import { getStore, history } from '../_lib/store.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  if (limited(req, 'history', 30)) return send(res, 429, { error: 'Too many requests. Wait a minute and try again.' });
  const session = verifySession(body(req));
  if (!session.ok) return send(res, 401, { error: session.reason, signIn: true });
  try {
    return send(res, 200, { images: await history(getStore(), session.address) });
  } catch (err) {
    logError('history', err);
    return send(res, 502, { error: "Couldn't load your images right now." });
  }
}
