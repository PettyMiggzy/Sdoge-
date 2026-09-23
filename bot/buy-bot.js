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
//   ARC_RPC_WSS_URL       - free backup RPC, tried if ARC_RPC_URL fails.
//                           Default wss://rpc.blockdaemon.mainnet.arc.io/websocket
//                           (a different provider than the default, so a
//                           rate limit on one doesn't take out both).
//   ARC_RPC_FALLBACK_URL  - last-resort paid RPC (e.g. an Alchemy URL with
//                           its API key baked in), only used if both of the
//                           above fail. Keep this in GitHub Secrets, never
//                           in config.json — unlike the others, it's a
//                           credential.
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
//   TELEGRAM_URL, X_URL   - social links, shown as a second button row
//   POOL_LABEL            - default "Uniswap v4 (Argus)"
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

// One-shot WebSocket JSON-RPC call: open, send, wait for the matching
// reply, close. Simpler and more robust than keeping a socket open across
// calls, and call volume here (a handful per run) makes the reconnect
// overhead irrelevant.
function rpcOverWebSocket(url, method, params, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url);

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closing/closed — fine
      }
      fn(arg);
    };

    const timer = setTimeout(
      () => finish(reject, new Error(`WS RPC timed out after ${timeoutMs}ms for ${method}`)),
      timeoutMs
    );

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    });
    ws.addEventListener('message', (event) => {
      try {
        const body = JSON.parse(event.data.toString());
        if (body.error) finish(reject, new Error(`WS RPC error for ${method}: ${JSON.stringify(body.error)}`));
        else finish(resolve, body.result);
      } catch (err) {
        finish(reject, new Error(`WS RPC bad response for ${method}: ${err.message}`));
      }
    });
    ws.addEventListener('error', () => {
      finish(reject, new Error(`WS RPC connection error for ${method}`));
    });
  });
}

// Never interpolate `url` into a thrown message here — ARC_RPC_FALLBACK_URL
// can carry a paid provider's API key, and this error can end up in
// GitHub Actions logs, which are public on this repo.
async function rpc(url, method, params) {
  if (url.startsWith('ws://') || url.startsWith('wss://')) {
    return rpcOverWebSocket(url, method, params);
  }
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

// Tries each configured endpoint in order (primary -> free backup -> paid
// fallback), moving on if one throws (network error, 429, timeout, etc).
async function rpcWithFallback(endpoints, method, params) {
  let lastErr;
  for (const { label, url } of endpoints) {
    try {
      return await rpc(url, method, params);
    } catch (err) {
      lastErr = err;
      console.error(`RPC (${label}) failed for ${method}: ${err.message} — trying next endpoint`);
    }
  }
  throw lastErr;
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
  if (tokens >= t3) return '🐕'.repeat(15);
  if (tokens >= t2) return '🐕'.repeat(5);
  if (tokens >= t1) return '🐕'.repeat(3);
  return '🐕';
}

function formatUsd(n) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n < 100 ? 2 : 0 });
}

// Sub-cent token prices are the norm here, and toPrecision() would fall
// back to exponential notation ("4.2e-8") once the exponent passes -6 —
// unreadable in a chat alert. Pick enough fixed decimals instead to keep
// ~3 significant figures, however small the price gets.
function formatPrice(n) {
  if (!isFinite(n) || n <= 0) return 'n/a';
  if (n >= 1) return '$' + n.toFixed(2);
  const decimals = Math.min(12, Math.max(2, 2 - Math.floor(Math.log10(n))));
  return '$' + n.toFixed(decimals);
}

function formatCompactUsd(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(n);
}

