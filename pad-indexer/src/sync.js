import { CFG } from './config.js';
import { client, EV, priceFromSqrt, fmtToken, fmtQuote, blockTs, txSenders } from './chain.js';
import { db, q, getMeta, setMeta } from './db.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const abs = (x) => (x < 0n ? -x : x);

/**
 * Processes one inclusive [from, to] block range in two phases: every RPC
 * read first, then every DB write — pools, balances, swaps, taxes and the
 * lastBlock cursor — in one SQLite transaction. Balance updates are deltas
 * (not idempotent), so a range must commit entirely or not at all: otherwise
 * an RPC error after the Transfer step would leave the deltas applied with
 * the cursor unmoved, and every retry would apply them again.
 */
async function processRange(from, to) {
  const launches = await client.getLogs({ address: CFG.portal, event: EV.launch, fromBlock: from, toBlock: to });
  const newPools = [];
  for (const l of launches) {
    newPools.push({
      token: l.args.token.toLowerCase(),
      creator: l.args.creator.toLowerCase(),
      locker: l.args.locker.toLowerCase(),
      splitter: l.args.splitter.toLowerCase(),
      pool_id: l.args.poolId,
      name: l.args.name,
      symbol: l.args.symbol,
      token_is_token0: l.args.tokenIsToken0 ? 1 : 0,
      buy_tax_bps: l.args.buyTaxBps,
      sell_tax_bps: l.args.sellTaxBps,
      created_at: await blockTs(l.blockNumber),
      block: Number(l.blockNumber),
      tx_hash: l.transactionHash,
    });
  }

  // Pools launched in this same range count too: their genesis mint and
  // first trades land in the launch tx.
  const pools = [...q.pools.all(), ...newPools];
  let transfers = [], swapRows = [], taxRows = [];
  if (pools.length) {
    const tokens = [...new Set(pools.map((p) => p.token))];
    const poolIds = pools.map((p) => p.pool_id);
    const poolById = new Map(pools.map((p) => [p.pool_id, p]));

    transfers = await client.getLogs({ address: tokens, event: EV.transfer, fromBlock: from, toBlock: to });

    const swaps = await client.getLogs({ address: CFG.poolManager, event: EV.swap, fromBlock: from, toBlock: to, args: { id: poolIds } });
    const senders = swaps.length ? await txSenders(swaps.map((s) => s.transactionHash)) : new Map();
    for (const s of swaps) {
      const pool = poolById.get(s.args.id);
      if (!pool) continue;
      const tokenIsToken0 = !!pool.token_is_token0;
      const a0 = s.args.amount0, a1 = s.args.amount1;
      // v4's Swap event carries the SWAPPER's balance delta (PoolManager
      // emits the BalanceDelta from Pool.swap): positive = the swapper
      // received that currency, negative = the swapper paid it. IPoolManager's
      // NatSpec says "delta of the pool", which is the opposite and wrong —
      // following it would record every buy as a sell. A buy is the swapper
      // receiving the launch token.
      const tokenDelta = tokenIsToken0 ? a0 : a1;
      const quoteDelta = tokenIsToken0 ? a1 : a0;
      swapRows.push({
        tx_hash: s.transactionHash, log_index: s.logIndex, token: pool.token, block: Number(s.blockNumber), ts: await blockTs(s.blockNumber),
        is_buy: tokenDelta > 0n ? 1 : 0,
        token_amt: fmtToken(abs(tokenDelta)),
        quote_amt: fmtQuote(abs(quoteDelta)),
        price: priceFromSqrt(s.args.sqrtPriceX96, tokenIsToken0),
        sqrt_price: s.args.sqrtPriceX96.toString(),
        trader: senders.get(s.transactionHash) ?? ZERO,
      });
    }

    const taxes = await client.getLogs({ address: CFG.hook, event: EV.tax, fromBlock: from, toBlock: to, args: { poolId: poolIds } });
    for (const t of taxes) {
      taxRows.push({
        tx_hash: t.transactionHash, log_index: t.logIndex, pool_id: t.args.poolId,
        is_buy: t.args.isBuy ? 1 : 0, amount: t.args.amount.toString(), block: Number(t.blockNumber), ts: await blockTs(t.blockNumber),
      });
    }
  }

  db.transaction(() => {
    for (const p of newPools) {
      q.insertPool.run(p);
      console.log(`[sync] launch ${p.symbol} @ ${p.token}`);
    }
    const deltas = new Map();
    for (const t of transfers) {
      const token = t.address.toLowerCase();
      const from_ = t.args.from.toLowerCase(), to_ = t.args.to.toLowerCase(), v = t.args.value;
      if (from_ !== ZERO) deltas.set(`${token}:${from_}`, (deltas.get(`${token}:${from_}`) ?? 0n) - v);
      if (to_ !== ZERO) deltas.set(`${token}:${to_}`, (deltas.get(`${token}:${to_}`) ?? 0n) + v);
    }
    for (const [key, delta] of deltas) {
      const [token, holder] = key.split(':');
      const next = BigInt(q.getBal.get(token, holder)?.balance ?? '0') + delta;
      q.setBal.run(token, holder, next.toString(), fmtToken(next));
    }
    for (const r of swapRows) q.insertSwap.run(r);
    for (const r of taxRows) q.insertTax.run(r);
    setMeta('lastBlock', (to + 1n).toString());
  })();
}

async function runRange(from, tip) {
  while (from <= tip) {
    const to = from + CFG.chunk - 1n > tip ? tip : from + CFG.chunk - 1n;
    await processRange(from, to); // advances lastBlock atomically with the range's writes
    from = to + 1n;
  }
}

export async function backfillAndTail() {
  const tip = await client.getBlockNumber();
  let from = BigInt(getMeta('lastBlock', CFG.startBlock.toString()));
  if (from < CFG.startBlock) from = CFG.startBlock;

  console.log(`[sync] backfilling ${from} -> ${tip}`);
  await runRange(from, tip);
  console.log('[sync] backfill complete');
  if (CFG.backfillOnly) return;

  console.log('[sync] tailing new blocks');
  for (;;) {
    await new Promise((r) => setTimeout(r, CFG.pollMs));
    try {
      const newTip = await client.getBlockNumber();
      const last = BigInt(getMeta('lastBlock', '0'));
      if (newTip >= last) await runRange(last, newTip);
    } catch (e) {
      console.error('[sync] poll error', e.message);
    }
  }
}
