// A small JSON-RPC node for tests: enough of Ethereum's API for the real
// Chain (src/chain.js) and ethers' JsonRpcProvider to sign, send and follow
// transactions, with faults injected per method.
import http from 'node:http';
import { Transaction, getAddress, toBeHex } from 'ethers';

const q = (n) => toBeHex(BigInt(n));
const h32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

export class MockRpc {
  constructor({ chainId = 5042 } = {}) {
    this.chainId = chainId;
    this.head = 1000;
    this.baseFee = 20_000_000_000n;
    this.balances = new Map();
    this.mined = new Map(); // address -> nonce after its last mined tx
    this.txs = new Map(); // hash -> { tx, raw, status, block }
    this.pool = new Map(); // hash -> { tx, raw } accepted, not mined
    this.faults = [];
    this.requests = [];
    this.sent = []; // every eth_sendRawTransaction the node processed: { hash, result }
    this.autoMine = true; // mine as soon as a transaction is accepted
    this.statusFor = () => 1; // (tx) -> receipt status
    this.gasUsedFor = () => 90_000n;
    this.logsFor = () => []; // (tx, hash, block) -> receipt logs
    this.estimate = () => 100_000n; // (tx) -> gas, or throws { code, message, data }
    this.call = () => '0x'; // (tx) -> result, or throws { code, message, data }
    this.nonceLag = 0; // this node answers nonces from `nonceLag` txs ago
    this.logs = []; // for eth_getLogs
    this.maxResults = Infinity;
    this.maxBlocks = Infinity;
    this.delayMs = 0;
    this.inFlight = 0;
    this.maxInFlight = 0;
  }

  // The next `times` calls of `method` get:
  //   before  HTTP 502, not processed
  //   after   processed, then HTTP 502 (the answer is lost)
  //   hangup  processed, then the connection is dropped
  //   error   a JSON-RPC error { code, message, data } instead of processing
  //   errorAfter  processed, then answered with that JSON-RPC error (a
  //           retried request refused because the first one got in)
  //   null    processed but answered null (e.g. a receipt not found yet)
  fault(method, mode, { times = 1, error } = {}) {
    this.faults.push({ method, mode, times, error });
  }

  count(method) {
    return this.requests.filter((m) => m === method).length;
  }

  mine(hash) {
    const p = this.pool.get(hash);
    if (!p) return;
    this.pool.delete(hash);
    this.head += 1;
    const from = p.tx.from.toLowerCase();
    this.mined.set(from, Math.max(this.mined.get(from) ?? 0, p.tx.nonce + 1));
    this.txs.set(hash, { ...p, status: this.statusFor(p.tx), block: this.head });
  }

