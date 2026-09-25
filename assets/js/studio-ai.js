// SDOGE Studio "Create with AI" (studio.html). Needs arc.js and wallet.js, and runs after
// studio.js (it fills the 1-of-1 form's image field).
//
// - Credits are bought with a plain USDC payment on Arc to the SDOGE team's wallet, marked with
//   the Studio AI memo; the site's /api/ai endpoints check each payment on-chain.
// - Spending credits takes a signed sign-in (one wallet signature, good for a day), so nobody
//   else can spend them. Signing costs nothing and sends nothing.
// - Images are made on the server (the image service's key never reaches this page) and saved
//   at a public link, ready to mint.
const AI_API = '/api/ai';
const AI_SESSION_SECONDS = 24 * 3600;

let aiQuote = null;
let aiModel = 'fast';
let aiCreditsLeft = null;
let aiBusy = false;

const aiEl = (id) => document.getElementById(id);
const aiAddr = () => String(userAddress || '').toLowerCase();

// Per-wallet notes in this browser: payments not yet counted, and the day's sign-in.
function aiRead(kind, fallback) {
  try {
    const v = localStorage.getItem(`sdoge-ai-${kind}:${aiAddr()}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function aiWrite(kind, value) {
  try {
    localStorage.setItem(`sdoge-ai-${kind}:${aiAddr()}`, JSON.stringify(value));
  } catch {
    // private mode: works for this visit only
  }
}

async function aiFetch(path, payload) {
  try {
    const r = await fetch(
      `${AI_API}/${path}`,
      payload === undefined
        ? { cache: 'no-store' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
    );
    let json = {};
    try {
      json = await r.json();
    } catch {
      // not JSON
    }
    return { status: r.status, ok: r.ok, json };
  } catch (err) {
    console.error(err);
    return { status: 0, ok: false, json: { error: "Couldn't reach Studio AI. Check your connection and try again." } };
  }
}

function aiStatus(text) {
  aiEl('aiStatus').textContent = text || '';
}

// The exact text the server checks (api/_lib/config.mjs sessionMessage).
function aiSessionMessage(address, expires) {
  return [
    'SDOGE Studio: use my AI credits',
    `Wallet: ${String(address).toLowerCase()}`,
    `Valid until: ${new Date(Number(expires) * 1000).toISOString()}`,
  ].join('\n');
}

async function aiSession(fresh = false) {
  const now = Math.floor(Date.now() / 1000);
  const saved = fresh ? null : aiRead('session', null);
  if (saved && saved.address === aiAddr() && saved.expires > now + 120) return saved;
  const expires = now + AI_SESSION_SECONDS;
  const signature = await signer.signMessage(aiSessionMessage(userAddress, expires));
  const session = { address: aiAddr(), expires, signature };
  aiWrite('session', session);
  return session;
}

const aiModelInfo = (id = aiModel) => aiQuote?.models.find((m) => m.id === id) || null;

function aiShowCredits() {
  const el = aiEl('aiCredits');
  if (!userAddress) el.textContent = 'Connect your wallet';
  else if (aiCreditsLeft === null) el.textContent = '…';
  else el.textContent = `${fmt(aiCreditsLeft)} ${aiCreditsLeft === 1 ? 'credit' : 'credits'}`;
}

function aiUpdateButton() {
  const m = aiModelInfo();
  const btn = aiEl('aiCreateBtn');
  const cost = m ? m.credits : 1;
  btn.textContent = aiBusy ? 'Creating… (up to a minute)' : `Create (${cost} ${cost === 1 ? 'credit' : 'credits'})`;
  btn.disabled = aiBusy || !aiQuote?.available;
}

function renderAiModels() {
  const box = aiEl('aiModels');
  box.innerHTML = (aiQuote?.models || [])
    .map(
      (m) => `
      <button type="button" class="ai-model${m.id === aiModel ? ' is-selected' : ''}" data-model="${escHtml(m.id)}" role="radio" aria-checked="${m.id === aiModel}" title="${escHtml(m.blurb)}">
        <b>${escHtml(m.label)}</b><span>${m.credits === 1 ? '1 credit' : `${m.credits} credits`}</span>
      </button>`
    )
    .join('');
  box.querySelectorAll('[data-model]').forEach((b) =>
    b.addEventListener('click', () => {
      aiModel = b.dataset.model;
      renderAiModels();
      aiUpdateButton();
    })
  );
}

function renderAiPacks() {
  const box = aiEl('aiPacks');
  const packs = aiQuote?.packs || [];
  box.innerHTML = packs
    .map((p, i) => {
      const price = BigInt(p.priceWei);
      const each = p.credits > 1 ? ` (${usdcText(price / BigInt(p.credits))} each)` : '';
      return `<button type="button" class="btn btn--ghost btn--small ai-pack" data-pack="${i}"${aiQuote?.available ? '' : ' disabled'}>
        ${fmt(p.credits)} ${p.credits === 1 ? 'credit' : 'credits'} · ${usdcText(price)} USDC${each}</button>`;
    })
    .join('');
  box.querySelectorAll('[data-pack]').forEach((b) => b.addEventListener('click', () => buyAiPack(Number(b.dataset.pack))));
  const premium = (aiQuote?.models || []).find((m) => m.credits > 1);
  if (packs.length) {
    aiEl('aiPriceNote').textContent =
      `1 credit makes 1 image${premium ? ` (${premium.label} takes ${premium.credits})` : ''}: ` +
      packs.map((p) => `${fmt(p.credits)} for ${usdcText(BigInt(p.priceWei))} USDC`).join(', ') + '.';
  }
}

async function loadAiQuote() {
  const r = await aiFetch('quote');
  if (!r.ok) {
    aiQuote = null;
    aiStatus("Studio AI isn't available right now.");
  } else {
    aiQuote = r.json;
    if (!aiModelInfo()) aiModel = aiQuote.models[0]?.id || 'fast';
    aiStatus(aiQuote.available ? '' : aiQuote.reason);
  }
  renderAiModels();
  renderAiPacks();
  aiUpdateButton();
}

// Counts the wallet's credits, handing the server any payments it hasn't seen yet.
async function refreshAiCredits(extra = []) {
  aiShowCredits();
  if (!userAddress) return null;
  const pending = aiRead('pending', []);
  const txs = [...new Set([...pending, ...extra].map((h) => String(h).toLowerCase()))];
  const r = await aiFetch('credits', { address: userAddress, txs });
  if (!r.ok) {
    aiStatus(r.json.error || "Couldn't check your AI credits.");
    return null;
  }
  aiCreditsLeft = r.json.credits;
  aiWrite('pending', r.json.problems.filter((p) => p.retry).map((p) => p.hash));
  const bad = r.json.problems.filter((p) => !p.retry);
  if (bad.length) aiStatus(bad.map((p) => `Payment ${shortAddr(p.hash)}: ${p.reason}.`).join(' '));
  aiShowCredits();
  return r.json;
}

async function buyAiPack(i) {
  if (!aiQuote?.available) return alert(aiQuote?.reason || "Studio AI isn't open right now.");
  if (!(await walletReady())) return;
  const pack = aiQuote.packs[i];
  const price = BigInt(pack.priceWei);
  const ok = confirm(
    `Buy ${fmt(pack.credits)} AI ${pack.credits === 1 ? 'credit' : 'credits'} for ${usdcText(price)} USDC?\n\n` +
      `The USDC goes to the SDOGE team's wallet (${shortAddr(aiQuote.payee)}). Credits never expire and can't be refunded.`
  );
  if (!ok) return;
  let tx;
  try {
    tx = await signer.sendTransaction(arcTx({ to: aiQuote.payee, value: price, data: aiQuote.memo }));
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`Payment failed: ${reason(err)}`);
    return;
  }
  aiWrite('pending', [...new Set([...aiRead('pending', []), tx.hash.toLowerCase()])]);
  aiStatus('Payment sent. Waiting for Arc to confirm it…');
  try {
    await tx.wait();
  } catch (err) {
    console.error(err);
    aiStatus(`Your payment ${shortAddr(tx.hash)} didn't go through: ${reason(err)}`);
    return;
  }
  // Arc confirms in about a second; give the server a few tries to see it too.
  for (let tries = 0; tries < 6; tries++) {
    await refreshAiCredits([tx.hash]);
    if (!aiRead('pending', []).includes(tx.hash.toLowerCase())) break;
    await arcSleep(2000);
  }
  if (aiRead('pending', []).includes(tx.hash.toLowerCase())) {
    aiStatus('Your payment went through; your credits will show up in a moment. Refresh the page if they don\'t.');
  } else {
    aiStatus(`Payment received. You have ${fmt(aiCreditsLeft)} AI ${aiCreditsLeft === 1 ? 'credit' : 'credits'}.`);
  }
}

function showAiImage(url) {
  const img = aiEl('aiImage');
  img.src = url;
  img.hidden = false;
  aiEl('aiEmpty').hidden = true;
  aiEl('aiActions').hidden = false;
  aiEl('aiOpen').href = url;
  aiEl('aiUseBtn').dataset.url = url;
}

async function createAiImage() {
  const prompt = aiEl('aiPrompt').value.trim();
  if (!prompt) return alert('Describe the image you want.');
  if (!aiQuote?.available) return alert(aiQuote?.reason || "Studio AI isn't open right now.");
  if (aiBusy) return;
  if (!(await walletReady())) return;
  const m = aiModelInfo();
  if (aiCreditsLeft === null) await refreshAiCredits();
  if (aiCreditsLeft !== null && m && aiCreditsLeft < m.credits) {
    return alert(`${m.label} takes ${m.credits} ${m.credits === 1 ? 'credit' : 'credits'} and you have ${fmt(aiCreditsLeft)}. Buy a pack below.`);
  }
  let session;
  try {
    session = await aiSession();
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`Couldn't sign in: ${reason(err)}`);
    return;
  }
  aiBusy = true;
  aiUpdateButton();
  aiStatus('');
  try {
    let r = await aiFetch('generate', { ...session, model: aiModel, prompt });
    if (r.status === 401 && r.json.signIn) {
      session = await aiSession(true); // the sign-in expired or was from another wallet: sign again once
      r = await aiFetch('generate', { ...session, model: aiModel, prompt });
    }
    if (r.json.credits !== undefined && r.json.credits !== null) aiCreditsLeft = r.json.credits;
    aiShowCredits();
    if (!r.ok) return alert(r.json.error || 'Something went wrong. Try again.');
    showAiImage(r.json.url);
    await loadAiHistory();
  } catch (err) {
    console.error(err);
    if (!userRejected(err)) alert(`Couldn't create the image: ${reason(err)}`);
  } finally {
    aiBusy = false;
    aiUpdateButton();
  }
}

