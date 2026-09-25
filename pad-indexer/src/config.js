import 'dotenv/config';
import { getAddress } from 'viem';

const addr = (k) => getAddress(process.env[k]);

export const CFG = {
  rpcUrl: process.env.RPC_URL,
  port: Number(process.env.PORT ?? 8787),
  dbPath: process.env.DB_PATH ?? './data/index.db',
  portal: addr('PORTAL'),
  hook: addr('HOOK'),
  poolManager: addr('POOL_MANAGER'),
  quote: addr('QUOTE'),
  quoteDecimals: Number(process.env.QUOTE_DECIMALS ?? 6),
  tokenDecimals: Number(process.env.TOKEN_DECIMALS ?? 18),
  totalSupply: 1_000_000_000,
  startBlock: BigInt(process.env.START_BLOCK ?? 0),
  chunk: BigInt(process.env.CHUNK_BLOCKS ?? 2000),
  pollMs: Number(process.env.POLL_MS ?? 4000),
  backfillOnly: process.env.BACKFILL_ONLY === '1',
};
