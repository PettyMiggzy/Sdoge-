# SDOGE Pad (site)

The Next.js site for SDOGE Pad (shown as "SDOGE Launchpad"): launch a token,
explore launches, and trade them through Uniswap's UniversalRouter. It reads
the chain directly for prices and talks to the contracts in `../pad`.

The look follows the owner's mockup in `design/mockup-home.jpg`; the art was
made from it with Venice (`design/README.md`).

## Run locally

```bash
cd pad-web
npm ci
cp .env.example .env.local   # set NEXT_PUBLIC_PORTAL, NEXT_PUBLIC_HOOK and NEXT_PUBLIC_PORTAL_GENESIS_BLOCK at least
npm run dev                  # http://localhost:3000
```

The build refuses to start without `NEXT_PUBLIC_PORTAL` and `NEXT_PUBLIC_HOOK`.
Without `BLOB_READ_WRITE_TOKEN` everything works except saving token details
(description, image, links), and the launch list is rebuilt from the chain on
every cold start instead of from a stored snapshot.

## Go live

1. Deploy the contracts (`../pad/README.md`) and note the portal, hook and the
   portal's deploy block.
2. Create a Vercel project with this folder as its root directory, and set
   every variable from `.env.example` there. Use your own Arc RPC URL (with a
   domain allowlist) instead of the public one if you expect traffic.
3. Create a private Vercel Blob store and connect it to the project (that sets
   `BLOB_READ_WRITE_TOKEN`). Token details, images and the launch-list
   snapshot live there, and the site serves them through its own routes.
4. For phone wallets, create a free project at https://cloud.reown.com, set
   `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`, and add the site's domain to that
   project's allowlist.
5. Optional: run `../pad-indexer` somewhere always-on and set
   `NEXT_PUBLIC_INDEXER_URL` for 24h volume, trades, holders and charts.

## Checks

- `npx next build` type-checks and lints (CI runs it on every push).
- `scripts/e2e-create-fork.cjs` drives the create page in a real browser
  against an anvil fork of Arc mainnet with the portal deployed, using a
  stand-in wallet. See the comment at the top of the file.
