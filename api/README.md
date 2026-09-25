# Studio AI (`api/ai/*`)

"Create with AI" on the Studio page (`studio.html`, `assets/js/studio-ai.js`). These are Vercel
functions of the main site's project (`sdoge`, serving stabledoge.site).

## How it works

1. **Buy credits.** The buyer pays native USDC on Arc to the owner's wallet (`AI_PAYEE`), with
   the memo `SDOGE Studio AI` as the transaction data. 1 credit is 0.25 USDC, 10 are 2 USDC and
   50 are 8 USDC. `POST /api/ai/credits` checks each payment on Arc (successful, to the payee,
   with the memo, from that wallet) and records it.
2. **Sign in.** Spending credits takes a wallet signature over a short message, valid for a day.
   It costs nothing and sends nothing, but it stops anyone else from spending the credits.
3. **Create.** `POST /api/ai/generate` screens the prompt, spends the credits and asks Venice
   for a square image. Every image costs the buyer at least 2.5x what Venice charges; that
   difference is the owner's profit. The image goes into the site's public Blob store
   (`sdoge-studio-ai`) at a permanent link, ready for the Studio's 1-of-1 mint.

Credits are never spent on a refused prompt, a failed image, or a day that's hit its limit.
Each credit is its own file in the store, created without overwriting, so two requests can't
spend the same credit.

## The prompt rules

The generator is uncensored, except for two hard blocks (`_lib/rules.mjs`): nothing sexual or
suggestive involving minors, and no sexual images of real people. Every sexual prompt also tells
the model to avoid anyone young-looking. Venice's own refusals give the credit back.

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
| `VENICE_API_KEY` | The owner adds it in Vercel. It never goes in the repo. Without it Studio AI stays closed. |
| `BLOB_READ_WRITE_TOKEN` | Set by Vercel for the `sdoge-studio-ai` store. |
| `AI_PAYEE` | Optional. Where payments go (default: the owner's wallet 0x5899…5914). |
| `AI_DAILY_LIMIT` | Optional. Images a day across the site (default 400). |
| `AI_MIN_VENICE_BALANCE_USD` | Optional. Below this Venice balance, the site stops selling and making images (default 3). |

## Tests

`npm test` (repo root) runs `_test/ai.test.mjs`: prompt rules, prices, sign-in, payment checks
against a fake Arc RPC, and every endpoint end to end, including parallel requests racing for
the same credits. `contracts/test/studio-ai.test.js` runs the page's own script against these
handlers on the Hardhat chain.
