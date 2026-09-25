// What Studio AI won't draw. The generator is otherwise uncensored (the owner's call), but two
// things are refused before anything is paid for or sent to the model:
// - sexual or suggestive images of minors, in any style;
// - sexual images of real people.
// It's a best-effort screen on the prompt: it errs toward refusing, and for any sexual prompt it
// also tells the model to stay away from anyone young-looking.

import { MAX_PROMPT_CHARS } from './config.mjs';
import { FAMOUS } from './famous.mjs';

const words = (list) => new RegExp(`\\b(?:${list.join('|')})\\b`, 'i');

// Children and teens, and words that sexualize youth.
const MINOR = words([
  'child', 'children', 'childlike', 'childish', 'kid', 'kids', 'kiddie', 'kiddy', 'minor', 'minors', 'underage', 'under-age', 'under age',
  'teen', 'teens', 'teenage', 'teenager', 'teenagers', 'preteen', 'pre-teen', 'tween', 'tweens', 'youngster', 'juvenile',
  'schoolgirl', 'schoolgirls', 'schoolboy', 'schoolboys', 'school girl', 'school boy', 'school uniform', 'little girl', 'little girls',
  'little boy', 'little boys', 'young girl', 'young girls', 'young boy', 'young boys', 'girl child', 'boy child',
  'baby', 'babies', 'toddler', 'toddlers', 'infant', 'infants', 'newborn', 'kindergarten', 'elementary school', 'grade school',
  'middle school', 'junior high', 'high school', 'highschool', 'high schooler', 'barely legal', 'jailbait', 'young-looking', 'young looking',
  'petite girl', 'little sister', 'little brother', 'daughter', 'son', 'stepdaughter', 'stepson', 'niece', 'nephew',
  'loli', 'lolis', 'lolita', 'lolicon', 'shota', 'shotas', 'shotacon', 'cub', 'cubs',
]);
// "12 year old", "15yo", "age 16", "16 y/o"
const MINOR_AGE = /\b(?:(?:[1-9]|1[0-7])\s*(?:-|\s)?\s*(?:yo|y\/o|y\.o\.|yrs?|years?)(?:\s*-?\s*old)?|age(?:d)?\s*(?:[1-9]|1[0-7]))\b/i;

// Always refused, whatever else the prompt says.
const ABUSE = words(['child porn', 'child pornography', 'csam', 'cp porn', 'pedo', 'pedophile', 'pedophilia', 'paedophile', 'lolicon', 'shotacon']);

const SEXUAL = words([
  'sex', 'sexy', 'sexual', 'sexually', 'sexualized', 'porn', 'porno', 'pornographic', 'explicit', 'xxx', 'nsfw', 'erotic', 'erotica',
  'hentai', 'ecchi', 'lewd', 'nude', 'nudes', 'nudity', 'naked', 'topless', 'bottomless', 'lingerie', 'underwear', 'panties', 'thong',
  'bra', 'bikini', 'swimsuit', 'seductive', 'seducing', 'sensual', 'provocative', 'suggestive', 'aroused', 'horny', 'kinky', 'fetish',
  'bdsm', 'bondage', 'spank', 'spanking', 'stripping', 'stripper', 'striptease', 'undress', 'undressed', 'undressing', 'breast', 'breasts',
  'boob', 'boobs', 'tits', 'titties', 'nipple', 'nipples', 'cleavage', 'penis', 'dick', 'cock', 'vagina', 'pussy', 'genital', 'genitals',
  'genitalia', 'butt', 'ass', 'booty', 'cum', 'orgasm', 'masturbate', 'masturbating', 'masturbation', 'blowjob', 'handjob',
  'intercourse', 'fuck', 'fucking', 'fucked', 'onlyfans', 'playboy', 'spread legs', 'bedroom eyes', 'wet t-shirt',
]);

