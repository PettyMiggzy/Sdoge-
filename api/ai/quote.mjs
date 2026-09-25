// GET /api/ai/quote: what Studio AI sells, where to pay, and whether it's open right now.
import { CHAIN_ID, CREDIT_PACKS, DAILY_LIMIT, MAX_PROMPT_CHARS, MEMO, MODELS, PAYEE } from '../_lib/config.mjs';
import { availability, send } from '../_lib/http.mjs';

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'Use GET.' });
  const open = await availability();
  return send(res, 200, {
    available: open.ok,
    reason: open.ok ? null : open.reason,
    chainId: Number(CHAIN_ID),
    payee: PAYEE,
    memo: MEMO,
    packs: CREDIT_PACKS.map((p) => ({ credits: p.credits, priceWei: p.priceWei.toString() })),
    models: MODELS.map(({ id, label, credits, blurb }) => ({ id, label, credits, blurb })),
    maxPromptChars: MAX_PROMPT_CHARS,
    dailyLimit: DAILY_LIMIT,
  });
}