  #take(method) {
    const i = this.faults.findIndex((f) => f.method === method);
    if (i < 0) return null;
    const f = this.faults[i];
    if (--f.times <= 0) this.faults.splice(i, 1);
    return f;
  }

  #nonce(addr) {
    const n = this.mined.get(addr.toLowerCase()) ?? 0;
    return Math.max(0, n - this.nonceLag);
  }

  #receipt(hash) {
    const t = this.txs.get(hash);
    if (!t) return null;
    const blockHash = h32(t.block);
    const logs = this.logsFor(t.tx, hash, t.block).map((l, i) => ({
      removed: false, logIndex: q(i), transactionIndex: '0x0', transactionHash: hash, blockHash, blockNumber: q(t.block),
      address: l.address, data: l.data, topics: l.topics,
    }));
    return {
      transactionHash: hash, transactionIndex: '0x0', blockHash, blockNumber: q(t.block), from: t.tx.from, to: t.tx.to,
      cumulativeGasUsed: q(this.gasUsedFor(t.tx)), gasUsed: q(this.gasUsedFor(t.tx)), contractAddress: null, logs,
      logsBloom: '0x' + '00'.repeat(256), status: q(t.status), effectiveGasPrice: q(this.baseFee), type: '0x2',
    };
  }

  #process(method, params) {
    switch (method) {
      case 'eth_chainId': return q(this.chainId);
      case 'eth_blockNumber': return q(this.head);
      case 'eth_getTransactionCount': return q(this.#nonce(params[0]));
      case 'eth_getBalance': return q(this.balances.get(params[0].toLowerCase()) ?? 10n ** 24n);
      case 'eth_getCode': return '0x';
      case 'eth_gasPrice': return q(this.baseFee);
      case 'eth_maxPriorityFeePerGas': return '0x0';
      case 'eth_getBlockByNumber': return {
        hash: h32(this.head), parentHash: h32(this.head - 1), number: q(this.head), timestamp: q(1_800_000_000 + this.head),
        nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: q(30_000_000), gasUsed: '0x0', miner: '0x' + '00'.repeat(20),
        extraData: '0x', baseFeePerGas: q(this.baseFee), transactions: [],
      };
      case 'eth_estimateGas': return q(this.estimate(params[0]));
      case 'eth_call': return this.call(params[0], params[1]);
      case 'eth_sendRawTransaction': {
        const tx = Transaction.from(params[0]);
        const hash = tx.hash;
        const result = (() => {
          if (this.txs.has(hash) || this.pool.has(hash)) throw { code: -32000, message: 'already known' };
          if (tx.nonce < (this.mined.get(tx.from.toLowerCase()) ?? 0)) throw { code: -32000, message: 'nonce too low' };
          this.pool.set(hash, { tx, raw: params[0] });
          if (this.autoMine) this.mine(hash);
          return hash;
        });
        try {
          const r = result();
          this.sent.push({ hash, tx, result: 'accepted' });
          return r;
        } catch (e) {
          this.sent.push({ hash, tx, result: e.message });
          throw e;
        }
      }
      case 'eth_getTransactionReceipt': return this.#receipt(params[0]);
      case 'eth_getTransactionByHash': {
        const t = this.txs.get(params[0]) ?? this.pool.get(params[0]);
        return t ? { hash: params[0], from: t.tx.from, nonce: q(t.tx.nonce) } : null;
      }
      case 'eth_getLogs': {
        const f = params[0];
        const from = Number(BigInt(f.fromBlock));
        const to = Number(BigInt(f.toBlock));
        if (to - from + 1 > this.maxBlocks) throw { code: -32012, message: 'requested range too large' };
        const want = (l) => (!f.address || l.address.toLowerCase() === String(f.address).toLowerCase())
          && (f.topics ?? []).every((t, i) => t == null || (Array.isArray(t) ? t : [t]).some((x) => x.toLowerCase() === l.topics[i]?.toLowerCase()));
        const out = [];
        for (const l of this.logs) {
          if (l.blockNumber < from || l.blockNumber > to || !want(l)) continue;
          if (out.length >= this.maxResults) {
            throw { code: -32602, message: `request exceeded max allowed range: query exceeds max results ${this.maxResults}, retry with the range ${from}-${l.blockNumber - 1}` };
          }
          out.push({
            address: getAddress(l.address), topics: l.topics, data: l.data, blockNumber: q(l.blockNumber), blockHash: h32(l.blockNumber),
            transactionHash: l.transactionHash ?? h32(0xabc000 + out.length), transactionIndex: '0x0', logIndex: q(out.length), removed: false,
          });
        }
        return out;
      }
      default: throw { code: -32601, message: `the method ${method} does not exist/is not available` };
    }
  }

  async listen() {
    this.server = http.createServer(async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      const payload = JSON.parse(body);
      const one = async (r) => {
        this.requests.push(r.method);
        const fault = this.#take(r.method);
        if (fault?.mode === 'before') return { http: 502 };
        if (fault?.mode === 'error') return { jsonrpc: '2.0', id: r.id, error: fault.error };
        let out;
        try {
          const result = this.#process(r.method, r.params ?? []);
          out = { jsonrpc: '2.0', id: r.id, result: fault?.mode === 'null' ? null : result };
        } catch (e) {
          out = { jsonrpc: '2.0', id: r.id, error: { code: e.code ?? -32000, message: e.message ?? String(e), ...(e.data ? { data: e.data } : {}) } };
        }
        if (fault?.mode === 'after') return { http: 502 };
        if (fault?.mode === 'hangup') return { hangup: true };
        if (fault?.mode === 'errorAfter') return { jsonrpc: '2.0', id: r.id, error: fault.error };
        return out;
      };
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      try {
        if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
        const results = Array.isArray(payload) ? await Promise.all(payload.map(one)) : [await one(payload)];
        if (results.some((r) => r.hangup)) {
          req.socket.destroy();
          return;
        }
        if (results.some((r) => r.http)) {
          res.writeHead(502, { 'content-type': 'text/plain' });
          res.end('Bad Gateway');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(Array.isArray(payload) ? results : results[0]));
      } finally {
        this.inFlight--;
      }
    });
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    return this.url;
  }

  close() {
    this.server?.closeAllConnections?.();
    return new Promise((r) => this.server.close(r));
  }
}
