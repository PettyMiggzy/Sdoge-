'use client';
import '@rainbow-me/rainbowkit/styles.css';
import { WagmiProvider, type State } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { useState, type ReactNode } from 'react';
import { wagmiConfig } from '@/lib/wallets';
import { arc } from '@/lib/chain';

// Matches tailwind.config.ts (brand #2775CA on navy panels, xl2 radius) so the
// wallet modal reads as part of the site rather than a third-party popup.
const theme = darkTheme({ accentColor: '#2775CA', accentColorForeground: '#ffffff', borderRadius: 'large', fontStack: 'system' });
theme.fonts.body = 'var(--font-body), system-ui, sans-serif';
theme.colors.modalBackground = '#0B1730';
theme.colors.modalBorder = '#1A2E5C';
theme.colors.modalText = '#F5F7FF';

export function Providers({ children, initialState }: { children: ReactNode; initialState?: State }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false } } }));
  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState}>
      <QueryClientProvider client={qc}>
        <RainbowKitProvider theme={theme} initialChain={arc} modalSize="compact">
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
