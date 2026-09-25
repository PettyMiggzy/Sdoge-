import {
  Contract, FetchRequest, Interface, JsonRpcProvider, Network, Transaction, ZeroAddress, getAddress,
  isError, keccak256, solidityPacked, toBeHex, zeroPadValue,
} from 'ethers';
import { ERC20_ABI, FACTORY_ABI, HOOK_ABI, ROUTER_ABI, VAULT_ABI } from './abi.js';
import { TxError, decodeRevert, failureReason } from './errors.js';
import { Limiter, sleep } from './util.js';

const erc20Iface = new Interface(ERC20_ABI);
const factoryIface = new Interface(FACTORY_ABI);
const TRANSFER_TOPIC = erc20Iface.getEvent('Transfer').topicHash;
export const LAUNCHED_TOPIC = factoryIface.getEvent('Launched').topicHash;

// Every bot transaction's gas limit: the estimate plus a margin. Anyone can
// change the state an estimate was made on before the transaction lands (a
// permissionless claimPlatform() zeroing a fee slot costs a buy +17,100 gas),
// and only the gas actually used is charged.
export const withGasMargin = (est) => (BigInt(est) * 12n) / 10n + 30_000n;

// JsonRpcProvider with a cap on requests in flight, so bursts of user taps
// can't flood the public RPC (and get the bot's IP rate-limited).
class LimitedJsonRpcProvider extends JsonRpcProvider {
  #limiter;

  constructor(url, network, options, maxConcurrent) {
    super(url, network, options);
    this.#limiter = new Limiter(maxConcurrent);
  }

  _send(payload) {
    return this.#limiter.run(() => super._send(payload));
  }
}

export function makeProvider(cfg) {
  const network = new Network('arc', cfg.chainId);
  const req = new FetchRequest(cfg.rpcUrl);
  req.timeout = 20000;
  // cacheTimeout -1: ethers otherwise shares identical requests for 250 ms,
  // which handed a back-to-back transaction the previous one's nonce.
  return new LimitedJsonRpcProvider(req, network, { staticNetwork: network, batchMaxCount: 1, cacheTimeout: -1 }, cfg.rpcMaxConcurrent ?? 8);
}

// Sum of ERC-20 Transfers of `token` to `to` inside one receipt. Used instead
// of balance deltas, which would also pick up gas and unrelated transfers.
function received(receipt, token, to) {
  const t = token.toLowerCase();
  const toTopic = '0x' + to.toLowerCase().slice(2).padStart(64, '0');
  let sum = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== t || log.topics[0] !== TRANSFER_TOPIC || log.topics[2] !== toTopic) continue;
    sum += BigInt(log.data);
  }
  return sum;
}

// A JSON-RPC answer from the node itself refusing the transaction (as opposed
// to a transport failure, after which the transaction may well be in).
const REFUSAL_RE = /insufficient funds|nonce too low|nonce has already been used|nonce expired|replacement transaction underpriced|transaction underpriced|underpriced|intrinsic gas too low|exceeds block gas limit|gas limit reached|fee cap|max fee per gas less than|exceeds the configured cap|invalid sender|invalid chain id|not supported|blocked|blacklist/i;
const ALREADY_KNOWN_RE = /already known|known transaction|already imported|already exists/i;

function nodeAnswer(err) {
  const e = err?.info?.error ?? err?.error;
  return typeof e?.message === 'string' ? e.message : null;
}

function isRefusal(err) {
  if (isError(err, 'INSUFFICIENT_FUNDS') || isError(err, 'NONCE_EXPIRED') || isError(err, 'REPLACEMENT_UNDERPRICED')) return true;
  const answer = nodeAnswer(err);
  return answer !== null && !ALREADY_KNOWN_RE.test(answer) && REFUSAL_RE.test(answer);
}

// Everything the bot does on-chain goes through here, so tests can swap in a fake.
//
// Every write goes through #send: sign, hand the hash to `track.onSigned`
// (which persists it) BEFORE broadcasting, broadcast, then poll the receipt
// ourselves. The outcome is always one of: a receipt with status 1, or a
// TxError whose `outcome` says what is known about the money (see errors.js).
// Nothing here uses tx.wait(): its internal polling leaks unhandled
// rejections on RPC errors.
//
// `track` (all optional): { label, onSigned(hash, info), onFinal(hash, outcome) }
// onFinal gets 'confirmed' | 'reverted' | 'refused' once the outcome is known.
export class Chain {
  #nextNonce = new Map();

