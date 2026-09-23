#!/usr/bin/env node
// $SDOGE buy-alert bot.
//
// Polls Arc for Transfer events that move SDOGE out of the liquidity pool
// (= someone bought) and posts an alert to Telegram. Designed to run on a
// schedule (GitHub Actions cron) rather than as a long-lived process, so
// all state lives in state.json and is committed back between runs.
//
// Required env vars (see bot/README.md for how to obtain each one):
//   SDOGE_TOKEN_ADDRESS   - the $SDOGE ERC-20 contract on Arc
//   POOL_ADDRESS          - the SDOGE/USDC pool address tokens are bought FROM
//   TELEGRAM_BOT_TOKEN    - from @BotFather
//   TELEGRAM_CHAT_ID      - the channel/group to post into
//
// Optional env vars:
//   ARC_RPC_URL           - default https://rpc.mainnet.arc.io
//   TOKEN_DECIMALS        - default 18
//   EXCLUDE_TO_ADDRESSES  - comma-separated addresses to ignore (e.g. the
//                           protocol's own buyback+burn wallet, so its
//                           withdrawals from the pool aren't announced as
//                           user buys)
//   MIN_BUY_TOKENS        - minimum SDOGE amount to bother alerting on
//   BUY_URL, CHART_URL    - links appended to each alert
//   DRY_RUN               - "true" to log the message instead of sending it
//   START_BLOCK           - block to start watching from on first run
//                           (defaults to "now", i.e. no history backfill)

const STATE_PATH = new URL('./state.json', import.meta.url);
const CONFIG_PATH = new URL('./config.json', import.meta.url);
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MAX_BLOCK_RANGE = 2000n;

// Non-secret settings (token/pool addresses, exclude list, links) live in
// committed bot/config.json rather than requiring GitHub Actions secrets/
// variables for values that are already public on-chain and on the site.
// Only TELEGRAM_BOT_TOKEN (and, if you'd rather, TELEGRAM_CHAT_ID) needs an
// actual GitHub secret. An env var of the same name always overrides the
// config file, so this stays compatible with the vars/secrets approach too.
let fileConfig = {};
try {
  const fs = await import('node:fs/promises');
  fileConfig = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
} catch {
  fileConfig = {};
}

function need(name) {
  const v = process.env[name];
  if (v && v.trim()) return v.trim();
  const fromFile = fileConfig[name];
  return fromFile && String(fromFile).trim() ? String(fromFile).trim() : null;
}

