// Payment checks fall back to ARC_RPC_FALLBACK_URL when Arc's public RPC is down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Wallet, parseEther } from 'ethers';

const payer = Wallet.createRandom().address.toLowerCase();
const hash = `0x${'ab'.repeat(32)}`;
let backupCalls = 0;
const backup = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    backupCalls += 1;
    const { id, method } = JSON.parse(raw);
    const result =
      method === 'eth_blockNumber'
        ? '0x100'
        : method === 'eth_getTransactionReceipt'
          ? { status: '0x1', blockNumber: '0xf0' }
          : { hash, from: payer, to: '0x5899a0576a94327a6316e01190f951edf7645914', value: `0x${parseEther('0.25').toString(16)}`, input: '0x53444f47452053747564696f204149', chainId: '0x13b2' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
});
await new Promise((r) => backup.listen(0, '127.0.0.1', r));
// A port nothing listens on: the "public RPC" refuses every connection.
const dead = http.createServer();
await new Promise((r) => dead.listen(0, '127.0.0.1', r));
const deadUrl = `http://127.0.0.1:${dead.address().port}`;
await new Promise((r) => dead.close(r));

process.env.ARC_RPC_URL = deadUrl;
const backupUrl = `http://127.0.0.1:${backup.address().port}`;
process.env.ARC_RPC_FALLBACK_URL = backupUrl;
const { verifyPayment } = await import('../_lib/chain.mjs');
const relay = (await import('../rpc.mjs')).default;
test.after(() => backup.close());

async function callRelay(body, method = 'POST') {
  const out = { status: 0, body: '' };
  const res = { set statusCode(v) { out.status = v; }, setHeader() {}, end: (b) => (out.body = b) };
  await relay({ method, body, headers: {} }, res);
  return { status: out.status, json: JSON.parse(out.body) };
}

test('a payment is checked on the backup RPC when the public one is down', async () => {
  const p = await verifyPayment(hash, payer);
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.credits, 1);
  assert.equal(backupCalls, 3);
});

test('/api/rpc relays read calls to the backup, and nothing else', async () => {
  const read = await callRelay({ jsonrpc: '2.0', id: 7, method: 'eth_blockNumber', params: [] });
  assert.equal(read.status, 200);
  assert.deepEqual(read.json, { jsonrpc: '2.0', id: 7, result: '0x100' });
  const batch = await callRelay([{ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }, { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber' }]);
  assert.equal(batch.status, 200);
  const calls = backupCalls;
  for (const bad of [
    { jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0x00'] },
    { jsonrpc: '2.0', id: 1, method: 'eth_sign', params: [] },
    { jsonrpc: '2.0', id: 1, method: 'eth_call', params: 'x' },
    [],
    Array.from({ length: 101 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_chainId' })),
  ]) {
    assert.equal((await callRelay(bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal((await callRelay({}, 'GET')).status, 405);
  assert.equal(backupCalls, calls); // none of those reached the backup
});

test('without a backup, the failure shows', async () => {
  delete process.env.ARC_RPC_FALLBACK_URL;
  await assert.rejects(verifyPayment(hash, payer));
  assert.equal((await callRelay({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' })).status, 503);
});
