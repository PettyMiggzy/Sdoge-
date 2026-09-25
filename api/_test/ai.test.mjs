// Studio AI endpoints, end to end, with a fake Arc RPC, an in-memory store and a fake Venice.
//   npm test   (from the repo root)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Wallet, parseEther } from 'ethers';

// ---------- a fake Arc RPC: canned transactions ----------
const txs = new Map(); // hash -> { tx, receipt }
const rpcServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const { id, method, params } = JSON.parse(raw);
    const found = txs.get(String(params?.[0] ?? '').toLowerCase());
    const result =
      method === 'eth_blockNumber' ? '0x100' : method === 'eth_getTransactionByHash' ? found?.tx ?? null : method === 'eth_getTransactionReceipt' ? found?.receipt ?? null : null;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
});
await new Promise((r) => rpcServer.listen(0, '127.0.0.1', r));

process.env.ARC_RPC_URL = `http://127.0.0.1:${rpcServer.address().port}`;
process.env.AI_STORE = 'memory';
process.env.AI_FAKE_VENICE = '1';
process.env.VENICE_API_KEY = 'test-key';
process.env.AI_DAILY_LIMIT = '40';

const config = await import('../_lib/config.mjs');
const { checkPrompt } = await import('../_lib/rules.mjs');
const { verifySession } = await import('../_lib/chain.mjs');
const { getStore } = await import('../_lib/store.mjs');
const quote = (await import('../ai/quote.mjs')).default;
const credits = (await import('../ai/credits.mjs')).default;
const generate = (await import('../ai/generate.mjs')).default;
const historyApi = (await import('../ai/history.mjs')).default;

test.after(() => rpcServer.close());

let nonce = 0;
function pay(from, valueUsdc, { to = config.PAYEE, input = config.MEMO, status = '0x1' } = {}) {
  const hash = `0x${(++nonce).toString(16).padStart(64, '0')}`;
  txs.set(hash, {
    tx: { hash, from: from.toLowerCase(), to, value: `0x${parseEther(String(valueUsdc)).toString(16)}`, input, chainId: '0x13b2' },
    receipt: { status, blockNumber: '0xf0' },
  });
  return hash;
}

// Calls a handler the way Vercel does: parsed JSON body, Node-style response.
async function call(handler, method, body) {
  const out = { status: 0, headers: {}, body: '' };
  const res = {
    set statusCode(v) {
      out.status = v;
    },
    setHeader: (k, v) => (out.headers[k.toLowerCase()] = v),
    end: (b) => (out.body = b),
  };
  await handler({ method, body }, res);
  return { status: out.status, json: JSON.parse(out.body || '{}'), headers: out.headers };
}

async function session(wallet, seconds = 3600) {
  const expires = Math.floor(Date.now() / 1000) + seconds;
  const signature = await wallet.signMessage(config.sessionMessage(wallet.address, expires));
  return { address: wallet.address, expires, signature };
}

// ---------- rules ----------
test('prompt rules: uncensored, except minors and real people', () => {
  const allowed = [
    'a doge astronaut on the moon, glossy 3D',
    'nude portrait of a woman, oil painting',
    'a Sexy Space Pirate on a ship',
    'kids playing soccer in the park',
    'a kid reading a comic strip',
    'portrait of Taylor Swift as a doge',
  ];
  const refused = [
    'sexy teen girl',
    'sexy 16 year old',
    's3xy k1d',
    'nsfw l0li',
    'kid in a swimsuit at the beach',
    'lolicon art',
    'nude portrait of Taylor Swift',
    'nude portrait of taylor swift',
    'naked photo of my ex',
    'sexy Jane Doe in bikini',
  ];
  for (const p of allowed) assert.equal(checkPrompt(p).ok, true, p);
  for (const p of refused) assert.equal(checkPrompt(p).ok, false, p);
  assert.equal(checkPrompt('').ok, false);
  assert.equal(checkPrompt('x'.repeat(config.MAX_PROMPT_CHARS + 1)).ok, false);
  // every sexual prompt also steers the model away from anyone young-looking
  assert.match(checkPrompt('nude portrait of a woman').negative, /child/);
  assert.equal(checkPrompt('a doge on the moon').negative, '');
});

test('prices: packs and pay-as-you-go', () => {
  assert.equal(config.creditsFor(parseEther('0.25')), 1);
  assert.equal(config.creditsFor(parseEther('2')), 10);
  assert.equal(config.creditsFor(parseEther('8')), 50);
  assert.equal(config.creditsFor(parseEther('1')), 4);
  assert.equal(config.creditsFor(parseEther('0.2')), 0);
  // every model costs the buyer at least 2.5x what Venice charges, even at the 50-pack rate
  const cheapest = 8 / 50;
  for (const m of config.MODELS) assert.ok(m.credits * cheapest >= 2.5 * m.veniceUsd, m.id);
});

test('sign-in: only the wallet itself, for at most 7 days', async () => {
  const w = Wallet.createRandom();
  assert.equal(verifySession(await session(w)).ok, true);
  const other = Wallet.createRandom();
  const forged = { ...(await session(other)), address: w.address };
  assert.equal(verifySession(forged).ok, false);
  assert.equal(verifySession(await session(w, -10)).ok, false);
  assert.equal(verifySession(await session(w, 8 * 24 * 3600)).ok, false);
});

