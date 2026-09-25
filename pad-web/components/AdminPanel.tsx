'use client';
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { parseAbi, zeroAddress } from 'viem';
import { CheckCircle2, Power } from 'lucide-react';
import { CONFIG, explorerTx } from '@/lib/config';
import { arc } from '@/lib/chain';
import { explainTxError } from '@/lib/txError';
import { shortAddr } from '@/lib/format';
import { ConnectButton } from './ConnectButton';

const hookAdminAbi = parseAbi([
  'function isAuthorizedPortal(address) view returns (bool)',
  'function factoryBootstrapped() view returns (bool)',
  'function factory() view returns (address)',
  'function bootstrapMainPortal(address portal_)',
  'error NotBootstrapper()',
  'error AlreadyBootstrapped()',
]);

/**
 * The hook's one-time admin switch. Only the pad admin (the hook's
 * bootstrapper, fixed at deploy) can use it; anyone else is told so before
 * their wallet opens, because the call is simulated first.
 */
export function AdminPanel() {
  const { address, isConnected } = useAccount();
  const pc = usePublicClient({ chainId: arc.id });
  const { writeContractAsync } = useWriteContract();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ['pad-admin-status', CONFIG.hook, CONFIG.portal],
    enabled: !!pc,
    refetchInterval: 15_000,
    queryFn: async () => {
      const [on, slotUsed, factory] = await Promise.all([
        pc!.readContract({ address: CONFIG.hook, abi: hookAdminAbi, functionName: 'isAuthorizedPortal', args: [CONFIG.portal] }),
        pc!.readContract({ address: CONFIG.hook, abi: hookAdminAbi, functionName: 'factoryBootstrapped' }),
        pc!.readContract({ address: CONFIG.hook, abi: hookAdminAbi, functionName: 'factory' }),
      ]);
      const slot = !slotUsed ? 'Open (only the pad admin can fill or close it)' : factory === zeroAddress ? 'Closed for good' : `Factory ${shortAddr(factory)}`;
      return { on, slot };
    },
  });

  async function switchOn() {
    if (!pc || !address) return;
    setErr(null); setBusy('Doing a test run…');
    try {
      const call = { address: CONFIG.hook, abi: hookAdminAbi, functionName: 'bootstrapMainPortal', args: [CONFIG.portal] } as const;
      await pc.simulateContract({ ...call, account: address });
      setBusy('Waiting for your wallet approval…');
      const hash = await writeContractAsync({ ...call, chainId: arc.id });
      setTx(hash); setBusy(`Waiting for ${CONFIG.chainName}…`);
      const receipt = await pc.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('The transaction failed on-chain');
      await status.refetch();
    } catch (e: unknown) {
      const raw = `${(e as Error)?.message ?? e}`;
      setErr(/NotBootstrapper/.test(raw)
        ? `This wallet isn't the pad admin${CONFIG.padAdmin ? ` (${shortAddr(CONFIG.padAdmin)})` : ''}. Connect the admin wallet and try again.`
        : explainTxError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="section-title">Pad admin</h1>
        <p className="mt-2 text-muted">
          One-time switches on the {CONFIG.brand} hook. Only the pad admin wallet
          {CONFIG.padAdmin ? <> (<span className="font-mono text-text">{shortAddr(CONFIG.padAdmin)}</span>)</> : null} can use them.
        </p>
      </div>

      <div className="panel space-y-3 p-6 text-sm">
        <Row label="Launchpad">
          {status.data === undefined ? '…' : status.data.on
            ? <span className="flex items-center gap-1.5 font-bold text-up"><CheckCircle2 className="h-4 w-4" />Switched on</span>
            : <span className="font-bold text-gold">Switched off</span>}
        </Row>
        <Row label="White-label slot">{status.data?.slot ?? '…'}</Row>
        <Row label="Hook"><span className="font-mono text-xs">{CONFIG.hook}</span></Row>
        <Row label="Portal"><span className="font-mono text-xs">{CONFIG.portal}</span></Row>
      </div>

      {status.data && !status.data.on && (
        <div className="panel space-y-4 p-6">
          <h2 className="font-display text-xl font-bold uppercase text-white">Switch on the launchpad</h2>
          <p className="text-sm text-muted">
            Authorizes the main portal on the hook so launches can open their pools. It can only be done once, and
            nothing can switch it off afterwards.
          </p>
          {!isConnected ? <ConnectButton /> : (
            <button className="btn-brand px-6 py-3" disabled={!!busy} onClick={switchOn}>
              <Power className="h-4 w-4" />{busy ?? 'Switch on'}
            </button>
          )}
          {tx && <a className="block truncate text-xs text-brand-hi" href={explorerTx(tx) || undefined} target="_blank" rel="noreferrer">tx {tx}</a>}
          {err && <div className="rounded-lg border border-down/40 bg-down/10 p-3 text-sm text-down">{err}</div>}
        </div>
      )}
      {status.data?.on && <div className="panel p-6 text-sm text-up">The launchpad is live. Anyone can launch a token.</div>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3 last:border-0 last:pb-0">
      <span className="text-muted">{label}</span>
      <span className="text-right text-text">{children}</span>
    </div>
  );
}
