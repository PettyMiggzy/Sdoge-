import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VeniceModerator, checkText, hasLinkEntity, loadBlocklist, moderateLaunch, parseVerdict } from '../src/moderation.js';

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

test('moderateLaunch: local rules first, then the model; no model means every launch waits for review', async () => {
  const blocked = await moderateLaunch({ name: 'Tether', symbol: 'USDT', description: '', image: null }, { list, llm: null });
  assert.equal(blocked.verdict, 'block');
  assert.equal(blocked.stage, 'text');

  const img = { buffer: Buffer.from('x'), mime: 'image/jpeg' };
  assert.equal((await moderateLaunch({ name: 'Cap Doge', symbol: 'CAPD', description: '', image: img }, { list, llm: null })).verdict, 'review');
  assert.equal((await moderateLaunch({ name: 'Cap Doge', symbol: 'CAPD', description: '', image: null }, { list, llm: null })).verdict, 'review', 'text-only launches are never auto-approved either');

  let called = false;
  const llm = { review: async () => { called = true; return { verdict: 'block', categories: ['scam'], reason: 'no' }; } };
  const r = await moderateLaunch({ name: 'Tether', symbol: 'USDT', description: '', image: null }, { list, llm });
  assert.equal(r.stage, 'text');
  assert.equal(called, false, 'model is not called when local rules already block');
});

// ---------------------------------------------------------------- R2-TGPAD-04
// Every string the round-2 auditors got past the local rules
// (work2/r2-tgpad-04-verify), plus variants their proposed fix still missed.
const BYPASSES = [
  ['a', 'LoliDoge', 'LD', ''], ['a', 'PedoMoon', 'PMN', ''], ['a', 'JailbaitInu', 'JBI', ''], ['a', 'PreteenCoin', 'PTC', ''],
  ['a', 'UnderageDoge', 'UAD', ''], ['a', 'KikeCoin', 'KKC', ''], ['a', 'RetardDoge', 'RTD', ''], ['a', 'TrannyMoon', 'TRM', ''],
  ['a', 'Retarded Doge', 'RDG', ''], ['a', 'NaziDoge', 'NZD', ''], ['a', 'HitlerCoin', 'HTC', ''], ['a', 'Hitlers Army', 'HTA', ''],
  ['b', 'L O L I Doge', 'LLD', ''], ['b', 'N A Z I Coin', 'NZC', ''], ['b', 'K.I.K.E', 'KIKX', ''], ['b', 'LO LI Doge', 'LLD', ''],
  ['c', 'N!gger Doge', 'NGD', ''], ['c', 'Ni99er Coin', 'NNC', ''], ['c', 'Ni66a Coin', 'NSC', ''],
  ['d', 'Moon Doge', 'MD', 'nіgger coin'], ['d', 'Moon Doge', 'MD', 'lоli роrn'],
  ['d', 'Moon Doge', 'MD', 'оfficial аirdrop'], ['d', 'Moon Doge', 'MD', 'νazi'],
  ['e', 'Moon Doge', 'MD', 'lo͏li doge'], ['e', 'Moon Doge', 'MD', 'lo឴li doge'], ['e', 'Moon Doge', 'MD', 'lo️li doge'],
  ['e', 'Moon Doge', 'MD', 'loㅤli doge'], ['e', 'Moon Doge', 'MD', 'l̷o̷l̷i̷ doge'],
  ['f', 'Circle USDC', 'USDC2', ''], ['f', 'USDC Rewards', 'USDCR', ''], ['f', 'Tether Gold', 'XAUT', ''], ['f', 'USD Coin', 'USDC2', ''],
  ['g', '$USDC', 'USDC2', 'Official Circle holder rewards'], ['g', '$Circle', 'CRC', ''], ['g', '$Tether', 'TTH', ''],
  ['g', '$Coinbase', 'CBS', ''], ['g', '$ETH', 'ETH2', ''], ['g', '$SDOGE', 'SDOGE2', ''], ['g', 'Circ1e', 'CRCL', ''], ['g', '$U$DC', 'UUU', ''],
  ['link', 'Moon Doge', 'MD', 'claim your USDC bonus at usdc-refund.top'],
];

test('R2-TGPAD-04: every local-rule bypass the auditors found is blocked', () => {
  const passing = BYPASSES.filter(([, n, s, d]) => ok(n, s, d));
  assert.deepEqual(passing, []);
  assert.deepEqual(cats('PedoMoon', 'PMN'), ['minors']);
  assert.deepEqual(cats('N A Z I Coin', 'NZC'), ['extremism']);
});

test('R2-TGPAD-04: the reserved-name check sees through "$", digits and leetspeak', () => {
  for (const [name, symbol] of [['$USDC', 'USDC2'], ['Moon', 'USDC2'], ['Moon', 'ETH2'], ['Circ1e', 'CRCL'], ['C1rcle Pay', 'CPAY'], ['$ARC', 'ARCX']]) {
    const r = checkText({ name, symbol, description: '' }, list);
    assert.ok(r.reasons.some((x) => /existing asset/.test(x)), `${name}/${symbol}`);
  }
});

