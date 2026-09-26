// What Studio AI won't draw. The generator is otherwise uncensored (the owner's call), but two
// things are refused before anything is paid for or sent to the image model:
// - anything sexual, nude or suggestive involving minors, in any style;
// - sexual or nude images of real people.
//
// This file is the first of three checks: word lists, run on cleaned-up text (hidden characters
// removed, look-alike letters, leetspeak and spaced-out words undone). screen.mjs has two of
// Venice's text models read every prompt as well, which catches other languages and cues no word
// list can, and has vision models look at every image from an adult prompt before anyone sees
// it. decide() makes the final call: refused when any check sees a minor or a real person and any
// check sees nudity or sexual content. It errs toward refusing.

import { MAX_PROMPT_CHARS } from './config.mjs';
import { FAMOUS, FAMOUS_SHORT } from './famous.mjs';

// Whole words (or phrases) from a list of regex fragments, in lowercased ASCII-ish text.
const words = (list) => new RegExp(`(?<![a-z0-9])(?:${list.join('|')})(?![a-z0-9])`);

// Children and teens: words, school settings, and slang for sexualized youth.
const MINOR = words([
  'child(?:ren|ish|like|hood|s)?', 'kid(?:s|do|dos|die|dies|dy)?', 'kiddo(?:s)?', 'toddler(?:s)?', 'infant(?:s)?', 'newborn(?:s)?',
  'bab(?:y|ies)(?![\\s-]*(?:blue|pink|oil|powder|doll|dolls|shower|bump|boomer|boomers|shark|yoda|spinach|carrot|carrots|back))',
  'minor(?:s)?(?![\\s-]*(?:key|keys|chord|chords|detail|details|imperfection|imperfections|flaw|flaws|change|changes|edit|edits|tweak|tweaks|adjustment|adjustments|variation|variations|error|errors|injury|injuries|scratch|scratches|character|characters|league|role|roles|scale|scales|planet|planets|arcana|issue|issues|point|points|spoiler|spoilers|glitch|glitches|blemish|blemishes|damage|wear|crack|cracks))',
  'underage(?:d)?', 'under[\\s-]?age(?:d)?',
  'teen(?:s|age|aged|ager|agers|y|ie|ies)?', 'preteen(?:s)?', 'tween(?:s|ager|agers|ie|ies)?', 'youngster(?:s)?', 'juvenile(?:s)?',
  'adolescen(?:t|ts|ce)', '(?:pre)?pubescen(?:t|ts|ce)', 'puberty',
  'kindergart(?:en|ener|eners|ner|ners)', 'preschool(?:er|ers)?', 'nursery[\\s-]school', 'grade[\\s-]?school(?:er|ers)?',
  'elementary[\\s-]?school(?:er|ers)?', 'middle[\\s-]?school(?:er|ers)?', 'junior[\\s-]?high', 'high[\\s-]?school(?:er|ers)?',
  'school[\\s-]?(?:girl|girls|boy|boys|kid|kids|child|children|uniform|uniforms)',
  '(?:little|young|small|tiny|lil)[\\s-]+(?:girl|girls|boy|boys|one|ones|sister|sisters|brother|brothers|child|children|kid|kids)',
  'girl[\\s-]child', 'boy[\\s-]child', 'jailbait', 'barely[\\s-]legal',
  'loli(?:s|ta|tas|con)?', 'shota(?:s|con)?', 'randoseru', 'cub(?:s)?', '(?:girl|boy|cub)[\\s-]?scout(?:s)?',
  '(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|1st|2nd|3rd|[4-9]th|1[0-2]th)[\\s-]+grade(?:r|rs)?',
]);

