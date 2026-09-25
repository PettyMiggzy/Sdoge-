'use client';
import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import {
  metaMaskWallet, coinbaseWallet, rainbowWallet, trustWallet, rabbyWallet, okxWallet, phantomWallet,
  walletConnectWallet, injectedWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { makeWagmiConfig } from './wagmi';
import { CONFIG } from './config';

const wcProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

// Named wallets deep-link into their mobile apps (and use their own injected
// provider when opened inside that wallet's in-app browser); installed
// desktop extensions are also auto-detected via EIP-6963. RainbowKit's
// generic injectedWallet ("Browser Wallet") is left out on purpose: it has no
// auto-hide, so plain mobile Safari/Chrome would show a dead option that can
// never connect. It's only the fallback when no WalletConnect project ID is
// set, since every other wallet here throws at config time without one.
const connectors = connectorsForWallets(
  wcProjectId
    ? [
        { groupName: 'Popular', wallets: [metaMaskWallet, coinbaseWallet, rainbowWallet, trustWallet, phantomWallet] },
        { groupName: 'More', wallets: [rabbyWallet, okxWallet, walletConnectWallet] },
      ]
    : [{ groupName: 'Installed', wallets: [injectedWallet] }],
  { appName: CONFIG.brand, projectId: wcProjectId ?? 'unset' },
);

export const wagmiConfig = makeWagmiConfig(connectors);

declare module 'wagmi' {
  interface Register { config: typeof wagmiConfig }
}
