import fs from 'node:fs';

const BLOCKLIST_URL = new URL('../moderation/blocklist.json', import.meta.url);

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

const NAME_RE = /^[A-Za-z0-9 .,'!&$-]{2,32}$/;
const SYMBOL_RE = /^[A-Za-z0-9]{2,10}$/;
const LINK_RE = /(https?:\/\/|www\.|t\.me\/|telegram\.(me|dog)|\b[a-z0-9-]+\.(com|io|xyz|org|net|app|me|gg|co|fi|finance|money|site|online|link|ly|to|dev|ai|fun|live|club|vip|cc|tv|info|biz)\b|@[a-z0-9_]{4,}|\b[\w.+-]+@[\w-]+\.[\w.]+\b|(\d[\s-]?){7,})/i;
// Control chars, zero-width and bidi overrides: used to disguise text.
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export function loadBlocklist() {
  return JSON.parse(fs.readFileSync(BLOCKLIST_URL, 'utf8'));
}

const leet = (s) => s.toLowerCase().replace(/[013457@$]/g, (c) => LEET[c]);
const collapse = (s) => s.replace(/(.)\1+/g, '$1');
const words = (s) => s.split(/[^a-z0-9]+/).filter(Boolean);
const squash = (s) => s.replace(/[^a-z0-9]/g, '');

function wordHit(token, term) {
  if (token === term) return true;
  const c = collapse(term);
  return collapse(token) === c && token !== c;
}

function scan(text, list) {
  const hits = new Set();
  const variants = [text.toLowerCase(), leet(text)];
  for (const v of variants) {
    const ws = words(v);
    for (const [category, terms] of Object.entries(list.word)) {
      if (terms.some((t) => ws.some((w) => wordHit(w, t)))) hits.add(category);
    }
    const flat = squash(v);
    for (const [category, terms] of Object.entries(list.sub)) {
      if (terms.some((t) => flat.includes(t))) hits.add(category);
    }
  }
  return [...hits];
}

// Local, instant, free checks. Returns the reasons a user can be told.
export function checkText({ name, symbol, description = '' }, list = loadBlocklist()) {
  const reasons = [];
  const reserved = new Set(list.reserved);

  if (!NAME_RE.test(name) || !/[A-Za-z]/.test(name) || name !== name.trim() || /\s{2,}/.test(name)) {
    reasons.push('Name must be 2-32 characters: letters, numbers, spaces and . , \' ! & $ -');
  }
  if (!SYMBOL_RE.test(symbol) || !/[A-Za-z]/.test(symbol)) {
    reasons.push('Ticker must be 2-10 letters/numbers with at least one letter.');
  }
  if (description.length > 200) reasons.push('Description must be 200 characters or fewer.');
  if (INVISIBLE_RE.test(name + symbol + description)) reasons.push('Hidden or control characters are not allowed.');
  if (LINK_RE.test(`${name} ${symbol} ${description}`)) {
    reasons.push('No links, @handles, emails or phone numbers. Share socials after launch instead.');
  }
  if (reserved.has(squash(leet(symbol))) || reserved.has(squash(leet(name)))) {
    reasons.push('That name or ticker belongs to an existing asset or project and can\'t be reused.');
  }
  const categories = scan(`${name} ${symbol} ${description}`, list);
  if (categories.length) reasons.push(`Not allowed on this launchpad (${categories.join(', ')}).`);

  return { ok: reasons.length === 0, reasons, categories };
}

const SYSTEM_PROMPT = `You moderate new meme-token launches for a public Telegram bot. Telegram bans bots that publish:
sexual content or nudity; ANY sexual or suggestive content involving minors; graphic gore; promotion of terrorism or violent extremism; hate speech or slurs aimed at protected groups; offers to sell drugs, weapons or illegal services; doxxing or someone's personal data; scams and phishing, including impersonating a real company, exchange, stablecoin or official project (e.g. posing as USDC, Circle, Tether, Coinbase, Binance, or an "official airdrop").
Ordinary meme-coin content is FINE: cartoon animals, silly or crude humor, crypto slang, parody of public figures without hate, mild cartoon violence, profanity that isn't a slur.
Judge the token name, ticker, description and image together. Reply with ONLY a JSON object:
{"verdict":"allow"|"block"|"review","categories":["sexual"|"minors"|"violence"|"hate"|"extremism"|"illegal"|"personal_data"|"scam"|"impersonation"|"other"],"reason":"<one short sentence>"}
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

// Full pre-launch check. Nothing reaches the chain unless this says allow or review.
export async function moderateLaunch(draft, { list, llm }) {
  const text = checkText(draft, list);
  if (!text.ok) return { verdict: 'block', stage: 'text', reasons: text.reasons, categories: text.categories };
  if (!llm) {
    return draft.image
      ? { verdict: 'review', stage: 'image', reasons: ['Automatic image screening is off; an admin will review it.'], categories: [] }
      : { verdict: 'allow', stage: 'text', reasons: [], categories: [] };
  }
  const r = await llm.review(draft);
  return { verdict: r.verdict, stage: 'llm', reasons: r.reason ? [r.reason] : [], categories: r.categories };
}