// Ages under 18: "13 year old", "13-year-old", "13yo", "age 13", "aged thirteen", "girl, 17",
// "under 18".
const N = '(?:[1-9]|1[0-7]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)';
const MINOR_AGE = new RegExp(
  [
    `(?<![a-z0-9.])${N}[\\s-]*(?:(?:years?|yrs?)[\\s-]*old|yo|y\\/o|y\\.o\\.?)(?![a-z0-9])`,
    `(?<![a-z0-9])aged?[\\s:=-]*${N}(?![a-z0-9.])`,
    `(?<![a-z0-9])(?:girl|girls|boy|boys|teen|kid|daughter|son)[\\s,]+${N}(?![a-z0-9.])`,
    `(?<![a-z0-9.])${N}[\\s-]*(?:(?:years?|yrs?)[\\s-]*old[\\s-]*)?(?:girl|girls|boy|boys)(?![a-z0-9])`,
    `(?<![a-z0-9])(?:under|below|younger[\\s-]+than|not[\\s-]+(?:yet[\\s-]+)?)[\\s-]*(?:18|eighteen)(?![0-9])`,
    `(?<![a-z0-9])u18(?![a-z0-9])`,
  ].join('|'),
);

// Refused whatever else the prompt says.
const ABUSE = words(['child[\\s-]?porn(?:ography)?', 'csam', 'cp[\\s-]porn', 'pedo(?:s|phile|philes|philia|philic)?', 'paedo(?:s|phile|philes|philia)?', 'lolicon', 'shotacon', 'kiddie[\\s-]?porn']);

const SEXUAL = words([
  'sex(?:y|ier|iest|ual|ually|ualized|ualised|ualize|ualise|ualizing)?', 'porn(?:o|ographic|ography)?', 'explicit', 'xxx', 'nsfw', 'r18',
  'erotic(?:a|ism)?', 'hentai', 'ecchi', 'lewd', 'nud(?:e|es|ez|ie|ies|ity|ist|ists|ism)', 'nood(?:s|z)?', 'naked', 'nekkid',
  'unclothed', 'undress(?:ed|es|ing)?',
  'disrobe(?:d|s)?', 'topless', 'bottomless', 'no[\\s-]+clothes', 'without[\\s-]+(?:any[\\s-]+)?clothes', 'wearing[\\s-]+nothing',
  'clothes[\\s-]+off', 'in[\\s-]+the[\\s-]+buff', 'birthday[\\s-]+suit',
  'lingerie', 'underwear', 'undies', 'panties', 'panty', 'pantsu', 'thong(?:s)?', 'bra(?:s)?', 'bralette(?:s)?', 'bikini(?:s)?',
  'swimsuit(?:s)?', 'swimwear', 'bathing[\\s-]+suit(?:s)?', 'see[\\s-]?through', 'skimpy', 'scantily', 'revealing', 'boudoir',
  'pin[\\s-]?up', 'risque', 'sultry', 'steamy', 'seductive(?:ly)?', 'seduc(?:e|es|ing|tion)', 'sensual(?:ly)?',
  'provocative(?:ly)?', 'suggestive(?:ly)?', 'aroused', 'arousal', 'horny', 'kinky', 'fetish(?:es)?', 'bdsm', 'bondage',
  'spank(?:ed|ing|s)?', 'strip(?:ped|ping|per|pers|tease)', 'breast(?:s)?', 'boob(?:s|ies)?', 'tit(?:s|ty|ties)', 'nipple(?:s)?',
  'cleavage', 'areola(?:e|s)?', 'penis', 'dick(?:s)?', 'cock(?:s)?', 'vagina(?:l|s)?', 'pussy', 'vulva', 'genital(?:s|ia)?',
  'butt(?:ocks)?', 'ass', 'asses', 'booty', 'crotch', 'groin', 'cum(?:ming|shot)?', 'orgasm(?:s|ic)?', 'masturbat[a-z]*',
  'blow[\\s-]?job', 'hand[\\s-]?job', 'intercourse', 'fuck[a-z]*', 'onlyfans', 'playboy', 'spread[\\s-]+legs', 'upskirt',
  'camel[\\s-]?toe', 'panty[\\s-]?shot', 'ahegao', 'busty', 'thicc', 'wet[\\s-]+t[\\s-]?shirt', 'bedroom[\\s-]+eyes',
]);
const SEXUAL_EMOJI = /[\u{1F346}\u{1F351}\u{1F4A6}\u{1F445}\u{1F51E}]/u; // aubergine, peach, droplets, tongue, no-under-18

