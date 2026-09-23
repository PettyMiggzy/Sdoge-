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
//   POOL_ADDRESS          - the Uniswap v4 PoolManager tokens are bought FROM
//                           (a singleton shared by every pool on Arc, not a
//                           dedicated SDOGE contract)
//   TELEGRAM_BOT_TOKEN    - from @BotFather
//   TELEGRAM_CHAT_ID      - the channel/group to post into
//
// Optional env vars:
//   ARC_RPC_URL           - default https://rpc.mainnet.arc.io
//   TOKEN_DECIMALS        - default 18
//   UNIVERSAL_ROUTER_ADDRESS - Arc's Uniswap v4 UniversalRouter. Never a real
//                           buyer, so it's auto-excluded alongside whatever's
//                           in EXCLUDE_TO_ADDRESSES.
//   EXCLUDE_TO_ADDRESSES  - comma-separated addresses to ignore (e.g. the
//                           protocol's own buyback+burn wallet, so its
//                           withdrawals from the pool aren't announced as
//                           user buys)
//   MIN_BUY_TOKENS        - minimum SDOGE amount to bother alerting on
//   MIN_BUY_USD           - minimum USD spent to bother alerting on (default 1)
//   BUY_URL, CHART_URL    - links appended to each alert
//   DRY_RUN               - "true" to log the message instead of sending it
//   START_BLOCK           - block to start watching from on first run
//                           (defaults to "now", i.e. no history backfill)
//
// bot/assets/buy-alert.mp4, if present, is attached as a video to every
// posted alert (caption = the usual alert text). Falls back to a plain text
// message when the file isn't there.

const STATE_PATH = new URL('./state.json', import.meta.url);
const CONFIG_PATH = new URL('./config.json', import.meta.url);
const VIDEO_PATH = new URL('./assets/buy-alert.mp4', import.meta.url);
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

// Loaded once at startup so every alert this run can attach it without
// re-reading the file. Missing asset just means alerts fall back to text.
let buyAlertVideo = null;
try {
  const fs = await import('node:fs/promises');
  buyAlertVideo = await fs.readFile(VIDEO_PATH);
} catch {
  buyAlertVideo = null;
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

function formatUsd(n) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n < 100 ? 2 : 0 });
}

function buildMessage({ tokens, usdSpent, buyer, txHash }) {
  const text = [
    `🚀 *NEW $SDOGE BUY!* ${tierEmoji(tokens)}`,
    ``,
    `💵 *Spent:* ${formatUsd(usdSpent)}`,
    `🐕 *Got:* ${formatAmount(tokens)} $SDOGE`,
    `👤 *Buyer:* \`${buyer.slice(0, 6)}...${buyer.slice(-4)}\``,
  ].join('\n');

  // Real inline buttons instead of bare markdown links — links sitting
  // alone on their own line render as plain, undecorated text in Telegram
  // and look broken rather than clickable.
  const row = [{ text: '🔍 Tx', url: `https://explorer.arc.io/tx/${txHash}` }];
  const buyUrl = need('BUY_URL');
  const chartUrl = need('CHART_URL');
  if (buyUrl) row.push({ text: '🛒 Buy', url: buyUrl });
  if (chartUrl) row.push({ text: '📊 Chart', url: chartUrl });

  return { text, buttons: [row] };
}

async function postToTelegram(token, chatId, { text, buttons }) {
  const replyMarkup = buttons?.length ? { inline_keyboard: buttons } : undefined;

  if (need('DRY_RUN') === 'true') {
    console.log(
      `[dry-run] would post to Telegram${buyAlertVideo ? ' (with video)' : ''}:\n` +
        text +
        '\nbuttons: ' +
        JSON.stringify(buttons)
    );
    return;
  }

  if (buyAlertVideo) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', text);
    form.append('parse_mode', 'Markdown');
    if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
    form.append('video', new Blob([buyAlertVideo], { type: 'video/mp4' }), 'buy-alert.mp4');

    const res = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
      method: 'POST',
      body: form,
    });
    const body = await res.json();
    if (!body.ok) throw new Error(`Telegram error (sendVideo): ${JSON.stringify(body)}`);
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
      reply_markup: replyMarkup,
    }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`Telegram error (sendMessage): ${JSON.stringify(body)}`);
}

// Arc's native currency IS USDC (confirmed: a real buy tx's `value` field
// of 25 lined up exactly with a ~$25 purchase), so the USD amount spent on
// a buy is just the native value of the transaction that triggered it —
// no separate USDC contract or price feed needed. Cached per run since a
// tx can contain more than one qualifying transfer.
async function getTxValueUsd(rpcUrl, txHash, cache) {
  if (cache.has(txHash)) return cache.get(txHash);
  const tx = await rpc(rpcUrl, 'eth_getTransactionByHash', [txHash]);
  const usd = tx?.value ? Number(BigInt(tx.value)) / 1e18 : 0;
  cache.set(txHash, usd);
  return usd;
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
  const minBuyUsd = Number(need('MIN_BUY_USD') ?? '1');
  const exclude = new Set(
    (need('EXCLUDE_TO_ADDRESSES') ?? '')
      .split(',')
      .concat(need('UNIVERSAL_ROUTER_ADDRESS') ?? '')
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

  const txValueCache = new Map();

  for (const log of logs) {
    const to = fromTopicAddress(log.topics[2]);
    if (exclude.has(to.toLowerCase())) continue;

    const rawValue = BigInt(log.data);
    const tokens = Number(rawValue) / Number(divisor);
    if (tokens < minBuyTokens) continue;

    const usdSpent = await getTxValueUsd(rpcUrl, log.transactionHash, txValueCache);
    if (usdSpent < minBuyUsd) {
      console.log(`Skipped ${formatAmount(tokens)} SDOGE buy (${formatUsd(usdSpent)}, below $${minBuyUsd} minimum).`);
      continue;
    }

    const message = buildMessage({ tokens, usdSpent, buyer: to, txHash: log.transactionHash });
    try {
      await postToTelegram(botToken, chatId, message);
      console.log(`Posted buy alert: ${formatAmount(tokens)} SDOGE (${formatUsd(usdSpent)}) to ${to}`);
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
