import { Interface, formatUnits, isError } from 'ethers';
import { ERRORS_ABI } from './abi.js';
import { txLink } from './format.js';

const errorsIface = new Interface(ERRORS_ABI);

// A failed on-chain action, with what is known about its money:
//   not_sent  nothing was signed or broadcast (e.g. estimateGas says it would
//             revert): nothing was spent
//   refused   signed, but the node refused it and the chain doesn't know it:
//             nothing was spent
//   reverted  mined with status 0: only gas was spent
//   unknown   broadcast (or maybe broadcast) and no receipt yet: it may still
//             go through, so the user must not retry blindly
export class TxError extends Error {
  constructor(outcome, message, { hash = null, receipt = null, reason = null, label = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TxError';
    this.outcome = outcome;
    this.hash = hash;
    this.receipt = receipt;
    this.reason = reason;
    this.label = label;
  }
}

const isRevertData = (d) => typeof d === 'string' && /^0x[0-9a-fA-F]{8}/.test(d);

// Revert data wherever this ethers version put it.
function revertData(err, depth = 0) {
  if (!err || typeof err !== 'object' || depth > 4) return null;
  for (const d of [err.data, err.error?.data, err.info?.error?.data, err.revert?.data]) if (isRevertData(d)) return d;
  return revertData(err.cause ?? err.error ?? err.info?.error, depth + 1);
}

// A launchpad custom error from revert data or an ethers error, or null.
// Hook reverts arrive wrapped in the PoolManager's WrappedError: unwrapped.
export function decodeRevert(errOrData) {
  const data = typeof errOrData === 'string' ? errOrData : revertData(errOrData);
  if (!isRevertData(data)) return null;
  let parsed;
  try { parsed = errorsIface.parseError(data); } catch { parsed = null; }
  if (!parsed) return null;
  if (parsed.name === 'WrappedError') return decodeRevert(parsed.args.reason) ?? { name: 'WrappedError', args: [...parsed.args] };
  return { name: parsed.name, args: [...parsed.args] };
}

const messageOf = (err) => [err?.shortMessage, err?.message, err?.error?.message, err?.info?.error?.message].filter(Boolean).join(' ');

// Why a transaction couldn't be sent, from the error ethers threw.
export function failureReason(err) {
  const decoded = decodeRevert(err);
  if (decoded) return decoded;
  const msg = messageOf(err);
  if (isError(err, 'INSUFFICIENT_FUNDS') || /insufficient funds/i.test(msg)) return { name: 'insufficient_funds' };
  if (/Blocked address|blocklist|blacklist/i.test(msg)) return { name: 'blocked' };
  if (isError(err, 'NONCE_EXPIRED') || isError(err, 'REPLACEMENT_UNDERPRICED') || /nonce|replacement transaction/i.test(msg)) return { name: 'nonce' };
  if (isError(err, 'CALL_EXCEPTION')) return { name: 'would_revert' };
  if (isError(err, 'SERVER_ERROR') || isError(err, 'TIMEOUT') || isError(err, 'NETWORK_ERROR') || /ECONN|ETIMEDOUT|socket hang up|fetch failed/i.test(`${msg} ${err?.code ?? ''}`)) {
    return { name: 'network' };
  }
  return null;
}

const usdc = (wei) => {
  const s = formatUnits(BigInt(wei), 18);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};

// One plain sentence per known reason (no trailing period).
export function reasonText(reason) {
  const a = reason?.args ?? [];
  switch (reason?.name) {
    case 'InsufficientOutput': return 'The price moved past your slippage limit';
    case 'Expired': return 'The trade expired before it was mined';
    case 'WrongLaunchFee': return `The launch fee changed from ${usdc(a[0])} to ${usdc(a[1])} USDC`;
    case 'NothingToPay': return 'The vault has nothing to pay for that amount';
    case 'PriceAboveStart': return 'Sells can\'t take the price below the launch price, so try a smaller amount';
    case 'ERC20InsufficientBalance': return 'Your wallet doesn\'t hold that many tokens anymore';
    case 'BadName':
    case 'BadSymbol':
    case 'BadUri': return 'The launchpad rejected the name or ticker';
    case 'insufficient_funds': return 'Not enough USDC in your wallet to cover this plus gas (/deposit to top up)';
    case 'blocked': return 'USDC\'s issuer has blocked an address involved in this transfer';
    case 'nonce': return 'Your wallet had another transaction in flight';
    case 'out_of_gas': return 'It ran out of gas because network conditions changed while it was pending';
    case 'would_revert': return 'A test run showed this transaction would fail';
    case 'network': return 'The network didn\'t respond properly';
    default: return null;
  }
}

// What didn't happen, per action.
const NOTHING = {
  buy: 'Nothing was bought',
  sell: 'Nothing was sold',
  redeem: 'Nothing was redeemed',
  claim: 'Nothing was claimed',
  withdraw: 'No USDC was sent',
  launch: 'No token was launched and no launch fee was charged',
};
export const nothingDone = (kind) => NOTHING[kind] ?? 'Nothing happened';
const nothing = nothingDone;

// The message a user sees when a confirmed action fails. Only says "nothing
// was spent" when that is certain, and always links the transaction when it
// might still go through.
//   kind            the action (buy, sell, launch, ...)
//   priorConfirmed  an earlier transaction of the same action (the token
//                   approval before a sell or redeem) did go through
export function describeFailure(err, { explorerUrl, kind, priorConfirmed = false } = {}) {
  const link = err?.hash ? txLink(explorerUrl, err.hash) : '';
  const reason = reasonText(err?.reason);
  const approval = err?.label === 'approve';
  switch (err?.outcome) {
    case 'unknown':
      if (approval) {
        return `⏳ The token approval was sent but isn't confirmed yet (${link}), so the ${kind} itself was <b>not</b> sent and nothing was traded. Try again in a minute.`;
      }
      return `⏳ <b>Sent, but not confirmed yet.</b> <b>Don't retry</b> until this shows as failed: ${link}. I'll update this message when it confirms; /wallet shows your balance.`;
    case 'reverted':
      if (approval) return `❌ The token approval reverted on-chain (${link}), so the ${kind} wasn't sent. ${nothing(kind)}; only a little gas was spent.`;
      return `❌ <b>The transaction reverted on-chain</b>${reason ? `: ${reason}` : ''}. ${nothing(kind)}; only the gas fee was spent. ${link}`;
    case 'refused':
    case 'not_sent': {
      const why = reason ?? (err.outcome === 'refused' ? 'The network refused the transaction' : 'The transaction couldn\'t be prepared');
      const tail = err?.reason?.name === 'WrongLaunchFee' ? ' Start /launch again to see the new cost.'
        : err?.reason?.name === 'nonce' ? ' Try again in a few seconds.'
          : err?.reason?.name === 'InsufficientOutput' ? ' Try again, or raise /slippage.'
            : ['insufficient_funds', 'blocked'].includes(err?.reason?.name) ? '' : ' Try again in a moment.';
      if (priorConfirmed) {
        return `❌ ${why}. ${nothing(kind)}; the token approval before it did go through, which only cost a little gas.${tail}`;
      }
      return `❌ ${why}, so nothing was sent and nothing was spent.${tail}`;
    }
    default:
      return null;
  }
}
