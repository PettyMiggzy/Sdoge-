import fs from 'node:fs';

const BLOCKLIST_URL = new URL('../moderation/blocklist.json', import.meta.url);

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 6: 'g', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'i', '|': 'l' };

const NAME_RE = /^[A-Za-z0-9 .,'!&$-]{2,32}$/;
const SYMBOL_RE = /^[A-Za-z0-9]{2,10}$/;
// Descriptions get the same treatment as names: printable ASCII only, so no
// homoglyphs, combining marks, fillers or other lookalike tricks.
const DESC_RE = /^[\x20-\x7E]*$/;
// A superset of what Telegram turns into clickable links (TDLib find_urls,
// find_tg_urls, find_mentions):
// - any scheme:// (http, tg, ton, tonsite, ...);
// - any "x.yy" with no space around the dot, which is every TLD and IDN
//   domain ("e.g.", "v2.0" and "boy. Much wow" stay allowed);
// - bare IPv4, @handles, emails and phone numbers.
const LINK_RE = /([a-z][a-z0-9+.-]*:\/\/|[^\s.][.。．｡]\p{L}{2}|\b\d{1,3}(?:\.\d{1,3}){3}\b|@[a-z0-9_]{3,}|\b[\w.+-]+@[\w-]+\.[\w.]+\b|(\d[\s-]?){7,})/iu;
// Control chars, zero-width, bidi overrides and every other default-ignorable
// code point (U+034F, U+17B4, U+FE0F, U+3164...): used to disguise text.
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

export function loadBlocklist() {
  return JSON.parse(fs.readFileSync(BLOCKLIST_URL, 'utf8'));
}

const leet = (s) => s.toLowerCase().replace(/[0-9@$!|]/g, (c) => LEET[c] ?? c);
// '1' and '|' also read as 'l' (Circ1e, |oli).
const leetL = (s) => leet(s.toLowerCase().replace(/[1|]/g, 'l'));
const collapse = (s) => s.replace(/(.)\1+/g, '$1');
const words = (s) => s.split(/[^a-z0-9]+/).filter(Boolean);
const squash = (s) => s.replace(/[^a-z0-9]/g, '');

function wordHit(token, term) {
  if (token === term) return true;
  const c = collapse(term);
  return collapse(token) === c && token !== c;
}

// Words, plus spaced-out or dotted letters joined back up ("L O L I",
// "K.I.K.E"): runs of two or more 1-2 character tokens.
function pieces(v) {
  const ws = words(v);
  const out = [...ws];
  let run = [];
  for (const w of [...ws, '']) {
    if (w && w.length <= 2) {
      run.push(w);
      continue;
    }
    if (run.length >= 2) out.push(run.join(''));
    run = [];
  }
  return out;
}

function scan(text, list) {
  const hits = new Set();
  const allow = list.allow ?? [];
  const partTerms = new Set(Object.values(list.part ?? {}).flat());
  // Allowlisted words are cut out, and a piece that is just the start of one
  // (the ticker PEDOM for Pedometer) is left alone, unless the piece is itself
  // a blocked term ("pedo", "loli").
  const unallowed = (s) => (s.length >= 4 && !partTerms.has(s) && allow.some((ok) => ok.startsWith(s))
    ? ''
    : allow.reduce((acc, ok) => acc.split(ok).join('-'), s));
  for (const v of [text.toLowerCase(), leet(text), leetL(text)]) {
    const ws = words(v);
    for (const [category, terms] of Object.entries(list.word ?? {})) {
      if (terms.some((t) => ws.some((w) => wordHit(w, t)))) hits.add(category);
    }
    // 'part' terms: anywhere inside a word or a run of spaced-out letters
    // (LoliDoge, PedoMoon, HitlerCoin, N A Z I), minus allowlisted words.
    const ps = pieces(v).map(unallowed);
    for (const [category, terms] of Object.entries(list.part ?? {})) {
      if (terms.some((t) => ps.some((p) => p.includes(t)))) hits.add(category);
    }
    const flat = unallowed(squash(v));
    for (const [category, terms] of Object.entries(list.sub ?? {})) {
      if (terms.some((t) => flat.includes(t))) hits.add(category);
    }
  }
  return [...hits];
}

// Every way a name or ticker might be read: with a leading "$" dropped or all
// "$" dropped (not only as "s": "$USDC" must not become "susdc"), and with
// leetspeak read both ways (1 as i and as l).
function readings(x) {
  const lower = x.toLowerCase();
  const bases = [lower, lower.replace(/^\$+/, ''), lower.replace(/\$/g, '')];
  return [...new Set(bases.flatMap((b) => [b, leet(b), leetL(b)]))];
}

function isReserved(x, list) {
  const reserved = new Set(list.reserved ?? []);
  const reservedWord = list.reservedWord ?? [];
  return readings(x).some((f) => {
    const sq = squash(f);
    // The whole name or ticker, also with trailing digits dropped (USDC2, ETH2).
    if (reserved.has(sq) || reserved.has(sq.replace(/\d+$/, ''))) return true;
    // Brand words anywhere, or as a prefix (Circle USDC, USDC Rewards, USDCR).
    return [sq, ...words(f)].some((w) => reservedWord.some((t) => w.startsWith(t)));
  });
}

// Local, instant, free checks. Returns the reasons a user can be told.
export function checkText({ name, symbol, description = '' }, list = loadBlocklist()) {
  const reasons = [];

  if (!NAME_RE.test(name) || !/[A-Za-z]/.test(name) || name !== name.trim() || /\s{2,}/.test(name)) {
    reasons.push('Name must be 2-32 characters: letters, numbers, spaces and . , \' ! & $ -');
  }
  if (!SYMBOL_RE.test(symbol) || !/[A-Za-z]/.test(symbol)) {
    reasons.push('Ticker must be 2-10 letters/numbers with at least one letter.');
  }
  if (description.length > 200) reasons.push('Description must be 200 characters or fewer.');
  if (INVISIBLE_RE.test(name + symbol + description)) reasons.push('Hidden or control characters are not allowed.');
  else if (!DESC_RE.test(description)) reasons.push('Description must be plain English letters, numbers and punctuation (no emoji or special characters).');
  if (LINK_RE.test(`${name} ${symbol} ${description}`)) {
    reasons.push('No links, domains, @handles, emails or phone numbers. Share socials after launch instead.');
  }
  if (isReserved(symbol, list) || isReserved(name, list)) {
    reasons.push('That name or ticker belongs to an existing asset or project and can\'t be reused.');
  }
  const categories = scan(`${name} ${symbol} ${description}`, list);
  if (categories.length) reasons.push(`Not allowed on this launchpad (${categories.join(', ')}).`);

  return { ok: reasons.length === 0, reasons, categories };
}

// Telegram's own parser, for wizard input: any link-like entity it found.
const LINK_ENTITIES = new Set(['url', 'text_link', 'mention', 'text_mention', 'email', 'phone_number']);
export const hasLinkEntity = (m) => [...(m?.entities ?? []), ...(m?.caption_entities ?? [])].some((e) => LINK_ENTITIES.has(e.type));

const SYSTEM_PROMPT = `You moderate new meme-token launches for a public Telegram bot. Telegram bans bots that publish:
sexual content or nudity; ANY sexual or suggestive content involving minors; graphic gore; promotion of terrorism or violent extremism; hate speech or slurs aimed at protected groups; offers to sell drugs, weapons or illegal services; doxxing or someone's personal data; scams and phishing, including impersonating a real company, exchange, stablecoin or official project (e.g. posing as USDC, Circle, Tether, Coinbase, Binance, or an "official airdrop").
Block ANY link, domain name, IP address, tg:// or ton:// link, @handle, email, phone number or other contact detail, however it is written (spaced out, "dot" spelled out, lookalike letters, in the name or in the image text): the launch channel carries no links.
Ordinary meme-coin content is FINE: cartoon animals, silly or crude humor, crypto slang, parody of public figures without hate, mild cartoon violence, profanity that isn't a slur.
Judge the token name, ticker, description and image together. Reply with ONLY a JSON object:
{"verdict":"allow"|"block"|"review","categories":["sexual"|"minors"|"violence"|"hate"|"extremism"|"illegal"|"personal_data"|"scam"|"impersonation"|"link"|"other"],"reason":"<one short sentence>"}
Use "block" only for clear violations, "review" when genuinely unsure, otherwise "allow".`;

const VERDICTS = new Set(['allow', 'block', 'review']);

export function parseVerdict(content) {
  const text = String(content ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  let obj;
  try { obj = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!VERDICTS.has(obj?.verdict)) return null;
  return {
    verdict: obj.verdict,
    categories: Array.isArray(obj.categories) ? obj.categories.map(String).slice(0, 10) : [],
    reason: String(obj.reason ?? '').slice(0, 300),
  };
}

// Vision-model review via Venice's OpenAI-compatible API. Any failure is
// "review", never "allow": an outage must not let unscreened images through.
export class VeniceModerator {
  constructor({ apiKey, model, timeoutMs = 30000, fetchImpl = fetch }) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async review({ name, symbol, description, image }) {
    const content = [{ type: 'text', text: `Token name: ${name}\nTicker: ${symbol}\nDescription: ${description || '(none)'}\n${image ? 'Image attached.' : 'No image.'}` }];
    if (image) content.push({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.buffer.toString('base64')}` } });
    try {
      const res = await this.fetch('https://api.venice.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          max_tokens: 400,
          // The default vision model reasons first; left on, it can spend the
          // whole token budget thinking and never emit the verdict.
          venice_parameters: { include_venice_system_prompt: false, disable_thinking: true },
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content }],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return { verdict: 'review', categories: [], reason: `moderation service HTTP ${res.status}` };
      const body = await res.json();
      return parseVerdict(body?.choices?.[0]?.message?.content)
        ?? { verdict: 'review', categories: [], reason: 'unreadable moderation response' };
    } catch (e) {
      return { verdict: 'review', categories: [], reason: `moderation service error: ${e.name}` };
    }
  }
}

// Full pre-launch check. Nothing reaches the chain unless this says allow or
// review, and nothing is published without either a model "allow" or an admin.
export async function moderateLaunch(draft, { list, llm }) {
  const text = checkText(draft, list);
  if (!text.ok) return { verdict: 'block', stage: 'text', reasons: text.reasons, categories: text.categories };
  // No model: nothing is auto-approved. The launch still goes live on-chain,
  // but an admin reviews it before anything is posted publicly.
  if (!llm) {
    return { verdict: 'review', stage: draft.image ? 'image' : 'text', reasons: ['Automatic screening is off, so an admin reviews every launch.'], categories: [] };
  }
  const r = await llm.review(draft);
  return { verdict: r.verdict, stage: 'llm', reasons: r.reason ? [r.reason] : [], categories: r.categories };
}
