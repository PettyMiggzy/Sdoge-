// POST /api/ai/generate { address, expires, signature, model, prompt }
// Spends the signed-in wallet's AI credits on one image: { url, spent, credits }.
//
// Order: sign-in, the word lists, the text-model check (screen.mjs), the day's limit, then the
// credits are claimed and the image is made. An image from an adult prompt passes the vision
// check before it's stored or shown.
// Nothing is spent when the prompt is refused, the day's limit is reached, or something fails on
// this site's side. A credit IS spent when Venice or the vision check blocks the finished image:
// Venice charged for it, and a free retry would let anyone probe the checks at the owner's cost.
import { DAILY_LIMIT, modelById } from '../_lib/config.mjs';
import { verifySession } from '../_lib/chain.mjs';
import { availability, body, limited, logError, send } from '../_lib/http.mjs';
import { checkPrompt, decide } from '../_lib/rules.mjs';
import { screenImage, screenPrompt } from '../_lib/screen.mjs';
import { balances, claimFromPayments, getStore, imagesToday, listPayments, releaseCredits, saveImage } from '../_lib/store.mjs';
import { veniceImage } from '../_lib/venice.mjs';

// The function may run 120 s (vercel.json). The image gets what's left of 100 s after the checks,
// which leaves time for the vision check and storing it, so a claimed credit is always settled.
const IMAGE_DEADLINE_MS = 100_000;
const MIN_IMAGE_MS = 25_000;

const creditsLeft = async (store, payer) => (await balances(store, payer)).reduce((s, p) => s + p.remaining, 0);

export default async function handler(req, res) {
  const started = Date.now();
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  if (limited(req, 'generate', 12)) return send(res, 429, { error: 'Too many requests. Wait a minute and try again.' });
  const input = body(req);
  const session = verifySession(input);
  if (!session.ok) return send(res, 401, { error: session.reason, signIn: true });
  const model = modelById(input.model);
  if (!model) return send(res, 400, { error: 'Pick a model.' });
  const rules = checkPrompt(input.prompt);
  if (!rules.ok) return send(res, 422, { error: rules.reason });

  const open = await availability();
  if (!open.ok) return send(res, 503, { error: open.reason });
  const screen = await screenPrompt(rules.prompt);
  if (!screen.ok) return send(res, 503, { error: "Couldn't check your prompt right now. Nothing was spent; try again in a moment." });
  const verdict = decide(model, rules, screen);
  if (!verdict.ok) return send(res, 422, { error: verdict.reason });

  const store = getStore();
  const payer = session.address;
  let claimed = null;
  try {
    if ((await imagesToday(store, DAILY_LIMIT)) >= DAILY_LIMIT) {
      return send(res, 503, { error: "Studio AI has made all of today's images. Try again tomorrow; your credits are kept." });
    }
    claimed = await claimFromPayments(store, await listPayments(store, payer), model.credits, { model: model.id });
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
  const giveBack = async () => releaseCredits(store, claimed).catch((e) => logError('release', e));

  const timeoutMs = IMAGE_DEADLINE_MS - (Date.now() - started);
  if (timeoutMs < MIN_IMAGE_MS) {
    await giveBack();
    return send(res, 503, { error: 'Studio AI is busy right now. Your credits are kept; try again.' });
  }
  let image;
  try {
    image = await veniceImage(model, rules.prompt, verdict.negative, { timeoutMs });
  } catch (err) {
    logError('venice', err);
    await giveBack();
    return send(res, 502, { error: "The image didn't come out. Your credits are kept; try again." });
  }
  if (image.refused) {
    return send(res, 422, {
      error: 'The image service blocked that image, so it used the credit. Try a different prompt.',
      spent: model.credits,
      credits: await creditsLeft(store, payer).catch(() => null),
    });
  }

  if (verdict.checkImage) {
    const seen = await screenImage(image.bytes);
    if (!seen.ok) {
      await giveBack();
      return send(res, 503, { error: "Couldn't check the image right now. Your credits are kept; try again." });
    }
    if (seen.blocked) {
      logError('blocked', new Error(`vision check blocked an image from ${payer} (${model.id})`));
      return send(res, 422, {
        error: "That image was blocked: nothing sexual involving anyone who looks under 18. It used the credit.",
        spent: model.credits,
        credits: await creditsLeft(store, payer).catch(() => null),
      });
    }
  }

  try {
    const url = await saveImage(store, payer, image.bytes, { model: model.id });
    return send(res, 200, { url, spent: model.credits, credits: await creditsLeft(store, payer).catch(() => null) });
  } catch (err) {
    logError('save', err);
    await giveBack();
    return send(res, 502, { error: "The image couldn't be saved. Your credits are kept; try again." });
  }
}
