// The real Chain (src/chain.js) and ethers provider against a mock JSON-RPC
// node with injected faults: what is known about each transaction's money.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, Wallet, getAddress } from 'ethers';
import { Chain, makeProvider, withGasMargin } from '../src/chain.js';
import { ERC20_ABI, FACTORY_ABI } from '../src/abi.js';
import { TxError, decodeRevert, describeFailure } from '../src/errors.js';
import { E18, makeCfg } from './helpers.js';
import { MockRpc } from './rpcmock.js';

const DEST = getAddress('0x1234567890123456789012345678901234567890');
const KEY = '0x' + '11'.repeat(32);
const errors = new Interface([
  'error InsufficientOutput(uint256 out, uint256 minOut)',
  'error WrongLaunchFee(uint256 sent, uint256 required)',
  'error PriceAboveStart()',
  'error WrappedError(address target, bytes4 selector, bytes reason, bytes details)',
]);
const factoryIface = new Interface(FACTORY_ABI);

async function setup({ chainOpts = {} } = {}) {
  const rpc = new MockRpc();
  const url = await rpc.listen();
  const cfg = makeCfg({ rpcUrl: url });
  const provider = makeProvider(cfg);
  const chain = new Chain(cfg, provider, { pollMs: 10, maxPollMs: 40, txTimeoutMs: 1500, ...chainOpts });
  const wallet = new Wallet(KEY, provider);
  const log = [];
  const track = {
    onSigned: async (hash, info) => { log.push(['signed', hash, info.label, rpc.count('eth_sendRawTransaction')]); },
    onFinal: (hash, outcome) => { log.push(['final', hash, outcome]); },
  };
  return {
    rpc, cfg, provider, chain, wallet, log, track,
    close: async () => { provider.destroy(); await rpc.close(); },
  };
}

const accepted = (rpc) => rpc.sent.filter((s) => s.result === 'accepted');

test('R2-TGPAD-01: the node took the withdraw but its answer was lost (HTTP 502): it is followed to its receipt, sent once', async () => {
  const s = await setup();
  try {
    s.rpc.fault('eth_sendRawTransaction', 'after');
    const res = await s.chain.withdraw(s.wallet, DEST, 30n * E18, s.track);
    assert.equal(accepted(s.rpc).length, 1, 'exactly one transfer ever went out');
    assert.equal(res.txHash, accepted(s.rpc)[0].hash);
    assert.deepEqual(s.log.map((x) => x.slice(0, 3)), [['signed', res.txHash, 'withdraw'], ['final', res.txHash, 'confirmed']]);
    assert.equal(s.log[0][3], 0, 'the hash was handed over (and persisted) before anything was broadcast');
  } finally { await s.close(); }
});

test('R2-TGPAD-01: a dropped socket after the send, or failing receipt lookups, still end in a confirmed receipt', async () => {
  const s = await setup();
  try {
    s.rpc.fault('eth_sendRawTransaction', 'hangup');
    await s.chain.withdraw(s.wallet, DEST, E18, s.track);
    s.rpc.fault('eth_getTransactionReceipt', 'before', { times: 3 });
    await s.chain.withdraw(s.wallet, DEST, E18, s.track);
    assert.equal(accepted(s.rpc).length, 2);
    assert.deepEqual(s.log.filter((x) => x[0] === 'final').map((x) => x[2]), ['confirmed', 'confirmed']);
  } finally { await s.close(); }
});

