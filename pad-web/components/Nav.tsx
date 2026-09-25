'use client';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { clsx } from 'clsx';
import { ConnectButton } from './ConnectButton';
import { CONFIG } from '@/lib/config';

type Item = { label: string; href?: string; external?: boolean; soon?: boolean };

// Staking stays unlinked until the owner opens the staking page; it shows
// as "soon" so the nav matches the design without leading anywhere.
const ITEMS: Item[] = [
  ...(CONFIG.homeUrl ? [{ label: 'Home', href: CONFIG.homeUrl, external: true }] : []),
  { label: 'Launchpad', href: '/' },
  { label: 'Create', href: '/create' },
  { label: 'How it works', href: '/#how-it-works' },
  { label: 'Staking', soon: true },
  { label: 'Leaderboard', href: '/leaderboard' },
];

export function Logo() {
  return (
    <Link href="/" className="flex shrink-0 flex-col leading-none" aria-label={CONFIG.brand}>
      <span className="flex items-center font-display text-[26px] font-bold tracking-tight text-white drop-shadow-[0_2px_0_rgba(21,88,192,.8)]">
        SD
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/logo.jpg" alt="" className="mx-[1px] h-[22px] w-[22px] rounded-full border-2 border-brand-hi object-cover" />
        GE
      </span>
      <span className="mt-0.5 text-[9px] font-semibold tracking-[0.5em] text-white/85">LAUNCHPAD</span>
    </Link>
  );
}

export function ArcBadge({ className }: { className?: string }) {
  return (
    <span className={clsx('flex items-center gap-1.5 font-display font-bold tracking-wide text-white', className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/arc-mark.png" alt="" className="h-[1.05em] w-auto" />
      ARC
    </span>
  );
}

function NavLink({ item, active, onClick, mobile }: { item: Item; active: boolean; onClick?: () => void; mobile?: boolean }) {
  const base = mobile
    ? 'rounded-lg px-2 py-2.5 text-base font-semibold'
    : 'whitespace-nowrap border-b-2 pb-1 text-[15px] font-semibold';
  if (item.soon) {
    return (
      <span className={clsx(base, 'flex cursor-default items-center gap-1.5 border-transparent text-text/45')} title="Coming soon">
        {item.label}<span className="rounded bg-panel2 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted">soon</span>
      </span>
    );
  }
  const cls = clsx(base, 'text-text/85 hover:text-brand-hi', mobile ? active && 'bg-panel2 text-brand-hi' : active ? 'border-brand-hi text-brand-hi' : 'border-transparent');
  return item.external
    ? <a href={item.href} className={cls} onClick={onClick}>{item.label}</a>
    : <Link href={item.href!} className={cls} onClick={onClick}>{item.label}</Link>;
}

export function Nav() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b border-line/60 bg-bg/80 backdrop-blur">
      <div className="mx-auto flex h-[72px] max-w-[1440px] items-center gap-6 px-4 sm:px-6 lg:gap-10">
        <Logo />
        <nav className="hidden items-center gap-7 lg:flex">
          {ITEMS.map((it) => <NavLink key={it.label} item={it} active={!!it.href && !it.external && path === it.href} />)}
        </nav>
        <div className="ml-auto flex items-center gap-3 sm:gap-5">
          <ArcBadge className="hidden text-2xl md:flex" />
          <ConnectButton />
          <button
            type="button"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-line2 text-text lg:hidden"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? 'Close menu' : 'Open menu'}
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>
      {open && (
        <nav className="flex flex-col gap-1 border-t border-line2 bg-bg px-4 py-3 lg:hidden">
          {ITEMS.map((it) => <NavLink key={it.label} item={it} mobile active={!!it.href && path === it.href} onClick={() => setOpen(false)} />)}
          <Link href="/explore" onClick={() => setOpen(false)} className="rounded-lg px-2 py-2.5 text-base font-semibold text-text/85 hover:text-brand-hi">Explore</Link>
        </nav>
      )}
    </header>
  );
}
