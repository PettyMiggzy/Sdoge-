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
process.env.ARC_RPC_FALLBACK_URL = `http://127.0.0.1:${backup.address().port}`;
const { verifyPayment } = await import('../_lib/chain.mjs');
test.after(() => backup.close());

test('a payment is checked on the backup RPC when the public one is down', async () => {
  const p = await verifyPayment(hash, payer);
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.credits, 1);
  assert.equal(backupCalls, 3);
});

test('without a backup, the failure shows', async () => {
  delete process.env.ARC_RPC_FALLBACK_URL;
  await assert.rejects(verifyPayment(hash, payer));
});
