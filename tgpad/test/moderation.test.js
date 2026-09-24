import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VeniceModerator, checkText, loadBlocklist, moderateLaunch, parseVerdict } from '../src/moderation.js';

const list = loadBlocklist();
const ok = (name, symbol, description = '') => checkText({ name, symbol, description }, list).ok;
const cats = (name, symbol, description = '') => checkText({ name, symbol, description }, list).categories;

test('ordinary meme names pass', () => {
  assert.ok(ok('Cap Doge', 'CAPD'));
  assert.ok(ok('Moon Doge 2.0', 'MOON2', 'the goodest boy on arc'));
  assert.ok(ok("Doge's Revenge!", 'DREV'));
});

test('no false positives on words that merely contain or collapse to a blocked term', () => {
  assert.ok(ok('Niger Delta Doge', 'NDD'), 'country name must not match an elongation rule');
  assert.ok(ok('Scunthorpe Coin', 'SCUN'));
  assert.ok(ok('Pedometer Coin', 'PEDOM'));
  assert.ok(ok('Raccoon Club', 'RACC'));
  assert.ok(ok('Cocoon Finance', 'CCN'));
  assert.ok(ok('Arcade Doge', 'ARCD'), 'reserved names only block exact matches');
});

test('slurs are caught including elongation and leetspeak', () => {
  assert.deepEqual(cats('Niiiigger Coin', 'NC'), ['hate']);
  assert.ok(!ok('N1gger Doge', 'ND'));
  assert.ok(!ok('F4ggot Moon', 'FM'));
  assert.ok(!ok('Moon', 'MOON', 'heil hitler lol'));
  assert.ok(!ok('Lolicon Doge', 'LOLD'));
});

test('impersonation of real assets and of SDOGE itself is blocked', () => {
  assert.ok(!ok('Tether', 'TTH'));
  assert.ok(!ok('Real Doge', 'USDC'));
  assert.ok(!ok('Stable Doge', 'STBL'));
  assert.ok(!ok('$DOGE', 'DG'), '"$DOGE" squashes to "sdoge"');
  assert.ok(!ok('Circle', 'CRCL'));
});

test('links, handles, emails and phone numbers are blocked everywhere', () => {
  assert.ok(!ok('Moon Doge', 'MD', 'join t.me/scamgroup'));
  assert.ok(!ok('Moon Doge', 'MD', 'see https://evil.example'));
  assert.ok(!ok('Moon Doge', 'MD', 'dm @realmoondoge'));
  assert.ok(!ok('Moon Doge', 'MD', 'visit moondoge.xyz'));
  assert.ok(!ok('Moon Doge', 'MD', 'mail me at a@b.co'));
  assert.ok(!ok('Moon Doge', 'MD', 'call 555 123 4567'));
});

test('format rules: charset, lengths, hidden characters', () => {
  assert.ok(!ok('D', 'DG'), 'name too short');
  assert.ok(!ok('x'.repeat(33), 'DG'), 'name too long');
  assert.ok(!ok('Doge​Coin', 'DG'), 'zero-width space');
  assert.ok(!ok('Doge', 'DG', 'nice‮text'), 'bidi override in description');
  assert.ok(!ok('Дoge', 'DG'), 'non-ASCII lookalike letters in name');
  assert.ok(!ok('Doge', 'D'), 'ticker too short');
  assert.ok(!ok('Doge', '12345'), 'ticker needs a letter');
  assert.ok(!ok('Doge', 'TOOLONGTICK'), 'ticker too long');
  assert.ok(!ok('Doge', 'DG', 'x'.repeat(201)), 'description too long');
});

test('parseVerdict tolerates fences and chatter but rejects unknown verdicts', () => {
  assert.equal(parseVerdict('```json\n{"verdict":"allow","categories":[],"reason":"fine"}\n```').verdict, 'allow');
  assert.equal(parseVerdict('Sure! {"verdict":"block","categories":["scam"],"reason":"x"} hope that helps').verdict, 'block');
  assert.equal(parseVerdict('{"verdict":"maybe"}'), null);
  assert.equal(parseVerdict(''), null);
  assert.equal(parseVerdict('no json here'), null);
});

function fakeFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return respond();
  };
  fn.calls = calls;
  return fn;
}

const jsonRes = (status, body) => ({ ok: status < 300, status, json: async () => body });

test('Venice moderator sends image + disables thinking, and parses the verdict', async () => {
  const fetchImpl = fakeFetch(() => jsonRes(200, { choices: [{ message: { content: '{"verdict":"allow","categories":[],"reason":"ok"}' } }] }));
  const m = new VeniceModerator({ apiKey: 'k', model: 'qwen-3-8-27b', fetchImpl });
  const r = await m.review({ name: 'Cap Doge', symbol: 'CAPD', description: '', image: { buffer: Buffer.from('img'), mime: 'image/jpeg' } });
  assert.equal(r.verdict, 'allow');
  const body = fetchImpl.calls[0].body;
  assert.equal(body.venice_parameters.disable_thinking, true);
  assert.equal(body.venice_parameters.include_venice_system_prompt, false);
  assert.equal(body.temperature, 0);
  const img = body.messages[1].content.find((c) => c.type === 'image_url');
  assert.equal(img.image_url.url, `data:image/jpeg;base64,${Buffer.from('img').toString('base64')}`);
});

test('any moderation failure becomes "review", never "allow"', async () => {
  const draft = { name: 'A B', symbol: 'AB', description: '', image: null };
  const http500 = new VeniceModerator({ apiKey: 'k', model: 'm', fetchImpl: fakeFetch(() => jsonRes(500, {})) });
  assert.equal((await http500.review(draft)).verdict, 'review');
  const junk = new VeniceModerator({ apiKey: 'k', model: 'm', fetchImpl: fakeFetch(() => jsonRes(200, { choices: [{ message: { content: '' } }] })) });
  assert.equal((await junk.review(draft)).verdict, 'review');
  const down = new VeniceModerator({ apiKey: 'k', model: 'm', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.equal((await down.review(draft)).verdict, 'review');
});

test('moderateLaunch: local rules first, then the model; no model means images wait for review', async () => {
  const blocked = await moderateLaunch({ name: 'Tether', symbol: 'USDT', description: '', image: null }, { list, llm: null });
  assert.equal(blocked.verdict, 'block');
  assert.equal(blocked.stage, 'text');

  const img = { buffer: Buffer.from('x'), mime: 'image/jpeg' };
  assert.equal((await moderateLaunch({ name: 'Cap Doge', symbol: 'CAPD', description: '', image: img }, { list, llm: null })).verdict, 'review');
  assert.equal((await moderateLaunch({ name: 'Cap Doge', symbol: 'CAPD', description: '', image: null }, { list, llm: null })).verdict, 'allow');

  let called = false;
  const llm = { review: async () => { called = true; return { verdict: 'block', categories: ['scam'], reason: 'no' }; } };
  const r = await moderateLaunch({ name: 'Tether', symbol: 'USDT', description: '', image: null }, { list, llm });
  assert.equal(r.stage, 'text');
  assert.equal(called, false, 'model is not called when local rules already block');
});
