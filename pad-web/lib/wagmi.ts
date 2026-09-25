import { createConfig, http, cookieStorage, createStorage, type CreateConnectorFn } from 'wagmi';
import { arc } from './chain';

// Server-safe on purpose: app/layout.tsx (a server component) builds this with
// no connectors just to read the wallet cookie via cookieToInitialState, which
// only needs the storage key. The real connectors come from RainbowKit, whose
// modules are "use client" and can't run in a server component — see
// lib/wallets.ts.
export function makeWagmiConfig(connectors: CreateConnectorFn[] = []) {
  return createConfig({
    chains: [arc],
    connectors,
    transports: { [arc.id]: http(arc.rpcUrls.default.http[0], { batch: true }) },
    ssr: true,
    storage: createStorage({ storage: cookieStorage }),
  });
}