test('R2-TGPAD-01: accepted but never mined: outcome "unknown" with the hash, re-pushed with the same bytes, never re-signed', async () => {
  const s = await setup();
  try {
    s.rpc.autoMine = false;
    const err = await s.chain.withdraw(s.wallet, DEST, 30n * E18, s.track).catch((e) => e);
    assert.ok(err instanceof TxError);
    assert.equal(err.outcome, 'unknown');
    assert.equal(err.hash, accepted(s.rpc)[0].hash);
    assert.ok(s.rpc.sent.length >= 2, 'broadcast again while waiting');
    assert.ok(s.rpc.sent.every((x) => x.hash === err.hash), 'always the same signed transaction');
    assert.equal(s.rpc.pool.size, 1);
    assert.equal(s.log.filter((x) => x[0] === 'final').length, 0, 'no outcome was claimed');
    const text = describeFailure(err, { explorerUrl: s.cfg.explorerUrl, kind: 'withdraw' });
    assert.match(text, /not confirmed yet/);
    assert.match(text, /Don't retry/);
    assert.match(text, new RegExp(`/tx/${err.hash}`));
    assert.doesNotMatch(text, /nothing was spent/i);
  } finally { await s.close(); }
});

test('R2-TGPAD-01/-11: mined but reverted: outcome "reverted" with the hash, reason recovered by replaying the call', async () => {
  const s = await setup();
  try {
    s.rpc.statusFor = () => 0;
    s.rpc.call = () => { throw { code: 3, message: 'execution reverted', data: errors.encodeErrorResult('InsufficientOutput', [1n, 2n]) }; };
    const err = await s.chain.withdraw(s.wallet, DEST, E18, s.track).catch((e) => e);
    assert.equal(err.outcome, 'reverted');
    assert.equal(err.hash, accepted(s.rpc)[0].hash);
    assert.equal(err.reason.name, 'InsufficientOutput');
    assert.deepEqual(s.log.at(-1).slice(2), ['reverted']);
    const text = describeFailure(err, { explorerUrl: s.cfg.explorerUrl, kind: 'buy' });
    assert.match(text, /reverted on-chain<\/b>: The price moved past your slippage limit/);
    assert.match(text, /only the gas fee was spent/);
  } finally { await s.close(); }
});

test('R2-TGPAD-22: a revert that used (nearly) all its gas is reported as out of gas', async () => {
  const s = await setup();
  try {
    s.rpc.statusFor = () => 0;
    s.rpc.gasUsedFor = (tx) => tx.gasLimit;
    const err = await s.chain.withdraw(s.wallet, DEST, E18, s.track).catch((e) => e);
    assert.equal(err.outcome, 'reverted');
    assert.equal(err.reason.name, 'out_of_gas');
  } finally { await s.close(); }
});

test('R2-TGPAD-01/-11: estimateGas says it would revert: "not_sent", nothing signed or broadcast, custom error decoded', async () => {
  const s = await setup();
  try {
    s.rpc.estimate = () => { throw { code: 3, message: 'execution reverted', data: errors.encodeErrorResult('InsufficientOutput', [5n, 9n]) }; };
    const err = await s.chain.withdraw(s.wallet, DEST, E18, s.track).catch((e) => e);
    assert.equal(err.outcome, 'not_sent');
    assert.deepEqual(err.reason, { name: 'InsufficientOutput', args: [5n, 9n] });
    assert.equal(s.rpc.count('eth_sendRawTransaction'), 0);
    assert.equal(s.log.length, 0);
    assert.match(describeFailure(err, { kind: 'buy' }), /slippage limit, so nothing was sent and nothing was spent/);
  } finally { await s.close(); }
});

test('R2-TGPAD-01: a node refusal is "refused" only if the chain doesn\'t know the transaction', async () => {
  const s = await setup();
  try {
    s.rpc.fault('eth_sendRawTransaction', 'error', { error: { code: -32000, message: 'insufficient funds for gas * price + value' } });
    const err = await s.chain.withdraw(s.wallet, DEST, E18, s.track).catch((e) => e);
    assert.equal(err.outcome, 'refused');
    assert.equal(err.reason.name, 'insufficient_funds');
    assert.equal(accepted(s.rpc).length, 0);
    assert.deepEqual(s.log.at(-1).slice(2), ['refused']);

    // A retried request refused because the first attempt already got in.
    s.rpc.fault('eth_sendRawTransaction', 'errorAfter', { error: { code: -32000, message: 'nonce too low' } });
    const res = await s.chain.withdraw(s.wallet, DEST, E18, s.track);
    assert.equal(res.txHash, accepted(s.rpc)[0].hash);
    assert.deepEqual(s.log.at(-1).slice(2), ['confirmed']);
  } finally { await s.close(); }
});

test('R2-TGPAD-01: if the hash can\'t be recorded before sending, nothing is broadcast', async () => {
  const s = await setup();
  try {
    const err = await s.chain.withdraw(s.wallet, DEST, E18, { onSigned: async () => { throw new Error('disk full'); } }).catch((e) => e);
    assert.equal(err.outcome, 'not_sent');
    assert.equal(s.rpc.count('eth_sendRawTransaction'), 0);
  } finally { await s.close(); }
});

test('R2-TGPAD-01: a sell whose approval is still unconfirmed says the sell itself was not sent', async () => {
  const s = await setup();
  try {
    const erc20 = new Interface(ERC20_ABI);
    s.rpc.call = (tx) => (tx.data.startsWith(erc20.getFunction('allowance').selector) ? erc20.encodeFunctionResult('allowance', [0n]) : '0x');
    s.rpc.autoMine = false;
    const token = getAddress('0x7700000000000000000000000000000000000001');
    const err = await s.chain.sell(s.wallet, token, 10n * E18, 1n, 9_999_999_999, s.track).catch((e) => e);
    assert.equal(err.outcome, 'unknown');
    assert.equal(err.label, 'approve');
    assert.equal(accepted(s.rpc).length, 1, 'only the approval went out');
    const text = describeFailure(err, { explorerUrl: s.cfg.explorerUrl, kind: 'sell' });
    assert.match(text, /the sell itself was <b>not<\/b> sent and nothing was traded/);
  } finally { await s.close(); }
});

test('R2-TGPAD-03: failing receipt polls raise no unhandled rejection, and nothing is left subscribed', async () => {
  const s = await setup();
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    s.provider.pollingInterval = 20;
    s.rpc.autoMine = false;
    s.rpc.fault('eth_getTransactionReceipt', 'null', { times: 2 });
    s.rpc.fault('eth_getTransactionReceipt', 'before', { times: 3 });
    const sending = s.chain.withdraw(s.wallet, DEST, E18, {
      onSigned: async (hash) => { setTimeout(() => s.rpc.mine(hash), 150); },
    });
    const res = await sending;
    assert.ok(res.txHash);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(unhandled.length, 0, 'no rejection escaped');
    assert.equal(await s.provider.listenerCount(), 0, 'no ethers subscriber is polling in the background');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await s.close();
  }
});

