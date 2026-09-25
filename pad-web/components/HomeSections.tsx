import Link from 'next/link';
import type { ComponentType } from 'react';
import {
  Rocket, BarChart3, Trophy, Users, CheckCircle2, ShieldCheck, Zap, Gem, Wallet, FileText, ArrowRight,
} from 'lucide-react';
import { ArcBadge } from './Nav';

type Icon = ComponentType<{ className?: string }>;

export function Hero() {
  return (
    <section className="relative -mx-6 -mt-6 overflow-hidden border-b border-line/60">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/hero.webp" alt="" className="absolute inset-0 h-full w-full object-cover object-[72%_70%]" />
      {/* Darken the left side for the text, and fade the bottom into the page. */}
      <div className="absolute inset-0 bg-gradient-to-r from-bg/95 via-bg/60 to-transparent md:via-bg/35" />
      <div className="absolute inset-0 bg-bg/55 sm:hidden" />
      <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-bg to-transparent" />
      <div className="relative mx-auto max-w-[1440px] px-6 pb-20 pt-8 sm:pt-10 lg:pb-24 lg:pt-12">
        <div className="max-w-[560px]">
          <h1>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/logo-launchpad.webp" alt="SDOGE Launchpad" className="w-[300px] drop-shadow-[0_12px_30px_rgba(0,0,0,.6)] sm:w-[420px] lg:w-[500px]" />
          </h1>
          <div className="mt-1 flex items-center gap-3 pl-[18%] font-display text-2xl font-bold text-white sm:text-3xl">
            <span>ON</span><ArcBadge className="text-3xl sm:text-4xl" />
          </div>
          <p className="mt-6 font-display text-[26px] font-bold uppercase leading-[1.05] text-white drop-shadow sm:text-[32px]">
            Ideas today.<br />A more stable tomorrow.
          </p>
          <p className="mt-3 max-w-md text-[15px] text-text/85 sm:text-base">
            Launch, trade and grow the next generation of stable meme projects on Arc.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link href="/create" className="btn-brand px-6 py-3.5 text-base"><Rocket className="h-5 w-5" />Create a Launch</Link>
            <Link href="/explore" className="btn-ghost px-6 py-3.5 text-base">Explore Launches</Link>
          </div>
        </div>
      </div>
    </section>
  );
}

export type Stat = { icon: Icon; label: string; value: string; delta?: string; hint?: string };