  constructor(cfg, provider, { txTimeoutMs = 120_000, pollMs = 500, maxPollMs = 4000, now = () => Date.now() } = {}) {
    this.cfg = cfg;
    this.provider = provider;
    this.txTimeoutMs = txTimeoutMs;
    this.pollMs = pollMs;
    this.maxPollMs = maxPollMs;
    this.now = now;
    this.usdc = new Contract(cfg.usdc, ERC20_ABI, provider);
    this.poolManager = new Contract(cfg.poolManager, ['function extsload(bytes32) view returns (bytes32)'], provider);
    this.factory = cfg.factory ? new Contract(cfg.factory, FACTORY_ABI, provider) : null;
    this.hook = cfg.hook ? new Contract(cfg.hook, HOOK_ABI, provider) : null;
    this.router = cfg.router ? new Contract(cfg.router, ROUTER_ABI, provider) : null;
  }

  get canLaunch() { return Boolean(this.factory); }
  get canTrade() { return Boolean(this.router); }
  get canClaim() { return Boolean(this.hook); }

  // PoolManager slot0 via extsload (StateLibrary layout: pools mapping at slot
  // 6). Verified against a live SDOGE-pool Swap event's sqrtPriceX96.
  async poolSqrtPrice(poolId) {
    const slot = keccak256(solidityPacked(['bytes32', 'bytes32'], [poolId, zeroPadValue(toBeHex(6), 32)]));
    const word = BigInt(await this.poolManager.extsload(slot));
    return word & ((1n << 160n) - 1n);
  }

  blockNumber() { return this.provider.getBlockNumber(); }
  nativeBalance(addr) { return this.provider.getBalance(addr); }
  tokenBalance(token, addr) { return new Contract(token, ERC20_ABI, this.provider).balanceOf(addr); }
  async isContract(addr) { return (await this.provider.getCode(addr)) !== '0x'; }
  getLogs(filter) { return this.provider.getLogs(filter); }

  // null while unknown; throws on RPC errors (so callers can tell the two apart).
  async getReceipt(hash) {
    const r = await this.provider.getTransactionReceipt(hash);
    return r && r.blockNumber != null ? r : null;
  }

  // ---------- the one write path ----------

  async #nonce(from) {
    const onChain = await this.provider.getTransactionCount(from, 'pending');
    // Never go below a nonce this process has seen mined: a load-balanced RPC
    // can answer from a node a block behind.
    return Math.max(onChain, this.#nextNonce.get(from) ?? 0);
  }

  async #send(signer, req, track = {}) {
    const from = signer.address;
    const label = track.label ?? null;
    let tx;
    try {
      const est = await this.provider.estimateGas({ ...req, from });
      const nonce = await this.#nonce(from);
      tx = await signer.populateTransaction({ ...req, from, nonce, gasLimit: withGasMargin(est) });
    } catch (err) {
      throw new TxError('not_sent', `not sent: ${err.shortMessage ?? err.message}`, { cause: err, reason: failureReason(err), label });
    }
    const signed = await signer.signTransaction(tx);
    const hash = Transaction.from(signed).hash;
    try {
      await track.onSigned?.(hash, { label, nonce: tx.nonce });
    } catch (err) {
      throw new TxError('not_sent', `could not record ${hash} before sending it: ${err.message}`, { cause: err, label });
    }