test('R2-TGPAD-04: benign names still pass (no Scunthorpe problem)', () => {
  for (const [n, s, d] of [
    ['Niger Delta Doge', 'NDD', ''], ['Scunthorpe Coin', 'SCUN', ''], ['Pedometer Coin', 'PEDOM', ''], ['Torpedo Doge', 'TORP', ''],
    ['Raccoon Club', 'RACC', ''], ['Cocoon Finance', 'CCN', ''], ['Arcade Doge', 'ARCD', ''], ['Ashkenazi Deli', 'DELI', ''],
    ['Fire Retardant Doge', 'FRD', ''], ['Crisis Doge', 'CRSD', 'buy the dip, e.g. now'], ['Bahamas Doge', 'BAHA', ''],
    ['Solo Lions', 'SOLO', 'a pride of lions'], ['Ski Kenya', 'SKI', 'go skiing'], ['Apes Do Go', 'ADG', 'ape do go moon'],
    ['Bitcoin Doge', 'BTCD', ''], ['Unicorn', 'UNIC', ''], ['Lollipop', 'LOLLY', 'sweet'], ['Doge On Arc', 'DOA', ''],
  ]) assert.ok(ok(n, s, d), `${n} ${d}: ${checkText({ name: n, symbol: s, description: d }, list).reasons}`);
});

test('R2-TGPAD-04: descriptions are printable ASCII, with no invisible characters', () => {
  for (const cp of [0x034f, 0x17b4, 0xfe0f, 0x3164, 0x200b, 0x202e]) {
    assert.ok(!ok('Moon Doge', 'MD', `lo${String.fromCodePoint(cp)}ve doge`), `U+${cp.toString(16)}`);
  }
  assert.ok(!ok('Moon Doge', 'MD', 'official site circlе'), 'Cyrillic lookalike');
  assert.ok(!ok('Moon Doge', 'MD', 'to the moon \u{1F680}'), 'emoji');
  assert.ok(ok('Moon Doge', 'MD', "to the moon! 100x, it's a dog's life (really)"));
});

// ---------------------------------------------------------------- R2-TGPAD-05
// fixtures/telegram-tlds.txt: the 1,297 TLDs Telegram's parser (TDLib 1.8.67
// is_common_tld) turns into clickable links.
const TLDS = fs.readFileSync(new URL('./fixtures/telegram-tlds.txt', import.meta.url), 'utf8').split('\n').filter(Boolean);

test('R2-TGPAD-05: a domain on any TLD Telegram links is blocked, in the description or as the name', () => {
  assert.equal(TLDS.length, 1297);
  const missed = TLDS.filter((t) => ok('Moon Doge', 'MOOND', `merch at moondoge.${t} soon`) || ok('Moon Doge', 'MOOND', `X.${t.toUpperCase()}`));
  assert.deepEqual(missed, []);
  for (const name of ['usdc-refund.top', 'ArcDrop.pro', 'circle-claim.ru', 'Moon.Doge']) assert.ok(!ok(name, 'MD'), name);
});

test('R2-TGPAD-05: tg://, ton://, IPv4, IDN lookalikes, handles, emails and phone numbers are blocked', () => {
  for (const d of [
    'support: tg://resolve?domain=UsdcRefundBot', 'TG://join?invite=abc', 'wallet help: ton://transfer/abc', 'tonsite://abc.ton',
    'dashboard 45.33.12.9/claim', '1.2.3.4', 'official site circlе.com', 'x.xn--p1ai', 'dm @usdc_support_bot',
    'mail support@usdc-help.xyz', 'call +1 555 123 4567', 'HTTPS://X.COM', 'telegram.me/x', 'www.moondoge',
  ]) assert.ok(!ok('Moon Doge', 'MD', d), d);
});

test('R2-TGPAD-05: ordinary prose with dots still passes', () => {
  for (const d of [
    'The goodest boy. Much wow. Very moon.', 'e.g. a doge, i.e. a dog', 'v2.0 is here, 3.14 pi doge', 'Dr. Doge, Ph.D. in memes',
    'wow...so moon', 'U.S.A. doge!', 'buy at 0.5, sell at 2.5', 'A.I. doge',
  ]) assert.ok(ok('Moon Doge', 'MD', d), d);
  assert.ok(ok('Moon Doge 2.0', 'MOON2'));
});

test('R2-TGPAD-05: Telegram\'s own link entities are refused, and the model is told to block links', async () => {
  assert.ok(hasLinkEntity({ text: 'x', entities: [{ type: 'url', offset: 0, length: 1 }] }));
  assert.ok(hasLinkEntity({ caption_entities: [{ type: 'mention', offset: 0, length: 1 }] }));
  assert.ok(!hasLinkEntity({ text: 'x', entities: [{ type: 'bold', offset: 0, length: 1 }] }));
  let sent;
  const m = new VeniceModerator({ apiKey: 'k', model: 'm', fetchImpl: async (u, init) => { sent = JSON.parse(init.body); return jsonRes(200, { choices: [{ message: { content: '{"verdict":"allow"}' } }] }); } });
  await m.review({ name: 'Moon Doge', symbol: 'MD', description: '', image: null });
  assert.match(sent.messages[0].content, /Block ANY link, domain name, IP address, tg:\/\/ or ton:\/\/ link, @handle/);
});