// Signs the prompt is about a real, identifiable person.
const REAL_PERSON = words([
  'celebrit(?:y|ies)', 'celeb(?:s)?', 'famous', 'actress', 'actor', 'singer', 'rapper', 'pop[\\s-]?star', 'musician', 'politician',
  'president', 'prime[\\s-]+minister', 'senator', 'congress(?:man|woman)', 'governor', 'mayor', 'influencer', 'streamer', 'youtuber',
  'tiktoker', 'instagram[\\s-]+model', 'twitch', 'real[\\s-]+(?:person|people|woman|women|man|men|girl|boy)', 'deep[\\s-]?fake(?:s)?',
  'look[\\s-]?alike', 'doppelganger', 'this[\\s-]+person', 'photo[\\s-]+of[\\s-]+(?:her|him)', 'picture[\\s-]+of[\\s-]+(?:her|him)',
  'my[\\s-]+(?:ex|gf|bf|girlfriend|boyfriend|wife|husband|coworker|co-worker|colleague|boss|teacher|student|classmate|neighbor|neighbour|friend|crush|sister|brother|mom|mother|dad|father|cousin|aunt|uncle|stepmom|stepsister|stepbrother|roommate|room[\\s-]mate|tenant|landlord|employee)',
  'roommate', 'coworker', 'classmate', 'neighbou?r',
]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FAMOUS_RE = words([...FAMOUS, ...FAMOUS_SHORT].map((n) => escapeRe(n).replace(/ /g, '[\\s-]+')));

// ---------- cleaning up the text before matching ----------

// Letters from other scripts that look like Latin ones (Cyrillic, Greek, small capitals), which
// people swap in to dodge word lists: "chіld" with a Cyrillic i.
const CONFUSABLE = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', ѕ: 's', і: 'i', ї: 'i',
  ј: 'j', ԁ: 'd', һ: 'h', ӏ: 'l', ɡ: 'g', ո: 'n', ս: 'u', ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ɢ: 'g', ʜ: 'h', ɪ: 'i', ᴊ: 'j',
  ᴋ: 'k', ʟ: 'l', ᴍ: 'm', ɴ: 'n', ᴏ: 'o', ᴘ: 'p', ʀ: 'r', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ʏ: 'y', ᴢ: 'z',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', μ: 'u', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', γ: 'y', ω: 'w',
};
const unconfuse = (s) => s.replace(/[^\x00-\x7f]/g, (ch) => CONFUSABLE[ch] ?? ch);
// Leetspeak: l0li, k1d, s3x, n00d (1 read as i and as l).
const LEET_I = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i', '|': 'l' };
const LEET_L = { ...LEET_I, 1: 'l' };
const deLeet = (s, map) => s.replace(/[013457@$!|]/g, (ch) => map[ch]);
// "n u d e", "n.u.d.e", "n-u-d-e": three or more single letters in a row become one word.
const SPELLED = /(?<![a-z0-9])(?:[a-z0-9][\s._*+~|\\/-]+){2,}[a-z0-9](?![a-z0-9])/g;
const joinSpelled = (s) => s.replace(SPELLED, (m) => m.replace(/[^a-z0-9]/g, ''));
// Spelled-out letters lose the spaces between words too ("s e x y t e e n" -> "sexyteen"), so
// those runs are also searched for the key words anywhere inside them.
const spelledRuns = (s) => (s.match(SPELLED) || []).map((m) => m.replace(/[^a-z0-9]/g, ''));
const SPELLED_SEXUAL = /sex|nud|nood|naked|porn|nsfw|hentai|lewd|topless|erotic|lingerie|bikini|panties|boob|tits|penis|vagina|pussy|fuck/;
const SPELLED_MINOR = /child|kid|teen|tween|loli|shota|minor|underage|toddler|infant|baby|schoolgirl|schoolboy|preteen|jailbait/;
// "lo-li", "pre_teen", "nu.de": separators inside a word go.
const unsplit = (s) => s.replace(/([a-z0-9])[._*+~|\\-]+(?=[a-z0-9])/g, '$1');

