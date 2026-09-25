// POST /api/ai/generate { address, expires, signature, model, prompt }
// Spends the signed-in wallet's AI credits on one image: { url, spent, credits }. Nothing is
// spent when the prompt is refused, the day's limit is reached, or the image fails: credits
// are claimed first and given back if anything after that goes wrong.
import { DAILY_LIMIT, modelById } from '../_lib/config.mjs';
import { verifySession } from '../_lib/chain.mjs';
import { availability, body, logError, send } from '../_lib/http.mjs';
import { checkPrompt } from '../_lib/rules.mjs';
import { balances, claimCredits, getStore, imagesToday, listPayments, releaseCredits, saveImage } from '../_lib/store.mjs';
import { veniceImage } from '../_lib/venice.mjs';

const creditsLeft = async (store, payer) => (await balances(store, payer)).reduce((s, p) => s + p.remaining, 0);

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  const input = body(req);
  const session = verifySession(input);
  if (!session.ok) return send(res, 401, { error: session.reason, signIn: true });
  const model = modelById(input.model);
  if (!model) return send(res, 400, { error: 'Pick a model.' });
  const rules = checkPrompt(input.prompt);
  if (!rules.ok) return send(res, 422, { error: rules.reason });

  const open = await availability();
  if (!open.ok) return send(res, 503, { error: open.reason });
  const store = getStore();
  const payer = session.address;

  let claimed = null;
  try {
    if ((await imagesToday(store, DAILY_LIMIT)) >= DAILY_LIMIT) {
      return send(res, 503, { error: "Studio AI has made all of today's images. Try again tomorrow; your credits are kept." });
    }
    for (const p of await listPayments(store, payer)) {
      claimed = await claimCredits(store, p.hash, p.credits, model.credits, { model: model.id });
      if (claimed) break;
    }
  } catch (err) {
    logError('claim', err);
    return send(res, 502, { error: "Couldn't reach your credits right now. Try again in a moment." });
  }
  if (!claimed) {
    return send(res, 402, {
      error: model.credits > 1 ? `${model.label} takes ${model.credits} credits. Buy a pack first.` : 'You need an AI credit. Buy a pack first.',
      credits: await creditsLeft(store, payer).catch(() => null),
    });
  }

  let image;
  try {
    image = await veniceImage(model, rules.prompt, rules.negative);
  } catch (err) {
    logError('venice', err);
    await releaseCredits(store, claimed).catch((e) => logError('release', e));
    return send(res, 502, { error: "The image didn't come out. Your credits are kept; try again." });
  }
  if (image.refused) {
    await releaseCredits(store, claimed).catch((e) => logError('release', e));
    return send(res, 422, { error: 'The image service refused that prompt. Your credits are kept.' });
  }

  try {
    const url = await saveImage(store, payer, image.bytes, { model: model.id, prompt: rules.prompt });
    return send(res, 200, { url, spent: model.credits, credits: await creditsLeft(store, payer).catch(() => null) });
  } catch (err) {
    logError('save', err);
    await releaseCredits(store, claimed).catch((e) => logError('release', e));
    return send(res, 502, { error: "The image couldn't be saved. Your credits are kept; try again." });
  }
}