    let refusal = null;
    try {
      await this.provider.send('eth_sendRawTransaction', [signed]);
    } catch (err) {
      // A lost response, a 5xx, a timeout or a dropped socket all leave the
      // transaction possibly accepted: only a node's explicit refusal doesn't.
      if (isRefusal(err)) refusal = err;
    }
    if (refusal) {
      // A refusal is final only if the chain doesn't know this exact
      // transaction (a retried request can be refused for a tx already in).
      const seen = await this.#lookup(hash);
      if (seen.receipt) return this.#settle(hash, seen.receipt, tx, track);
      if (seen.state === 'absent') {
        track.onFinal?.(hash, 'refused');
        throw new TxError('refused', `refused: ${refusal.shortMessage ?? refusal.message}`, { hash, cause: refusal, reason: failureReason(refusal), label });
      }
    }
    const receipt = await this.#waitReceipt(hash, signed);
    if (!receipt) throw new TxError('unknown', `no receipt for ${hash} after ${this.txTimeoutMs} ms`, { hash, label });
    return this.#settle(hash, receipt, tx, track);
  }

  async #lookup(hash) {
    for (let i = 0; i < 2; i++) {
      if (i) await sleep(this.pollMs);
      try {
        const receipt = await this.getReceipt(hash);
        if (receipt) return { receipt };
        if (await this.provider.send('eth_getTransactionByHash', [hash])) return { state: 'pending' };
      } catch {
        return { state: 'error' };
      }
    }
    return { state: 'absent' };
  }

  async #waitReceipt(hash, signed) {
    const deadline = this.now() + this.txTimeoutMs;
    let delay = this.pollMs;
    for (let i = 1; ; i++) {
      await sleep(delay);
      const receipt = await this.getReceipt(hash).catch(() => null);
      if (receipt) return receipt;
      if (this.now() + delay >= deadline) return null;
      delay = Math.min(delay * 2, this.maxPollMs);
      // The same signed bytes again, in case the first broadcast never
      // arrived. Same nonce: it can never execute twice.
      if (i % 3 === 0) await this.provider.send('eth_sendRawTransaction', [signed]).catch(() => {});
    }
  }

  async #settle(hash, receipt, tx, track) {
    const from = tx.from;
    this.#nextNonce.set(from, Math.max(this.#nextNonce.get(from) ?? 0, Number(tx.nonce) + 1));
    if (receipt.status === 1) {
      track.onFinal?.(hash, 'confirmed');
      return receipt;
    }
    track.onFinal?.(hash, 'reverted');
    throw new TxError('reverted', `transaction reverted: ${hash}`, { hash, receipt, reason: await this.#revertReason(tx, receipt), label: track.label ?? null });
  }

  // Mined reverts carry no data. Out of gas shows as (nearly) all gas used;
  // otherwise replaying the call on the state it was mined into usually
  // reverts again with the real custom error. Best effort only.
  async #revertReason(tx, receipt) {
    try {
      if (BigInt(receipt.gasUsed) * 100n >= BigInt(tx.gasLimit) * 97n) return { name: 'out_of_gas' };
      await this.provider.call({ from: tx.from, to: tx.to, data: tx.data, value: tx.value, gasLimit: tx.gasLimit, blockTag: receipt.blockNumber });
    } catch (err) {
      return decodeRevert(err);
    }
    return null;
  }

  // ---------- actions ----------

  async #ensureAllowance(signer, token, spender, amount, track) {
    const erc20 = new Contract(token, ERC20_ABI, this.provider);
    if ((await erc20.allowance(signer.address, spender)) >= amount) return;
    // Exact amount, not unlimited: a bug or compromise in the spender can
    // never reach more than the trade the user just confirmed.
    const req = await erc20.approve.populateTransaction(spender, amount);
    await this.#send(signer, req, { ...track, label: 'approve' });
  }

  launchFee() { return this.factory.launchFee(); }

  async estimateLaunch(signer, { name, symbol, uri }, fee) {
    const req = await this.factory.launch.populateTransaction(name, symbol, uri, { value: fee });
    const gas = withGasMargin(await this.provider.estimateGas({ ...req, from: signer.address }));
    const { maxFeePerGas, gasPrice } = await this.provider.getFeeData();
    return { fee, gasCost: gas * (maxFeePerGas ?? gasPrice ?? 0n) };
  }

  // The Launched event in a receipt, or null.
  launchedEvent(receipt) {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.cfg.factory.toLowerCase()) continue;
      let parsed;
      try { parsed = factoryIface.parseLog(log); } catch { parsed = null; }
      if (parsed?.name !== 'Launched') continue;
      return {
        index: Number(parsed.args.index),
        poolId: parsed.args.poolId,
        token: getAddress(parsed.args.token),
        vault: getAddress(parsed.args.vault),
        creator: getAddress(parsed.args.creator),
      };
    }
    return null;
  }

  // `fee` is exactly what the user was shown: the factory requires
  // msg.value == launchFee, so if the fee changed since the preview this
  // reverts (WrongLaunchFee) instead of charging a different amount.
  async launch(signer, { name, symbol, uri }, fee, track = {}) {
    const req = await this.factory.launch.populateTransaction(name, symbol, uri, { value: fee });
    const receipt = await this.#send(signer, req, { ...track, label: 'launch' });
    const ev = this.launchedEvent(receipt);
    if (!ev) throw new Error(`launch mined without a Launched event: ${receipt.hash}`);
    return { txHash: receipt.hash, ...ev };
  }

  quoteBuy(token, usdcIn) { return this.router.quoteBuy.staticCall(token, usdcIn); }
  quoteSell(token, tokensIn) { return this.router.quoteSell.staticCall(token, tokensIn); }

  // Paid with native USDC (18 decimals, same balance as the 6-decimal ERC-20
  // view): one transaction, no approval to leave behind.
  async buy(signer, token, usdcIn, minOut, deadline, track = {}) {
    const req = await this.router.buyWithNative.populateTransaction(token, minOut, signer.address, deadline, { value: usdcIn * 10n ** 12n });
    const receipt = await this.#send(signer, req, { ...track, label: 'buy' });
    return { txHash: receipt.hash, received: received(receipt, token, signer.address) };
  }

  async sell(signer, token, tokensIn, minUsdcOut, deadline, track = {}) {
    await this.#ensureAllowance(signer, token, this.cfg.router, tokensIn, track);
    const req = await this.router.sell.populateTransaction(token, tokensIn, minUsdcOut, signer.address, deadline);
    const receipt = await this.#send(signer, req, { ...track, label: 'sell' });
    return { txHash: receipt.hash, received6: received(receipt, this.cfg.usdc, signer.address) };
  }

  owed(addr) { return this.hook.owed(addr); }

  async claim(signer, track = {}) {
    const req = await this.hook.claim.populateTransaction(signer.address);
    const receipt = await this.#send(signer, req, { ...track, label: 'claim' });
    return { txHash: receipt.hash, received6: received(receipt, this.cfg.usdc, signer.address) };
  }

  // backing6: USDC behind the token; supply: tokens sharing it; floor18: USDC
  // per whole token with 18 decimals (floorPrice()).
  async vaultState(vault) {
    const v = new Contract(vault, VAULT_ABI, this.provider);
    const [backing6, supply, floor18] = await Promise.all([v.backing(), v.effectiveSupply(), v.floorPrice()]);
    return { backing6, supply, floor18 };
  }

  quoteRedeem(vault, amount) { return new Contract(vault, VAULT_ABI, this.provider).quoteRedeem(amount); }

  // minOut is the previewed payout: the floor never drops, so the real payout
  // can only be equal or higher unless something is badly wrong.
  async redeem(signer, { token, vault }, amount, minOut, track = {}) {
    await this.#ensureAllowance(signer, token, vault, amount, track);
    const req = await new Contract(vault, VAULT_ABI, this.provider).redeem.populateTransaction(amount, minOut, signer.address);
    const receipt = await this.#send(signer, req, { ...track, label: 'redeem' });
    return { txHash: receipt.hash, received6: received(receipt, this.cfg.usdc, signer.address) };
  }

  // Everything but the gas a transfer can be charged: its gas limit (with the
  // same margin #send uses) times the max fee.
  async maxWithdrawable(signer, to) {
    const [balance, gas, { maxFeePerGas, gasPrice }] = await Promise.all([
      this.provider.getBalance(signer.address),
      this.provider.estimateGas({ from: signer.address, to, value: 1n }),
      this.provider.getFeeData(),
    ]);
    const cost = withGasMargin(gas) * (maxFeePerGas ?? gasPrice ?? 0n);
    return balance > cost ? balance - cost : 0n;
  }

  async withdraw(signer, to, value, track = {}) {
    if (to === ZeroAddress) throw new Error('refusing to send to the zero address');
    const receipt = await this.#send(signer, { to, value }, { ...track, label: 'withdraw' });
    return { txHash: receipt.hash };
  }
}
