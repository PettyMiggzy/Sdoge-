# Studio AI (`api/ai/*`)

"Create with AI" on the Studio page (`studio.html`, `assets/js/studio-ai.js`). These are Vercel
functions of the main site's project (`sdoge`, serving stabledoge.site).

## How it works

0. **18+.** The tools open only after the visitor clicks "I'm 18 or older" (remembered in that
   browser); until then they can't buy credits or make images.
1. **Buy credits.** The buyer pays native USDC on Arc to the owner's wallet (`AI_PAYEE`), with
   the memo `SDOGE Studio AI` as the transaction data. 1 credit is 0.25 USDC, 10 are 2 USDC and
   50 are 8 USDC. `POST /api/ai/credits` checks each payment on Arc (successful, to the payee,
   with the memo, from that wallet) and records it.
2. **Sign in.** Spending credits takes a wallet signature over a short message naming
   stabledoge.site, valid for a day. It costs nothing and sends nothing, but it stops anyone else
   from spending the credits.
3. **Create.** `POST /api/ai/generate` screens the prompt, spends the credits and asks Venice
   for a square image. Every image costs the buyer at least 2.5x what Venice charges; that
   difference is the owner's profit. The image goes into the site's public Blob store
   (`sdoge-studio-ai`) at a permanent link, ready for the Studio's 1-of-1 mint. The prompt isn't
   stored.

Credits are never spent on a refused prompt, a failure on this site's side, or a day that's hit
its limit. They ARE spent when Venice or the vision check blocks a finished image: Venice charged
for it, and a free retry would let anyone probe the checks at the owner's cost. Each credit is
its own file in the store, created without overwriting, so two requests can't spend the same
credit; a 3-credit image can draw on several payments. Each endpoint also limits how often one
address can call it.

## The prompt rules

The generator is uncensored, except for two hard blocks: nothing sexual, nude or suggestive
involving minors, and no sexual or nude images of real people. Three checks enforce them:

1. **Word lists** (`_lib/rules.mjs`), on cleaned-up text: hidden characters removed, look-alike
   letters from other alphabets, leetspeak and spelled-out words undone; ages, school grades and
   the usual slang included. Hidden characters are also removed from what Venice gets.
2. **Two text models** (`_lib/screen.mjs`, Venice's Mistral Small and Gemma 3) read every
   prompt, in any language, and answer yes/no to nudity, sexual, minor and real person. A yes from
   either counts. If neither answers, nothing is drawn.
3. **Two vision models** look at every image from an adult prompt (and everything from the
   Uncensored and Anime models) before it's stored or shown, and block it if they see nudity or
   sexual content with anyone who looks under 18.

`decide()` refuses when any check sees a minor or a real person and any check sees nudity or sex.
The Uncensored model refuses anything with children or teens at all. Adult prompts also get a
negative prompt against young-looking people, and Venice's own content flags (including its
adult-model flag) count as a block. The checks cost about $0.0005 an image, from the same Venice
balance.

## Endpoints

| Endpoint | Does |
|---|---|
| `GET /api/ai/quote` | Prices, models, the payee and memo, and whether it's open right now |
| `POST /api/ai/credits` `{ address, txs? }` | Records new payments, answers with the credits left |
| `POST /api/ai/generate` `{ address, expires, signature, model, prompt }` | One image: `{ url, spent, credits }` |
| `POST /api/ai/history` `{ address, expires, signature }` | The wallet's recent images |

## Settings (Vercel environment variables of the `sdoge` project)

| Name | |
|---|---|
| `VENICE_API_KEY` | Set in Vercel (sensitive). It never goes in the repo. Without it Studio AI stays closed. |
| `ARC_RPC_FALLBACK_URL` | Optional. A backup Arc RPC (Alchemy, key in the URL), tried when `rpc.mainnet.arc.io` fails. Vercel only. |
| `AI_SCREEN_MODELS` / `AI_VISION_MODELS` | Optional. The Venice models for the prompt and image checks (comma-separated). |
| `BLOB_READ_WRITE_TOKEN` | Set by Vercel for the `sdoge-studio-ai` store. |
| `AI_PAYEE` | Optional. Where payments go (default: the owner's wallet 0x5899…5914). |
| `AI_DAILY_LIMIT` | Optional. Images a day across the site (default 400). |
| `AI_MIN_VENICE_BALANCE_USD` | Optional. Below this Venice balance, the site stops selling and making images (default 3). |

## Tests

`npm test` (repo root) runs `_test/ai.test.mjs`: prompt rules, prices, sign-in, payment checks
against a fake Arc RPC, and every endpoint end to end, including parallel requests racing for
the same credits. `contracts/test/studio-ai.test.js` runs the page's own script against these
handlers on the Hardhat chain.
