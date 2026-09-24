// Maps chain/RPC failures to something a Telegram user can act on. The raw
// error is always logged server-side; users never see RPC internals.
export function friendlyError(err) {
  const msg = String(err?.shortMessage ?? err?.reason ?? err?.message ?? err);
  if (/insufficient funds/i.test(msg)) return 'Not enough USDC in your wallet to cover this plus gas. /deposit to top up.';
  if (/Blocked address/i.test(msg)) return 'USDC\'s issuer has blocked an address involved in this transfer, so it can\'t go through.';
  if (/TooLittleReceived|too little|slippage|minimum out/i.test(msg)) return 'The price moved past your slippage limit, so nothing was traded. Try again or raise /slippage.';
  if (/deadline|expired/i.test(msg)) return 'The trade expired before it was mined. Nothing was traded.';
  if (/nonce|replacement/i.test(msg)) return 'Your wallet had another transaction in flight. Try again in a few seconds.';
  if (/timeout|ETIMEDOUT|ECONNRESET|network/i.test(msg)) return 'The network didn\'t respond in time. Check /wallet before retrying: it may still have gone through.';
  return 'That transaction failed. If it reverted, nothing was spent except gas. Try again later.';
}
