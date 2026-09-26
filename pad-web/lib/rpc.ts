import { fallback, http, type Transport } from 'viem';
import { CONFIG } from './config';

// Arc's public RPC first. When it fails (down, rate-limited), a backup: on the server straight to
// ARC_RPC_FALLBACK_URL (a server-only env var holding a paid provider's URL, key included, so it
// never reaches a browser), and in the browser through this site's /api/rpc, which relays read
// calls to that same backup.
export function arcTransport({ batch = false }: { batch?: boolean } = {}): Transport {
  const primary = http(CONFIG.rpcUrl, { batch });
  const backupUrl = typeof window === 'undefined' ? process.env.ARC_RPC_FALLBACK_URL : `${window.location.origin}/api/rpc`;
  if (!backupUrl) return primary;
  return fallback([primary, http(backupUrl, { batch: batch ? { batchSize: 50 } : false })]);
}