function toTopicAddress(addr) {
  return '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function fromTopicAddress(topic) {
  return '0x' + topic.slice(-40);
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status} for ${method}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC error for ${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function loadState() {
  try {
    const fs = await import('node:fs/promises');
    return JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
  } catch {
    return { lastBlock: null };
  }
}

async function saveState(state) {
  const fs = await import('node:fs/promises');
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function formatAmount(n) {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function tierEmoji(tokens) {
  const t1 = Number(process.env.BUY_TIER_1 ?? 100000);
  const t2 = Number(process.env.BUY_TIER_2 ?? 1000000);
  const t3 = Number(process.env.BUY_TIER_3 ?? 5000000);
  if (tokens >= t3) return '🟢🟢🟢🟢🟢'.repeat(3);
  if (tokens >= t2) return '🟢🟢🟢🟢🟢';
  if (tokens >= t1) return '🟢🟢🟢';
  return '🟢';
}

function buildMessage({ tokens, buyer, txHash }) {
  const lines = [
    `${tierEmoji(tokens)}`,
    `*New $SDOGE Buy!*`,
    `${formatAmount(tokens)} $SDOGE`,
    `Buyer: \`${buyer.slice(0, 6)}...${buyer.slice(-4)}\``,
    `[Tx](https://explorer.arc.io/tx/${txHash})`,
  ];
  const buyUrl = need('BUY_URL');
  const chartUrl = need('CHART_URL');
  if (buyUrl) lines.push(`[Buy](${buyUrl})`);
  if (chartUrl) lines.push(`[Chart](${chartUrl})`);
  return lines.join('\n');
}

async function postToTelegram(token, chatId, text) {
  if (need('DRY_RUN') === 'true') {
    console.log('[dry-run] would post to Telegram:\n' + text);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`Telegram error: ${JSON.stringify(body)}`);
}

async function getLogsChunked(rpcUrl, fromBlock, toBlock, address, topics) {
  const logs = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = start + MAX_BLOCK_RANGE < toBlock ? start + MAX_BLOCK_RANGE : toBlock;
    const chunk = await rpc(rpcUrl, 'eth_getLogs', [
      {
        address,
        fromBlock: '0x' + start.toString(16),
        toBlock: '0x' + end.toString(16),
        topics,
      },
    ]);
    logs.push(...chunk);
    start = end + 1n;
  }
  return logs;
}

async function main() {
  const tokenAddress = need('SDOGE_TOKEN_ADDRESS');
  const poolAddress = need('POOL_ADDRESS');
  const botToken = need('TELEGRAM_BOT_TOKEN');
  const chatId = need('TELEGRAM_CHAT_ID');

  const missing = [
    !tokenAddress && 'SDOGE_TOKEN_ADDRESS',
    !poolAddress && 'POOL_ADDRESS',
    !botToken && 'TELEGRAM_BOT_TOKEN',
    !chatId && 'TELEGRAM_CHAT_ID',
  ].filter(Boolean);

  if (missing.length) {
    console.log(`Buy bot not fully configured yet — still missing: ${missing.join(', ')}. Skipping run.`);
    return;
  }

  const rpcUrl = need('ARC_RPC_URL') ?? 'https://rpc.mainnet.arc.io';
  const decimals = BigInt(need('TOKEN_DECIMALS') ?? '18');
  const divisor = 10n ** decimals;
  const minBuyTokens = Number(need('MIN_BUY_TOKENS') ?? '0');
  const exclude = new Set(
    (need('EXCLUDE_TO_ADDRESSES') ?? '')
      .split(',')
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean)
  );

  const state = await loadState();
  const currentBlock = BigInt(await rpc(rpcUrl, 'eth_blockNumber', []));

  if (state.lastBlock === null) {
    const startBlock = need('START_BLOCK');
    state.lastBlock = startBlock ? BigInt(startBlock).toString() : currentBlock.toString();
    await saveState(state);
    console.log(`First run — baseline set to block ${state.lastBlock}. Nothing to announce yet.`);
    return;
  }

  const lastBlock = BigInt(state.lastBlock);
  if (currentBlock <= lastBlock) {
    console.log('No new blocks since last run.');
    return;
  }

  const logs = await getLogsChunked(rpcUrl, lastBlock + 1n, currentBlock, tokenAddress, [
    TRANSFER_TOPIC,
    toTopicAddress(poolAddress),
  ]);

  console.log(`Checked blocks ${lastBlock + 1n}-${currentBlock}, found ${logs.length} transfer(s) out of the pool.`);

  for (const log of logs) {
    const to = fromTopicAddress(log.topics[2]);
    if (exclude.has(to.toLowerCase())) continue;

    const rawValue = BigInt(log.data);
    const tokens = Number(rawValue) / Number(divisor);
    if (tokens < minBuyTokens) continue;

    const message = buildMessage({ tokens, buyer: to, txHash: log.transactionHash });
    try {
      await postToTelegram(botToken, chatId, message);
      console.log(`Posted buy alert: ${formatAmount(tokens)} SDOGE to ${to}`);
    } catch (err) {
      console.error('Failed to post to Telegram:', err.message);
    }
  }

  state.lastBlock = currentBlock.toString();
  await saveState(state);
}

main().catch((err) => {
  console.error('Buy bot run failed:', err);
  process.exit(1);
});
