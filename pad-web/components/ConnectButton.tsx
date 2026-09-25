'use client';
import { ConnectButton as RKConnectButton } from '@rainbow-me/rainbowkit';
import { useBalance, useSwitchChain } from 'wagmi';
import { formatEther, type Address } from 'viem';
import { arc } from '@/lib/chain';
import { shortAddr } from '@/lib/format';

export function ConnectButton() {
  const { switchChain } = useSwitchChain();
  return (
    <RKConnectButton.Custom>
      {({ account, chain, mounted, openConnectModal, openAccountModal }) => {
        // Rendered but invisible until mounted, so SSR and the first client
        // render agree and the header doesn't shift when wallet state loads.
        if (!mounted) return <div aria-hidden className="pointer-events-none opacity-0"><button className="btn-brand px-6 py-3 text-[15px]">Connect Wallet</button></div>;
        if (!account) return <button className="btn-brand px-6 py-3 text-[15px]" onClick={openConnectModal}>Connect Wallet</button>;
        if (chain?.unsupported) {
          return <button className="btn-down" onClick={() => switchChain({ chainId: arc.id })}>Switch to Arc</button>;
        }
        return <Connected address={account.address as Address} onClick={openAccountModal} />;
      }}
    </RKConnectButton.Custom>
  );
}

function Connected({ address, onClick }: { address: Address; onClick: () => void }) {
  const { data: bal } = useBalance({ address });
  return (
    <div className="flex items-center gap-2">
      <span className="chip">{bal ? `${Number(formatEther(bal.value)).toFixed(2)} USDC` : '…'}</span>
      <button className="btn-ghost" onClick={onClick} title="Account">{shortAddr(address)}</button>
    </div>
  );
}
