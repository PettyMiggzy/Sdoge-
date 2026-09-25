// Offline checks (no RPC). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionData, encodePacked } from 'viem';
import {
  ARC_MAINNET, buildExactInSwap, decodeSlot0, poolIdOf, poolKeyFor, priceFromSqrt, priceFromTick, universalRouterAbi, withSlippage,
} from '../dist/index.js';

// Real launches from a mainnet-fork rehearsal of the deployment in ARC_MAINNET:
// the SDK must derive exactly the pool ids the portal emitted.
test('pool ids match the chain, in both token orderings', () => {
  const a = poolKeyFor(ARC_MAINNET, '0x35fdf2d0c42BDd435e2669DB4407351ee332E4C0');
  assert.equal(a.tokenIsToken0, true);
  assert.equal(poolIdOf(a.key), '0xaa7eb4f426e37aff034c3ce5dcfcfc234868e4b60ace7932033a038cac567797');
  const b = poolKeyFor(ARC_MAINNET, '0xB480fADcdf58464951B98EE81F0566135Ab5da8E');
  assert.equal(b.tokenIsToken0, false);
  assert.equal(b.key.currency0, ARC_MAINNET.usdc);
  assert.equal(poolIdOf(b.key), '0x6709abf17720ca0236a21e788987d8f1a6e6df17350b2a89fd2dd81c0cc56fd9');
  assert.equal(a.key.fee, 10_000);
  assert.equal(a.key.tickSpacing, 200);
  assert.equal(a.key.hooks, ARC_MAINNET.hook);
});

test('slot0 decoding handles negative ticks', () => {
  const sqrt = 79228162514264337593543950336n; // 2^96
  const tick = -887200;
  const word = '0x' + ((BigInt(3000) << 208n) | ((BigInt(tick) & 0xffffffn) << 160n) | sqrt).toString(16).padStart(64, '0');
  assert.deepEqual(decodeSlot0(word), { sqrtPriceX96: sqrt, tick, lpFee: 3000 });
});

test('prices: sqrt and tick agree, and orientation flips', () => {
  const sqrt = 79228162514264337593543950336n; // raw 1:1
  assert.equal(priceFromSqrt(sqrt, true), 1e12); // 1 raw token0 per raw token1, rescaled 18 -> 6 decimals
  assert.equal(priceFromSqrt(sqrt, false), 1e12);
  const p1 = priceFromTick(-276324, true);
  assert.ok(Math.abs(p1 - 1) < 1e-3, `tick -276324 is about $1 per token (${p1})`);
  assert.equal(priceFromSqrt(0n, true), 0);
});

test('slippage floors', () => {
  assert.equal(withSlippage(10_000n, 300), 9_700n);
  assert.equal(withSlippage(1n, 9_999), 1n);
  assert.throws(() => withSlippage(1n, 10_000));
  assert.throws(() => withSlippage(1n, 1.5));
});

test('swap builder: one V4_SWAP command, and never without a minimum', () => {
  const { key } = poolKeyFor(ARC_MAINNET, '0x35fdf2d0c42BDd435e2669DB4407351ee332E4C0');
  const leg = { key, zeroForOne: false, amountIn: 5_000_000n, currencyIn: ARC_MAINNET.usdc, currencyOut: '0x35fdf2d0c42BDd435e2669DB4407351ee332E4C0' };
  assert.throws(() => buildExactInSwap({ ...leg, amountOutMin: 0n }), /minimum output/);
  const { args } = buildExactInSwap({ ...leg, amountOutMin: 1n });
  assert.equal(args[0], encodePacked(['uint8'], [0x10]));
  assert.equal(args[1].length, 1);
  assert.ok(args[2] > BigInt(Math.floor(Date.now() / 1000)));
  const data = encodeFunctionData({ abi: universalRouterAbi, functionName: 'execute', args });
  assert.equal(data.slice(0, 10), '0x3593564c');
  const back = decodeFunctionData({ abi: universalRouterAbi, data });
  assert.equal(back.functionName, 'execute');
  assert.deepEqual(back.args, [...args]);
});
