'use client';
import { CONFIG } from './config';

// Arc's explorer only shows a contract's verified source after someone asks
// it for that contract: the first request makes it look the code up in the
// shared verified-code database (Sourcify's). Token scanners such as Quick
// Intel read the source from the explorer, and flag a token whose source it
// doesn't have yet. Every launch token has the same code as one already
// verified, so a single request is enough; the site sends it as soon as a
// token exists (right after the launch, and whenever its page opens).
const asked = new Set<string>();

export function askExplorerForSource(address: string) {
  const a = address.toLowerCase();
  if (!CONFIG.explorerUrl || asked.has(a)) return;
  asked.add(a);
  fetch(`${CONFIG.explorerUrl}/api/v2/smart-contracts/${a}`, { mode: 'no-cors', cache: 'no-store' }).catch(() => {});
}