function buildMessage({ tokens, usdSpent, buyer, txHash, totalSupply }) {
  const lines = [
    `🚀 *NEW $SDOGE BUY!* ${tierEmoji(tokens)}`,
    ``,
    `💵 *Spent:* ${formatUsd(usdSpent)}`,
    `🐕 *Got:* ${formatAmount(tokens)} $SDOGE`,
    `👤 *Buyer:* \`${buyer.slice(0, 6)}...${buyer.slice(-4)}\``,
  ];

  // totalSupply is only fetched (and only ever null) when there's at least
  // one buy to announce, so a missed/failed lookup just quietly drops these
  // two lines instead of breaking the whole alert.
  if (totalSupply) {
    const pricePerToken = usdSpent / tokens;
    lines.push(`📈 *Price:* ${formatPrice(pricePerToken)}/SDOGE`);
    lines.push(`🏦 *Market Cap:* ${formatCompactUsd(pricePerToken * totalSupply)}`);
  }
  lines.push(`🦄 *Pool:* ${need('POOL_LABEL') ?? 'Uniswap v4 (Argus)'}`);

  // Real inline buttons instead of bare markdown links — links sitting
  // alone on their own line render as plain, undecorated text in Telegram
  // and look broken rather than clickable.
  const actionRow = [{ text: '🔍 Tx', url: `https://explorer.arc.io/tx/${txHash}` }];
  const buyUrl = need('BUY_URL');
  const chartUrl = need('CHART_URL');
  if (buyUrl) actionRow.push({ text: '🛒 Buy', url: buyUrl });
  if (chartUrl) actionRow.push({ text: '📊 Chart', url: chartUrl });

  const buttons = [actionRow];
  const socialRow = [];
  const telegramUrl = need('TELEGRAM_URL');
  const xUrl = need('X_URL');
  if (telegramUrl) socialRow.push({ text: '💬 Telegram', url: telegramUrl });
  if (xUrl) socialRow.push({ text: '🐦 X', url: xUrl });
  if (socialRow.length) buttons.push(socialRow);

  return { text: lines.join('\n'), buttons };
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
async function getTxValueUsd(endpoints, txHash, cache) {
  if (cache.has(txHash)) return cache.get(txHash);
  const tx = await rpcWithFallback(endpoints, 'eth_getTransactionByHash', [txHash]);
  const usd = tx?.value ? Number(BigInt(tx.value)) / 1e18 : 0;
  cache.set(txHash, usd);
  return usd;
}

// Total supply isn't hardcoded even though it's fixed today, because the
// separate holder-initiated burn-to-redeem feature can actually shrink it
// over time — reading it on-chain each run keeps market cap accurate
// without needing to track redemptions here too.
async function getTotalSupply(endpoints, tokenAddress, divisor) {
  const raw = await rpcWithFallback(endpoints, 'eth_call', [
    { to: tokenAddress, data: '0x18160ddd' }, // totalSupply()
    'latest',
  ]);
  return Number(BigInt(raw)) / Number(divisor);
}

async function getLogsChunked(endpoints, fromBlock, toBlock, address, topics) {
  const logs = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = start + MAX_BLOCK_RANGE < toBlock ? start + MAX_BLOCK_RANGE : toBlock;
    const chunk = await rpcWithFallback(endpoints, 'eth_getLogs', [
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

  const endpoints = [
    { label: 'primary', url: need('ARC_RPC_URL') ?? 'https://rpc.mainnet.arc.io' },
    { label: 'free-wss', url: need('ARC_RPC_WSS_URL') ?? 'wss://rpc.blockdaemon.mainnet.arc.io/websocket' },
    need('ARC_RPC_FALLBACK_URL') && { label: 'paid-fallback', url: need('ARC_RPC_FALLBACK_URL') },
  ].filter(Boolean);
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
  const currentBlock = BigInt(await rpcWithFallback(endpoints, 'eth_blockNumber', []));

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

  const logs = await getLogsChunked(endpoints, lastBlock + 1n, currentBlock, tokenAddress, [
    TRANSFER_TOPIC,
    toTopicAddress(poolAddress),
  ]);

  console.log(`Checked blocks ${lastBlock + 1n}-${currentBlock}, found ${logs.length} transfer(s) out of the pool.`);

  const txValueCache = new Map();
  // Only fetched when there's actually something to announce, since it's
  // the same value for every buy in this run.
  let totalSupply = null;
  if (logs.length > 0) {
    try {
      totalSupply = await getTotalSupply(endpoints, tokenAddress, divisor);
    } catch (err) {
      console.error('Could not fetch total supply, alerts will skip price/market cap:', err.message);
    }
  }

  for (const log of logs) {
    const to = fromTopicAddress(log.topics[2]);
    if (exclude.has(to.toLowerCase())) continue;

    const rawValue = BigInt(log.data);
    const tokens = Number(rawValue) / Number(divisor);
    if (tokens < minBuyTokens) continue;

    const usdSpent = await getTxValueUsd(endpoints, log.transactionHash, txValueCache);
    if (usdSpent < minBuyUsd) {
      console.log(`Skipped ${formatAmount(tokens)} SDOGE buy (${formatUsd(usdSpent)}, below $${minBuyUsd} minimum).`);
      continue;
    }

    const message = buildMessage({ tokens, usdSpent, buyer: to, txHash: log.transactionHash, totalSupply });
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