// ---------- endpoints ----------
test('quote: says where to pay, and closes when Venice runs low', async () => {
  const r = await call(quote, 'GET');
  assert.equal(r.status, 200);
  assert.equal(r.json.available, true);
  assert.equal(r.json.payee, config.PAYEE);
  assert.equal(r.json.memo, config.MEMO);
  assert.deepEqual(r.json.packs.map((p) => p.credits), [1, 10, 50]);
  assert.equal(r.headers['cache-control'], 'no-store');
  process.env.AI_FAKE_BALANCE = '1';
  const low = await call(quote, 'GET');
  delete process.env.AI_FAKE_BALANCE;
  assert.equal(low.json.available, false);
  assert.match(low.json.reason, /break/);
});

test('credits: only real AI payments from that wallet count', async () => {
  const w = Wallet.createRandom();
  const good = pay(w.address, '2');
  const bad = [
    pay(w.address, '2', { input: '0x' }), // no memo
    pay(w.address, '2', { to: '0x000000000000000000000000000000000000dead' }),
    pay(w.address, '2', { status: '0x0' }),
    pay(Wallet.createRandom().address, '2'), // someone else paid
    pay(w.address, '0.1'),
    '0x' + 'ab'.repeat(32), // not mined
  ];
  const r = await call(credits, 'POST', { address: w.address, txs: [good, ...bad] });
  assert.equal(r.status, 200);
  assert.equal(r.json.credits, 10);
  assert.equal(r.json.problems.length, bad.length);
  assert.equal(r.json.problems.find((p) => p.hash === bad.at(-1)).retry, true);
  // registered: later reads need no tx list
  assert.equal((await call(credits, 'POST', { address: w.address })).json.credits, 10);
});

test('generate: spends credits for an image, and never on a failure', async () => {
  const w = Wallet.createRandom();
  const s = await session(w);
  await call(credits, 'POST', { address: w.address, txs: [pay(w.address, '2')] });

  const one = await call(generate, 'POST', { ...s, model: 'fast', prompt: 'a doge astronaut' });
  assert.equal(one.status, 200, JSON.stringify(one.json));
  assert.match(one.json.url, /\/ai\/images\/[0-9a-f]{64}\.webp$/);
  assert.equal(one.json.credits, 9);

  const premium = await call(generate, 'POST', { ...s, model: 'premium', prompt: 'a golden doge statue' });
  assert.equal(premium.json.spent, 3);
  assert.equal(premium.json.credits, 6);

  // refused before anything is spent
  assert.equal((await call(generate, 'POST', { ...s, model: 'fast', prompt: 'sexy teen girl' })).status, 422);
  assert.equal((await call(generate, 'POST', { ...s, model: 'nope', prompt: 'a doge' })).status, 400);
  // the image failed or Venice refused it: the credit comes back
  process.env.AI_FAKE_FAIL = '1';
  assert.equal((await call(generate, 'POST', { ...s, model: 'fast', prompt: 'a doge' })).status, 502);
  delete process.env.AI_FAKE_FAIL;
  process.env.AI_FAKE_REFUSE = '1';
  assert.equal((await call(generate, 'POST', { ...s, model: 'fast', prompt: 'a doge' })).status, 422);
  delete process.env.AI_FAKE_REFUSE;
  assert.equal((await call(credits, 'POST', { address: w.address })).json.credits, 6);

  // someone else's signature, or none, spends nothing
  const thief = await session(Wallet.createRandom());
  assert.equal((await call(generate, 'POST', { ...thief, address: w.address, model: 'fast', prompt: 'a doge' })).status, 401);
  assert.equal((await call(generate, 'POST', { address: w.address, model: 'fast', prompt: 'a doge' })).status, 401);

  const images = await call(historyApi, 'POST', s);
  assert.equal(images.json.images.length, 2);
  assert.equal(images.json.images[0].url, premium.json.url); // newest first
});

test('generate: parallel requests never spend the same credit twice', async () => {
  const w = Wallet.createRandom();
  const s = await session(w);
  await call(credits, 'POST', { address: w.address, txs: [pay(w.address, '1')] }); // 4 credits
  const results = await Promise.all(
    Array.from({ length: 7 }, (_, i) => call(generate, 'POST', { ...s, model: 'fast', prompt: `a doge, take ${i}` }))
  );
  assert.equal(results.filter((r) => r.status === 200).length, 4);
  assert.equal(results.filter((r) => r.status === 402).length, 3);
  assert.equal((await call(credits, 'POST', { address: w.address })).json.credits, 0);
  // more credits from a second payment are used once the first runs out
  await call(credits, 'POST', { address: w.address, txs: [pay(w.address, '0.25')] });
  assert.equal((await call(generate, 'POST', { ...s, model: 'fast', prompt: 'one more' })).status, 200);
  assert.equal((await call(generate, 'POST', { ...s, model: 'fast', prompt: 'too many' })).status, 402);
});

test("generate: the daily limit stops images, and keeps the buyer's credits", async () => {
  const w = Wallet.createRandom();
  const s = await session(w);
  await call(credits, 'POST', { address: w.address, txs: [pay(w.address, '0.25')] });
  const store = getStore();
  const day = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < 40; i++) await store.put(`ai/daily/${day}/fill-${i}.json`, '{}', { overwrite: true });
  const r = await call(generate, 'POST', { ...s, model: 'fast', prompt: 'a doge' });
  assert.equal(r.status, 503);
  assert.equal((await call(credits, 'POST', { address: w.address })).json.credits, 1);
});