test('R2-TGPAD-07: a launch sends exactly the fee the user was shown; a changed fee fails instead of being charged', async () => {
  const s = await setup();
  try {
    let currentFee = 100n * E18;
    const wrongFee = (tx) => tx.to?.toLowerCase() === s.cfg.factory.toLowerCase() && BigInt(tx.value ?? 0) !== currentFee;
    s.rpc.estimate = (tx) => {
      if (wrongFee(tx)) throw { code: 3, message: 'execution reverted', data: errors.encodeErrorResult('WrongLaunchFee', [BigInt(tx.value), currentFee]) };
      return 1_600_000n;
    };
    const token = getAddress('0x7700000000000000000000000000000000000abc');
    s.rpc.logsFor = (tx) => {
      const { data, topics } = factoryIface.encodeEventLog('Launched', [0, '0x' + 'cd'.repeat(32), token, token, tx.from, 'Good Doge', 'GDOG', '']);
      return [{ address: s.cfg.factory, data, topics }];
    };
    const draft = { name: 'Good Doge', symbol: 'GDOG', uri: '' };
    const err = await s.chain.launch(s.wallet, draft, 2n * E18, s.track).catch((e) => e);
    assert.equal(err.outcome, 'not_sent');
    assert.equal(err.reason.name, 'WrongLaunchFee');
    assert.equal(s.rpc.count('eth_sendRawTransaction'), 0, 'nothing charged');
    assert.match(describeFailure(err, { kind: 'launch' }), /The launch fee changed from 2 to 100 USDC, so nothing was sent and nothing was spent\. Start \/launch again/);

    currentFee = 2n * E18;
    const res = await s.chain.launch(s.wallet, draft, 2n * E18, s.track);
    assert.equal(accepted(s.rpc)[0].tx.value, 2n * E18, 'msg.value is exactly the previewed fee');
    assert.equal(res.token, token);
    assert.equal(res.creator, s.wallet.address);
  } finally { await s.close(); }
});

test('R2-TGPAD-22: every transaction is sent with the estimate plus a margin', async () => {
  const s = await setup();
  try {
    s.rpc.estimate = () => 151_925n;
    await s.chain.withdraw(s.wallet, DEST, E18, s.track);
    const gasLimit = accepted(s.rpc)[0].tx.gasLimit;
    assert.equal(gasLimit, withGasMargin(151_925n));
    assert.equal(gasLimit, 212_310n, 'est * 1.2 + 30k: covers the +17,100 gas a racing claimPlatform() adds');
  } finally { await s.close(); }
});

test('R2-TGPAD-09: no request cache, and a lagging node can\'t hand back a nonce already used', async () => {
  const s = await setup();
  try {
    await Promise.all([s.provider.getTransactionCount(s.wallet.address, 'pending'), s.provider.getTransactionCount(s.wallet.address, 'pending')]);
    await s.provider.getTransactionCount(s.wallet.address, 'pending');
    assert.equal(s.rpc.count('eth_getTransactionCount'), 3, 'identical reads within 250 ms each reach the node');

    await s.chain.withdraw(s.wallet, DEST, E18, s.track);
    s.rpc.nonceLag = 1; // the next answer comes from a node a block behind
    await s.chain.withdraw(s.wallet, DEST, E18, s.track);
    assert.deepEqual(accepted(s.rpc).map((x) => x.tx.nonce), [0, 1]);
    assert.ok(s.rpc.sent.every((x) => x.result === 'accepted'), 'no "nonce too low"');
  } finally { await s.close(); }
});

test('R2-TGPAD-15: the provider caps RPC requests in flight', async () => {
  const s = await setup();
  try {
    s.rpc.delayMs = 25;
    await Promise.all(Array.from({ length: 40 }, () => s.chain.nativeBalance(DEST)));
    assert.ok(s.rpc.maxInFlight <= 8, `max ${s.rpc.maxInFlight} in flight`);
    assert.ok(s.rpc.maxInFlight >= 2, 'still concurrent');
  } finally { await s.close(); }
});

test('R2-TGPAD-11: hook reverts wrapped by the PoolManager are unwrapped', () => {
  const hook = getAddress('0x2222222222222222222222222222222222222222');
  const inner = errors.encodeErrorResult('PriceAboveStart', []);
  const wrapped = errors.encodeErrorResult('WrappedError', [hook, '0x575e24b4', inner, '0xa9e35b2f']);
  assert.equal(decodeRevert(wrapped).name, 'PriceAboveStart');
  assert.equal(decodeRevert({ shortMessage: 'execution reverted (unknown custom error)', data: wrapped }).name, 'PriceAboveStart');
  assert.equal(decodeRevert('0xdeadbeef'), null);
});
