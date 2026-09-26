// POST /api/rpc: this site's read-only relay to its backup Arc RPC (ARC_RPC_FALLBACK_URL, a paid
// provider whose key stays on the server). The pages use it only when Arc's public RPC fails (see
// assets/js/arc.js). Read calls only, no transactions; no CORS headers, so other sites' pages
// can't use it; and a per-address rate limit.
import { arcRpcFallbackUrl } from './_lib/config.mjs';
import { limited } from './_lib/http.mjs';

const READ_METHODS = new Set([
  'eth_chainId', 'net_version', 'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_getBalance', 'eth_getCode',
  'eth_getStorageAt', 'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getLogs', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
]);
const MAX_BATCH = 100;

function reply(res, status, text) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}
const rpcError = (res, status, code, message, id = null) => reply(res, status, JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));

export default async function handler(req, res) {
  if (req.method !== 'POST') return rpcError(res, 405, -32600, 'Use POST');
  if (limited(req, 'rpc', 240)) return rpcError(res, 429, -32005, 'Too many requests');
  const backup = arcRpcFallbackUrl();
  if (!backup) return rpcError(res, 503, -32000, 'No backup RPC');

  let payload = req.body;
  if (typeof payload === 'string') {
    if (payload.length > 200_000) return rpcError(res, 413, -32600, 'Request too large');
    try {
      payload = JSON.parse(payload);
    } catch {
      return rpcError(res, 400, -32700, 'Parse error');
    }
  }
  const items = Array.isArray(payload) ? payload : [payload];
  if (!items.length || items.length > MAX_BATCH) return rpcError(res, 400, -32600, `Send 1 to ${MAX_BATCH} calls`);
  for (const it of items) {
    const ok = it && it.jsonrpc === '2.0' && READ_METHODS.has(it.method) && (it.params === undefined || Array.isArray(it.params));
    if (!ok) return rpcError(res, 400, -32601, 'Only read calls go through this relay', it?.id ?? null);
  }

  try {
    const r = await fetch(backup, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return reply(res, r.status, await r.text());
  } catch {
    return rpcError(res, 502, -32000, 'Backup RPC unreachable');
  }
}