// Signs the prompt is about a real, identifiable person.
const REAL_PERSON = words([
  'celebrity', 'celebrities', 'celeb', 'famous', 'actress', 'actor', 'singer', 'rapper', 'pop star', 'popstar', 'musician',
  'politician', 'president', 'prime minister', 'senator', 'congressman', 'congresswoman', 'governor', 'mayor',
  'influencer', 'streamer', 'youtuber', 'tiktoker', 'instagram model', 'twitch', 'real person', 'real people', 'real woman',
  'real man', 'real girl', 'deepfake', 'deep fake', 'look-alike', 'lookalike', 'my ex', 'my girlfriend', 'my boyfriend', 'my wife',
  'my husband', 'my coworker', 'my co-worker', 'my boss', 'my teacher', 'my classmate', 'my neighbor', 'my neighbour', 'my friend',
  'my crush', 'my sister', 'my brother', 'my mom', 'my mother', 'photo of her', 'photo of him',
]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FAMOUS_RE = new RegExp(`(?:^|[^a-z])(?:${FAMOUS.map(escapeRe).join('|')})(?![a-z])`, 'i');
// Capitalized words that are common in art prompts and aren't names.
const NOT_NAMES = new Set(
  ('Space Doge Sdoge Studio Arc Moon Mars Cyber Neon Retro Pixel Anime Manga Cartoon Comic Style Art Portrait Photo Photograph ' +
    'Realistic Fantasy Epic Dark Light Golden Blue Red Green Black White Pink Purple Orange Yellow Silver Gold King Queen Prince ' +
    'Princess Knight Wizard Warrior Samurai Viking Pirate Ninja Robot Dragon Shiba Inu Dog Cat Bear Wolf Fox Lion Tiger Ape Monkey ' +
    'Frog Pepe Crypto Bitcoin Ethereum Usdc Nft Web Ghibli Pixar Disney Marvel Renaissance Baroque Gothic Steampunk Cyberpunk ' +
    'Vaporwave Synthwave Lofi Chill Beach City Street Forest Mountain Ocean Sunset Sunrise Night Day Galaxy Universe Planet Earth ' +
    'Rocket Astronaut Sexy Hot Beautiful Cute Pretty Gorgeous Stunning Handsome Busty Naked Nude Big Huge Tall Thick Curvy Slim ' +
    'Muscular Elegant Evil Angry Happy Cool Futuristic Ancient Magical Mystic Mysterious Glowing Shiny Giant Super Mega Ultra ' +
    'Alien Demon Angel Goddess God Witch Vampire Elf Fairy Mermaid Succubus Nurse Maid Police Officer Doctor Lady Woman Man ' +
    'Girl Boy Warrioress Empress Emperor Cowgirl Cowboy Biker Punk Goth Gamer Hacker Queen Masterpiece Ultra Hd Hdr Octane Unreal ' +
    'Engine Trending Artstation').split(' ')
);
const isCap = (w) => /^[A-Z][a-z'-]+$/.test(w);

// Two capitalized words in a row mid-sentence, like a first and last name ("Taylor Swift"). A
// sentence's first word is capitalized for grammar, so it doesn't count.
function namesIn(prompt) {
  const out = [];
  for (const sentence of prompt.split(/[.!?;:\n]+/)) {
    const words = sentence.trim().split(/\s+/).map((w) => w.replace(/[^A-Za-z'-]/g, ''));
    for (let i = 1; i + 1 < words.length; i++) {
      const [a, b] = [words[i], words[i + 1]];
      if (isCap(a) && isCap(b) && !(NOT_NAMES.has(a) && NOT_NAMES.has(b))) out.push(`${a} ${b}`);
    }
  }
  return out;
}

// Letters people swap in to dodge filters: l0li, k1d, s3x.
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
const deLeet = (s) => s.replace(/[013457@$]/g, (ch) => LEET[ch]);

/** The negative prompt added to every sexual prompt. */
export const YOUTH_NEGATIVE = 'child, children, minor, underage, teen, young-looking, childlike, school uniform, small body';

/**
 * { ok: true, prompt, negative } when the prompt can be drawn (negative is the extra negative
 * prompt, or ''), or { ok: false, reason } when it's refused.
 */
export function checkPrompt(raw) {
  const prompt = String(raw ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!prompt) return { ok: false, reason: 'Describe the image you want.' };
  if (prompt.length > MAX_PROMPT_CHARS) return { ok: false, reason: `Keep it under ${MAX_PROMPT_CHARS} characters.` };
  const variants = [prompt, deLeet(prompt), prompt.replace(/[._*\-]/g, ''), deLeet(prompt.replace(/[._*\-]/g, ''))];
  const any = (re) => variants.some((v) => re.test(v));

  if (any(ABUSE)) return { ok: false, reason: "That isn't allowed: nothing sexual involving minors, ever." };
  const sexual = any(SEXUAL);
  const minor = any(MINOR) || any(MINOR_AGE);
  if (sexual && minor) return { ok: false, reason: "That isn't allowed: nothing sexual or suggestive involving minors." };
  if (sexual && (any(REAL_PERSON) || any(FAMOUS_RE) || namesIn(prompt).length > 0)) {
    return { ok: false, reason: "That isn't allowed: no sexual images of real people. Leave out real people's names." };
  }
  return { ok: true, prompt, negative: sexual ? YOUTH_NEGATIVE : '' };
}
