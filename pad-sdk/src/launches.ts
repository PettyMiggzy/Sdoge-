import type { Address, Hex, Log, PublicClient } from 'viem';
import { launchCreatedEvent } from './abis.js';
import type { PadConfig } from './config.js';

export type Launch = {
  token: Address;
  creator: Address;
  locker: Address;
  splitter: Address;
  poolId: Hex;
  name: string;
  symbol: string;
  tokenIsToken0: boolean;
  buyTaxBps: number;
  sellTaxBps: number;
  tickLower: number;
  tickUpper: number;
  /** The pool's opening price (sqrt, Q96). */
  initSqrtPriceX96: bigint;
  blockNumber: bigint;
  txHash: Hex;
};

/** Arc's public RPC caps eth_getLogs at 10,000 blocks per call. */
export const LOG_CHUNK = 10_000n;

type LaunchLog = Log<bigint, number, false, typeof launchCreatedEvent, true>;

export function parseLaunchLog(l: LaunchLog): Launch {
  const a = l.args;
  return {
    token: a.token, creator: a.creator, locker: a.locker, splitter: a.splitter, poolId: a.poolId,
    name: a.name, symbol: a.symbol, tokenIsToken0: a.tokenIsToken0, buyTaxBps: a.buyTaxBps, sellTaxBps: a.sellTaxBps,
    tickLower: a.tickLower, tickUpper: a.tickUpper, initSqrtPriceX96: a.initSqrtPriceX96,
    blockNumber: l.blockNumber, txHash: l.transactionHash,
  };
}

/** Every launch between two blocks, oldest first, fetched in RPC-sized chunks. */
export async function getLaunches(
  client: PublicClient,
  config: PadConfig,
  opts: { fromBlock?: bigint; toBlock?: bigint } = {},
): Promise<Launch[]> {
  const to = opts.toBlock ?? (await client.getBlockNumber());
  let from = opts.fromBlock ?? config.portalGenesisBlock;
  const out: Launch[] = [];
  while (from <= to) {
    const end = from + LOG_CHUNK - 1n > to ? to : from + LOG_CHUNK - 1n;
    const logs = await client.getLogs({ address: config.portal, event: launchCreatedEvent, fromBlock: from, toBlock: end, strict: true });
    for (const l of logs) out.push(parseLaunchLog(l as LaunchLog));
    from = end + 1n;
  }
  return out;
}

/**
 * Calls `onLaunch` for every new launch as soon as its block is visible,
 * by polling the latest block (Arc makes about two blocks a second).
 * Returns a function that stops watching.
 */
export function watchLaunches(
  client: PublicClient,
  config: PadConfig,
  onLaunch: (launch: Launch) => void | Promise<void>,
  opts: { pollIntervalMs?: number; fromBlock?: bigint; onError?: (e: unknown) => void } = {},
): () => void {
  let stopped = false;
  let next: bigint | undefined = opts.fromBlock;
  const interval = opts.pollIntervalMs ?? 500;
  (async () => {
    while (!stopped) {
      try {
        const tip = await client.getBlockNumber({ cacheTime: 0 });
        if (next === undefined) next = tip + 1n;
        if (tip >= next) {
          for (const launch of await getLaunches(client, config, { fromBlock: next, toBlock: tip })) {
            if (stopped) return;
            await onLaunch(launch);
          }
          next = tip + 1n;
        }
      } catch (e) {
        opts.onError?.(e);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  })();
  return () => { stopped = true; };
}