export function StatsBar({ items }: { items: Stat[] }) {
  return (
    <section className="panel relative z-10 -mt-4 grid grid-cols-2 divide-line lg:grid-cols-4 lg:divide-x">
      {items.map(({ icon: Icon, label, value, delta, hint }) => (
        <div key={label} className="flex items-center gap-4 px-5 py-5 sm:px-8 sm:py-6" title={hint}>
          <span className="icon-badge h-12 w-12 sm:h-14 sm:w-14"><Icon className="h-6 w-6 sm:h-7 sm:w-7" /></span>
          <div className="min-w-0">
            <div className="text-[11px] font-bold uppercase tracking-wider text-brand-hi sm:text-xs">{label}</div>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span className="font-display text-2xl font-bold text-white sm:text-3xl">{value}</span>
              {delta && <span className="text-xs font-bold text-up">{delta}</span>}
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}

export const STAT_ICONS = { Rocket, BarChart3, Trophy, Users };

export function LaunchPromo() {
  const points = ['Low fees', 'Fair launch mechanics', 'Instant liquidity', 'Built for the SDOGE community'];
  return (
    <div className="panel relative overflow-hidden">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/launch-rocket.webp" alt="" className="h-48 w-full object-cover object-[60%_center] sm:h-60 md:absolute md:inset-y-0 md:right-0 md:h-full md:w-[62%] md:object-[70%_center]" />
      <div className="absolute inset-0 hidden bg-gradient-to-r from-panel via-panel/70 to-transparent md:block" />
      <div className="relative p-6 sm:p-8 md:max-w-[52%]">
        <h2 className="section-title leading-tight">Launch your project<br />on Arc</h2>
        <p className="mt-2 text-lg text-text/90">Fast. Fair. Community driven.</p>
        <ul className="mt-5 space-y-2.5">
          {points.map((p) => (
            <li key={p} className="flex items-center gap-3 text-[15px] text-text/90"><CheckCircle2 className="h-5 w-5 shrink-0 text-brand-hi" />{p}</li>
          ))}
        </ul>
        <Link href="/create" className="btn-brand mt-7 px-7 py-3.5 text-base"><Rocket className="h-5 w-5" />Create a Launch</Link>
      </div>
    </div>
  );
}

export function WhyPanel() {
  const rows: [Icon, string, string][] = [
    [ShieldCheck, 'Fair & transparent', 'No team allocations, no hidden wallets.'],
    [Zap, 'Instant liquidity', 'Automatic liquidity on launch, locked forever.'],
    [Users, 'Community first', 'Built and backed by the SDOGE community.'],
    [Gem, 'Stable ecosystem', 'Every launch pairs with USDC on Arc.'],
  ];
  return (
    <div className="panel p-5 sm:p-6">
      <h2 className="font-display text-xl font-bold uppercase tracking-wide text-white">Why SDOGE Launchpad?</h2>
      <div className="mt-4 space-y-3">
        {rows.map(([Icon, t, d]) => (
          <div key={t} className="flex items-center gap-4 rounded-xl2 border border-line bg-bg/40 px-4 py-3.5">
            <Icon className="h-7 w-7 shrink-0 text-brand-hi drop-shadow-[0_0_10px_rgba(77,163,255,.6)]" />
            <div>
              <div className="text-sm font-bold uppercase tracking-wide text-white">{t}</div>
              <div className="text-sm text-muted">{d}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function HowItWorks() {
  const steps: [Icon, string, string][] = [
    [Wallet, 'Connect wallet', 'Connect your Arc wallet to get started.'],
    [FileText, 'Create launch', 'Set your token details, image and links.'],
    [Rocket, 'Launch fairly', 'Automatic liquidity, fair distribution.'],
    [BarChart3, 'Grow together', 'Let the community take it to the next level.'],
  ];
  return (
    <section id="how-it-works" className="grid scroll-mt-24 items-center gap-6 lg:grid-cols-[1.5fr_1fr]">
      <div>
        <h2 className="section-title">How it works</h2>
        <ol className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map(([Icon, t, d], i) => (
            <li key={t} className="relative">
              <div className="flex items-center gap-3">
                <span className="icon-badge h-16 w-16"><Icon className="h-7 w-7" /></span>
                {i < steps.length - 1 && <ArrowRight className="hidden h-5 w-5 text-brand-hi/60 lg:block" />}
              </div>
              <div className="mt-4 text-sm font-bold uppercase tracking-wide text-white">{i + 1}. {t}</div>
              <p className="mt-1 text-sm text-muted">{d}</p>
            </li>
          ))}
        </ol>
      </div>
      <div className="overflow-hidden rounded-xl3 border border-line shadow-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/relax.webp" alt="Same vibes. More stable projects." className="h-full w-full object-cover" />
      </div>
    </section>
  );
}

export function CtaBanner() {
  return (
    <section className="relative -mx-6 overflow-hidden border-y border-line/60">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/footer-banner.webp" alt="" className="absolute inset-0 h-full w-full object-cover object-center" />
      <div className="absolute inset-0 bg-gradient-to-r from-bg/70 via-transparent to-bg/50" />
      <div className="relative mx-auto flex max-w-[1440px] flex-col items-start justify-between gap-6 px-6 py-12 sm:flex-row sm:items-center sm:py-16">
        <p className="-rotate-3 font-marker text-3xl leading-tight text-white drop-shadow-[0_3px_0_rgba(0,0,0,.6)] sm:text-4xl lg:text-5xl">
          Good projects.<br />Stronger together.
        </p>
        <Link href="/create" className="btn-brand px-7 py-3.5 text-base"><Rocket className="h-5 w-5" />Create a Launch</Link>
      </div>
    </section>
  );
}