/** The prompt as it's shown to the checks and sent to the image model: no hidden characters. */
export function cleanPrompt(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/[\p{Cf}͏ᅟᅠㅤﾠ]/gu, '') // zero-width and other invisible characters
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every spelling of the prompt the word lists run on. */
function variants(prompt) {
  const base = unconfuse(prompt.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase());
  const out = new Set();
  for (const v of [base, deLeet(base, LEET_I), deLeet(base, LEET_L)]) {
    out.add(v);
    out.add(joinSpelled(v));
    out.add(unsplit(v));
    out.add(unsplit(joinSpelled(v)));
  }
  return [...out];
}

// A word mixing Latin letters with letters of another script, after the look-alikes are undone.
const mixedScript = (prompt) =>
  prompt
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .some((w) => {
      const u = unconfuse(w);
      return /\p{Script=Latin}/u.test(u) && /(?!\p{Script=Latin})\p{L}/u.test(u);
    });

/** The negative prompt added to every adult prompt, and to everything on the Uncensored model. */
export const YOUTH_NEGATIVE =
  'child, children, kid, minor, underage, teen, teenager, young-looking, childlike, youthful, loli, school uniform, small body, flat chest';

const MINOR_REASON = "That isn't allowed: nothing sexual, nude or suggestive involving minors.";
const REAL_REASON = "That isn't allowed: no sexual or nude images of real people. Leave out real people's names.";

/**
 * The word-list check. { ok: false, reason } when it refuses the prompt on its own, else
 * { ok: true, prompt, sexual, minor, realPerson, negative }: prompt is the cleaned-up text to send
 * on, and the flags are what the word lists saw, for decide().
 */
export function checkPrompt(raw) {
  const prompt = cleanPrompt(raw);
  if (!prompt) return { ok: false, reason: 'Describe the image you want.' };
  if (prompt.length > MAX_PROMPT_CHARS) return { ok: false, reason: `Keep it under ${MAX_PROMPT_CHARS} characters.` };
  if (mixedScript(prompt)) return { ok: false, reason: 'Write each word in one alphabet (no look-alike letters from other alphabets).' };

  const vs = variants(prompt);
  const any = (re) => vs.some((v) => re.test(v));
  const runs = vs.flatMap(spelledRuns);
  if (any(ABUSE)) return { ok: false, reason: "That isn't allowed: nothing sexual involving minors, ever." };
  const sexual = any(SEXUAL) || SEXUAL_EMOJI.test(prompt) || runs.some((r) => SPELLED_SEXUAL.test(r));
  const minor = any(MINOR) || any(MINOR_AGE) || runs.some((r) => SPELLED_MINOR.test(r));
  const realPerson = any(REAL_PERSON) || any(FAMOUS_RE);
  if (sexual && minor) return { ok: false, reason: MINOR_REASON };
  if (sexual && realPerson) return { ok: false, reason: REAL_REASON };
  return { ok: true, prompt, sexual, minor, realPerson, negative: sexual ? YOUTH_NEGATIVE : '' };
}

/**
 * The final call, from the word lists (checkPrompt's result) and the text models (screen.mjs's
 * screenPrompt): { ok: false, reason } or { ok: true, negative, checkImage }, where checkImage
 * means the finished image must pass the vision check before anyone sees it.
 */
export function decide(model, rules, screen) {
  const sexual = Boolean(rules.sexual || screen.sexual || screen.nudity);
  const minor = Boolean(rules.minor || screen.minor);
  const realPerson = Boolean(rules.realPerson || screen.realPerson);
  if (sexual && minor) return { ok: false, reason: MINOR_REASON };
  if (sexual && realPerson) return { ok: false, reason: REAL_REASON };
  if (model.id === 'uncensored' && minor) {
    return { ok: false, reason: "The Uncensored model doesn't draw children or teens at all. Pick another model for that." };
  }
  const adult = sexual || model.id === 'uncensored';
  return { ok: true, negative: adult ? YOUTH_NEGATIVE : '', checkImage: adult || model.id === 'anime' };
}
