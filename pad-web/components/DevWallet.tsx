'use client';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { formatUnits, isAddress, type Address } from 'viem';
import { ExternalLink, Landmark, Wallet } from 'lucide-react';
import { CONFIG, explorerAddr } from '@/lib/config';
import { arc } from '@/lib/chain';
import { erc20Abi, portalAbi } from '@/lib/abi';
import { fmtCompact, shortAddr } from '@/lib/format';

type Balances = { devUsdc: bigint; devSdoge: bigint; sdogeDecimals: number; treasury: Address; treasuryUsdc: bigint };

/**
 * Out in the open: what the dev wallet (the wallet that created $SDOGE and
 * runs the pad) holds, and what the pad's treasury has collected from the
 * platform's 10%. Read live from the chain.
 */
export function DevWallet() {
  const pc = usePublicClient({ chainId: arc.id });
  const dev = CONFIG.padAdmin as Address;
  const enabled = !!pc && isAddress(dev);

  const bal = useQuery({
    queryKey: ['dev-wallet', dev, CONFIG.portal],
    enabled,
    refetchInterval: 30_000,
    queryFn: async (): Promise<Balances> => {
      const treasury = await pc!.readContract({ address: CONFIG.portal, abi: portalAbi, functionName: 'treasury' });
      const [devUsdc, devSdoge, sdogeDecimals, treasuryUsdc] = await Promise.all([
        pc!.readContract({ address: CONFIG.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [dev] }),
        pc!.readContract({ address: CONFIG.sdogeToken as Address, abi: erc20Abi, functionName: 'balanceOf', args: [dev] }),
        pc!.readContract({ address: CONFIG.sdogeToken as Address, abi: erc20Abi, functionName: 'decimals' }),
        pc!.readContract({ address: CONFIG.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [treasury] }),
      ]);
      return { devUsdc, devSdoge, sdogeDecimals, treasury, treasuryUsdc };
    },
  });

  const sdogePrice = useQuery({
    queryKey: ['dexscreener-price', CONFIG.sdogeToken],
    refetchInterval: 60_000,
    queryFn: async () => {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${CONFIG.sdogeToken}`);
      if (!r.ok) throw new Error(`DexScreener ${r.status}`);
      const pairs = ((await r.json()).pairs ?? []) as { chainId: string; priceUsd?: string; liquidity?: { usd?: number } }[];
      const p = pairs.filter((x) => x.chainId === 'arc').sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      return p?.priceUsd ? Number(p.priceUsd) : null;
    },
  });

  if (!enabled) return null;
  const d = bal.data;
  const usd = (raw: bigint, dec: number) => Number(formatUnits(raw, dec));
  const sdogeAmt = d ? usd(d.devSdoge, d.sdogeDecimals) : undefined;
  const sdogeUsd = sdogeAmt !== undefined && sdogePrice.data ? sdogeAmt * sdogePrice.data : undefined;

  return (
    <section className="panel p-6">
      <h2 className="font-display text-xl font-bold uppercase tracking-wide text-white">Where the money sits</h2>
      <p className="mt-1 text-sm text-muted">Live from the chain. Anyone can check these wallets on the explorer.</p>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <Holder
          icon={<Wallet className="h-5 w-5" />}
          title="Dev wallet"
          note="Created $SDOGE and runs the pad."
          address={dev}
          rows={[
            ['USDC', d ? `$${usd(d.devUsdc, CONFIG.quoteDecimals).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '…'],
            ['$SDOGE', sdogeAmt === undefined ? '…' : `${fmtCompact(sdogeAmt)}${sdogeUsd !== undefined ? ` (≈ $${sdogeUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })})` : ''}`],
          ]}
        />
        <Holder
          icon={<Landmark className="h-5 w-5" />}
          title="Pad treasury"
          note="The platform's 10% of every launch's fees lands here."
          address={d?.treasury}
          rows={[['USDC', d ? `$${usd(d.treasuryUsdc, CONFIG.quoteDecimals).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '…']]}
        />
      </div>
      {bal.isError && <p className="mt-3 text-xs text-down">Couldn&apos;t read balances right now. They&apos;ll refresh on their own.</p>}
    </section>
  );
}

function Holder({ icon, title, note, address, rows }: { icon: ReactNode; title: string; note: string; address?: Address; rows: [string, string][] }) {
  const href = address ? explorerAddr(address) : '';
  return (
    <div className="rounded-xl border border-line bg-panel2/60 p-5">
      <div className="flex items-center gap-3">
        <span className="icon-badge h-10 w-10">{icon}</span>
        <div className="min-w-0">
          <div className="font-display text-lg font-bold uppercase text-white">{title}</div>
          <div className="text-xs text-dim">{note}</div>
        </div>
      </div>
      <dl className="mt-4 space-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3">
            <dt className="text-muted">{k}</dt>
            <dd className="font-bold text-white">{v}</dd>
          </div>
        ))}
      </dl>
      {address && (
        href
          ? <a href={href} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1.5 font-mono text-xs text-brand-hi hover:underline">{shortAddr(address)}<ExternalLink className="h-3.5 w-3.5" /></a>
          : <span className="mt-4 inline-block font-mono text-xs text-muted">{shortAddr(address)}</span>
      )}
    </div>
  );
}
