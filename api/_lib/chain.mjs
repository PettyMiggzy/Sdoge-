// Arc reads for Studio AI: is this transaction a real AI payment, and did this wallet sign in?
import { verifyMessage } from 'ethers';
import {
  ARC_RPC_URL,
  CHAIN_ID,
  MEMO,
  MIN_CONFIRMATIONS,
  PAYEE,
  SESSION_MAX_SECONDS,
  creditsFor,
  sessionMessage,
} from './config.mjs';

export const isTxHash = (h) => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h);
export const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

async function rpc(method, params) {
  const r = await fetch(ARC_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'sdoge-studio-ai/1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Arc RPC answered HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`Arc RPC error ${j.error.code}: ${j.error.message}`);
  return j.result;
}

/**
 * Checks that `hash` is a successful payment to the AI wallet carrying the AI memo, made by
 * `payer` (when given). { ok: true, hash, payer, credits, valueWei, block } or
 * { ok: false, reason, retry? } (retry: it may just not be mined yet).
 */
export async function verifyPayment(hash, payer) {
  if (!isTxHash(hash)) return { ok: false, reason: "that isn't a transaction hash" };
  const [tx, receipt, head] = await Promise.all([
    rpc('eth_getTransactionByHash', [hash]),
    rpc('eth_getTransactionReceipt', [hash]),
    rpc('eth_blockNumber', []),
  ]);
  if (!tx || !receipt) return { ok: false, reason: "it isn't on Arc yet; try again in a few seconds", retry: true };
  if (receipt.status !== '0x1') return { ok: false, reason: 'that transaction failed' };
  if (BigInt(head) - BigInt(receipt.blockNumber) + 1n < MIN_CONFIRMATIONS) {
    return { ok: false, reason: 'it needs one more block; try again in a few seconds', retry: true };
  }
  if (tx.chainId != null && BigInt(tx.chainId) !== CHAIN_ID) return { ok: false, reason: "it isn't an Arc transaction" };
  if (String(tx.to ?? '').toLowerCase() !== PAYEE) return { ok: false, reason: "it didn't pay the Studio AI wallet" };
  if (String(tx.input ?? '').toLowerCase() !== MEMO.toLowerCase()) return { ok: false, reason: "it isn't a Studio AI payment" };
  const from = String(tx.from).toLowerCase();
  if (payer && from !== String(payer).toLowerCase()) return { ok: false, reason: 'another wallet paid it' };
  const value = BigInt(tx.value);
  const credits = creditsFor(value);
  if (credits < 1) return { ok: false, reason: "it's less than one credit" };
  return { ok: true, hash: hash.toLowerCase(), payer: from, credits, valueWei: value.toString(), block: Number(BigInt(receipt.blockNumber)) };
}

/**
 * A wallet's sign-in: it signed sessionMessage(address, expires). { ok: true, address } or
 * { ok: false, reason }.
 */
export function verifySession({ address, expires, signature } = {}, now = Math.floor(Date.now() / 1000)) {
  if (!isAddress(address)) return { ok: false, reason: 'Connect your wallet.' };
  const exp = Number(expires);
  if (!Number.isSafeInteger(exp) || exp <= now) return { ok: false, reason: 'Your sign-in expired. Sign again.' };
  if (exp > now + SESSION_MAX_SECONDS + 60) return { ok: false, reason: 'A sign-in lasts at most 7 days. Sign again.' };
  let signer;
  try {
    signer = verifyMessage(sessionMessage(address, exp), String(signature ?? ''));
  } catch {
    return { ok: false, reason: 'That signature is invalid. Sign again.' };
  }
  if (signer.toLowerCase() !== address.toLowerCase()) return { ok: false, reason: 'That signature is from another wallet. Sign again.' };
  return { ok: true, address: address.toLowerCase() };
}