// Puts the image in the 1-of-1 form below (studio.js).
function useAiImage(url) {
  if (!url) return;
  const own = aiEl('cmOwnUri');
  if (own) own.checked = false;
  aiEl('cmImage').value = url;
  if (typeof updateCommunityPreview === 'function') updateCommunityPreview();
  aiEl('community')?.scrollIntoView?.({ behavior: 'smooth' });
}

// The wallet's recent images, once it has signed in this browser (never asks for a signature).
async function loadAiHistory() {
  const box = aiEl('aiHistory');
  const session = aiRead('session', null);
  if (!userAddress || !session || session.address !== aiAddr() || session.expires <= Date.now() / 1000 + 60) {
    box.innerHTML = '';
    return;
  }
  const r = await aiFetch('history', session);
  if (!r.ok || !r.json.images?.length) {
    box.innerHTML = '';
    return;
  }
  const safe = r.json.images.filter((i) => /^https:\/\/[\x21-\x7e]+$/.test(i.url));
  box.innerHTML =
    '<div class="ai-history__title">Your images</div><div class="ai-history__grid">' +
    safe.map((i) => `<button type="button" class="ai-thumb" data-url="${escHtml(i.url)}" title="Show this one"><img src="${escHtml(i.url)}" alt="" loading="lazy" /></button>`).join('') +
    '</div>';
  box.querySelectorAll('[data-url]').forEach((b) => b.addEventListener('click', () => showAiImage(b.dataset.url)));
}

async function addAiPayment() {
  const hash = aiEl('aiTxInput').value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return alert('Paste the transaction hash of your payment: 0x followed by 64 characters.');
  if (!(await walletReady())) return;
  aiStatus('');
  const r = await refreshAiCredits([hash]);
  if (r && !r.problems.some((p) => p.hash === hash.toLowerCase())) {
    aiEl('aiTxInput').value = '';
    aiStatus(`Added. You have ${fmt(aiCreditsLeft)} AI ${aiCreditsLeft === 1 ? 'credit' : 'credits'}.`);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadAiQuote();
  aiShowCredits();
  aiEl('aiCreateBtn').addEventListener('click', createAiImage);
  aiEl('aiUseBtn').addEventListener('click', (e) => useAiImage(e.currentTarget.dataset.url));
  aiEl('aiTxAdd').addEventListener('click', addAiPayment);
  aiEl('aiPrompt').addEventListener('input', () => {
    aiEl('aiPromptCount').textContent = String(aiEl('aiPrompt').value.length);
  });
});

document.addEventListener('sdoge:wallet-connected', () => {
  aiCreditsLeft = null;
  refreshAiCredits();
  loadAiHistory();
});
