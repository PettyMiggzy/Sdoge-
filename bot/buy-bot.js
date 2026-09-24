#!/usr/bin/env node
// $SDOGE buy-alert bot (v2).
//
// Detection: Uniswap v4 PoolManager `Swap` events for the SDOGE pool (POOL_ID).
// One log per swap carries the exact USDC paid and SDOGE received, whatever
// router or payment path (native value, ERC-20, Permit2, aggregator, contract)
// the buyer used. The old tx.value approach reported $0 for every non-native
// path and silently skipped those buys as "below $1". SWAP_TOPIC and the real
// POOL_ID were verified against a live buy tx's actual PoolManager log before
// this shipped, not assumed - decoded amount0/amount1 lined up with that same
// buy's already-known $23.52 / 1,991,471 SDOGE (net of the 1% tax) to 4 figures.
//
// Delivery: alerts go into a persisted outbox in state.json BEFORE the block
// cursor advances. An alert leaves the outbox only when Telegram has accepted
// it. A failed post is retried next pass; nothing is dropped because a post
// failed. Already-posted keys are remembered so a re-scanned range never
// double-posts.
//
// Default mode: a persistent daemon (loop forever, sleep POLL_INTERVAL_MS
// between passes) - meant to run 24/7 under pm2. Set RUN_ONCE=true for a
// single pass then exit (used by the GitHub Actions manual-dispatch fallback).
//
// Required (env or bot/config.json): SDOGE_TOKEN_ADDRESS, POOL_ADDRESS
// (PoolManager), POOL_ID, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
// Optional: ARC_RPC_URL, ARC_RPC_WSS_URL, ARC_RPC_FALLBACK_URL, TOKEN_DECIMALS,
// USDC_VIEW_ADDRESS, USDC_POOL_DECIMALS, CONFIRMATIONS, EXCLUDE_TO_ADDRESSES,
// UNIVERSAL_ROUTER_ADDRESS, MIN_BUY_USD, MIN_BUY_TOKENS, BUY_URL, CHART_URL,
// TELEGRAM_URL, X_URL, POOL_LABEL, BUY_TIER_1/2/3, DRY_RUN, RUN_ONCE,
// START_BLOCK, POLL_INTERVAL_MS.

import fs from 'node:fs/promises';

const STATE_PATH = new URL('./state.json', import.meta.url);
const STATE_TMP = new URL('./state.json.tmp', import.meta.url);
const STATE_BAK = new URL('./state.json.bak', import.meta.url);
const CONFIG_PATH = new URL('./config.json', import.meta.url);
const VIDEO_PATH = new URL('./assets/buy-alert.mp4', import.meta.url);

const SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MAX_BLOCK_RANGE = 2000n;
const MIN_BLOCK_RANGE = 50n;
const RPC_TIMEOUT_MS = 15000;
const POST_PACING_MS = 1200;
const POSTED_MEMORY = 2000; // tx hashes remembered to prevent double posts
const DEFAULT_STATE = { lastBlock: null, posted: [], outbox: [], videoFileId: null };

let fileConfig = {};
try { fileConfig = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8')); } catch { fileConfig = {}; }

let buyAlertVideo = null;
try { buyAlertVideo = await fs.readFile(VIDEO_PATH); } catch { buyAlertVideo = null; }

function need(name) {
  const v = process.env[name];
  if (v && v.trim()) return v.trim();
  const f = fileConfig[name];
  return f !== undefined && String(f).trim() ? String(f).trim() : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => '0x' + n.toString(16);
const fromTopicAddress = (t) => '0x' + t.slice(-40).toLowerCase();

// ---------- ABI decoding ----------
const TWO255 = 1n << 255n, TWO256 = 1n << 256n;
const word = (data, i) => data.slice(2 + i * 64, 2 + (i + 1) * 64);
const int256 = (h) => { const v = BigInt('0x' + h); return v >= TWO255 ? v - TWO256 : v; };

// Swap(bytes32 id, address sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
// amounts are the swapper's deltas: negative = paid, positive = received.
function decodeSwap(log, usdcIsCurrency0) {
  const a0 = int256(word(log.data, 0)), a1 = int256(word(log.data, 1));
  return usdcIsCurrency0 ? { usdDelta: a0, tokenDelta: a1 } : { usdDelta: a1, tokenDelta: a0 };
}

// ---------- RPC ----------
function rpcOverWebSocket(url, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url);
    const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close(); } catch {} fn(arg); };
    const timer = setTimeout(() => finish(reject, new Error(`WS RPC timed out for ${method}`)), timeoutMs);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })));
    ws.addEventListener('message', (ev) => {
      try { const b = JSON.parse(ev.data.toString()); b.error ? finish(reject, new Error(`WS RPC error for ${method}: ${JSON.stringify(b.error)}`)) : finish(resolve, b.result); }
      catch (e) { finish(reject, new Error(`WS RPC bad response for ${method}: ${e.message}`)); }
    });
    ws.addEventListener('error', () => finish(reject, new Error(`WS RPC connection error for ${method}`)));
  });
}

// Never put `url` in an error message: the paid fallback URL carries an API key.
async function rpc(url, method, params) {
  if (url.startsWith('ws://') || url.startsWith('wss://')) return rpcOverWebSocket(url, method, params);
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS), // a hung socket used to hang the whole pass forever
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status} for ${method}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC error for ${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function rpcWithFallback(endpoints, method, params) {
  let lastErr;
  for (const { label, url } of endpoints) {
    try { return await rpc(url, method, params); }
    catch (err) { lastErr = err; console.error(`RPC (${label}) failed for ${method}: ${err.message} - trying next endpoint`); }
  }
  throw lastErr;
}

// Halves the range on any getLogs error (result-cap, timeout) instead of retrying the
// same failing range forever after a long outage; grows back once chunks succeed.
async function getLogsChunked(endpoints, fromBlock, toBlock, filter) {
  const logs = [];
  let start = fromBlock, range = MAX_BLOCK_RANGE;
  while (start <= toBlock) {
    const end = start + range - 1n > toBlock ? toBlock : start + range - 1n;
    try {
      const chunk = await rpcWithFallback(endpoints, 'eth_getLogs', [{ ...filter, fromBlock: hex(start), toBlock: hex(end) }]);
      logs.push(...chunk);
      start = end + 1n;
      if (range < MAX_BLOCK_RANGE) range = range * 2n > MAX_BLOCK_RANGE ? MAX_BLOCK_RANGE : range * 2n;
    } catch (err) {
      if (range <= MIN_BLOCK_RANGE) throw err;
      range /= 2n;
      console.warn(`eth_getLogs failed on ${end - start + 1n} blocks (${err.message}); retrying with ${range}-block chunks`);
    }
  }
  return logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16));
}

async function getTotalSupply(endpoints, token, divisor) {
  const raw = await rpcWithFallback(endpoints, 'eth_call', [{ to: token, data: '0x18160ddd' }, 'latest']);
  return Number(BigInt(raw)) / Number(divisor);
}

// ---------- state ----------
async function loadState() {
  let raw;
  try { raw = await fs.readFile(STATE_PATH, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { ...DEFAULT_STATE }; throw e; }
  try { return { ...DEFAULT_STATE, ...JSON.parse(raw) }; }
  catch (e) {
    // Do NOT fall back to a fresh baseline: that silently drops every buy since the
    // last good pass. Refuse to run until a human restores state.json(.bak).
    throw new Error(`state.json is corrupt (${e.message}). Restore bot/state.json.bak (or fix by hand) before starting.`);
  }
}

async function saveState(state) {
  if (state.posted.length > POSTED_MEMORY) state.posted = state.posted.slice(-POSTED_MEMORY);
  await fs.writeFile(STATE_TMP, JSON.stringify(state, null, 2) + '\n');
  try { await fs.copyFile(STATE_PATH, STATE_BAK); } catch {}
  await fs.rename(STATE_TMP, STATE_PATH); // atomic: a crash can't leave a half-written file
}

// ---------- formatting ----------
const formatAmount = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const formatUsd = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n < 100 ? 2 : 0 });
function formatPrice(n) {
  if (!isFinite(n) || n <= 0) return 'n/a';
  if (n >= 1) return '$' + n.toFixed(2);
  return '$' + n.toFixed(Math.min(12, Math.max(2, 2 - Math.floor(Math.log10(n)))));
}
const formatCompactUsd = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);
function tierEmoji(tokens) {
  const t1 = Number(need('BUY_TIER_1') ?? 100000), t2 = Number(need('BUY_TIER_2') ?? 1000000), t3 = Number(need('BUY_TIER_3') ?? 5000000);
  return tokens >= t3 ? '🐕'.repeat(15) : tokens >= t2 ? '🐕'.repeat(5) : tokens >= t1 ? '🐕'.repeat(3) : '🐕';
}

function buildMessage({ tokens, usdSpent, buyer, txHash, totalSupply }) {
  const lines = [
    `🚀 *NEW $SDOGE BUY!* ${tierEmoji(tokens)}`, ``,
    `💵 *Spent:* ${formatUsd(usdSpent)}`,
    `🐕 *Got:* ${formatAmount(tokens)} $SDOGE`,
    `👤 *Buyer:* \`${buyer.slice(0, 6)}...${buyer.slice(-4)}\``,
  ];
  if (totalSupply) {
    const price = usdSpent / tokens;
    lines.push(`📈 *Price:* ${formatPrice(price)}/SDOGE`, `🏦 *Market Cap:* ${formatCompactUsd(price * totalSupply)}`);
  }
  lines.push(`🦄 *Pool:* ${need('POOL_LABEL') ?? 'Uniswap v4 (Argus)'}`);

  const actionRow = [{ text: '🔍 Tx', url: `https://explorer.arc.io/tx/${txHash}` }];
  if (need('BUY_URL')) actionRow.push({ text: '🛒 Buy', url: need('BUY_URL') });
  if (need('CHART_URL')) actionRow.push({ text: '📊 Chart', url: need('CHART_URL') });
  const socialRow = [];
  if (need('TELEGRAM_URL')) socialRow.push({ text: '💬 Telegram', url: need('TELEGRAM_URL') });
  if (need('X_URL')) socialRow.push({ text: '🐦 X', url: need('X_URL') });
  const buttons = socialRow.length ? [actionRow, socialRow] : [actionRow];
  return { text: lines.join('\n'), buttons };
}

// ---------- Telegram ----------
function telegramError(method, body) {
  const err = new Error(`Telegram error (${method}): ${JSON.stringify(body)}`);
  const code = body?.error_code, desc = String(body?.description ?? '');
  if (body?.parameters?.retry_after) err.retryAfterMs = (body.parameters.retry_after + 1) * 1000;
  err.parseError = /can't parse entities/i.test(desc);
  err.badFileId = /wrong file identifier|file_id/i.test(desc) && code === 400;
  err.permanent = code === 400 || code === 403 || code === 404;
  return err;
}

async function tgJson(token, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  return res.json();
}

async function sendTelegram(token, chatId, item, state) {
  const text = item.plain ? item.message.text.replace(/[*`]/g, '') : item.message.text;
  const common = { chat_id: chatId, reply_markup: { inline_keyboard: item.message.buttons }, ...(item.plain ? {} : { parse_mode: 'Markdown' }) };

  // Re-use Telegram's file_id after the first upload: instant, no 5MB multipart per alert,
  // and far less likely to trip the per-chat flood limit during a backlog sweep.
  if (state.videoFileId) {
    const body = await tgJson(token, 'sendVideo', { ...common, video: state.videoFileId, caption: text });
    if (body.ok) return;
    const err = telegramError('sendVideo', body);
    if (!err.badFileId) throw err;
    state.videoFileId = null; // stale id - fall through to a fresh upload
  }
  if (buyAlertVideo) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', text);
    if (!item.plain) form.append('parse_mode', 'Markdown');
    form.append('reply_markup', JSON.stringify(common.reply_markup));
    form.append('video', new Blob([buyAlertVideo], { type: 'video/mp4' }), 'buy-alert.mp4');
    const res = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
    const body = await res.json();
    if (!body.ok) throw telegramError('sendVideo', body);
    state.videoFileId = body.result?.video?.file_id ?? null;
    return;
  }
  const body = await tgJson(token, 'sendMessage', { ...common, text, disable_web_page_preview: true });
  if (!body.ok) throw telegramError('sendMessage', body);
}

// Posts queued alerts in order. Removes an item ONLY after Telegram accepts it.
// 429 -> wait retry_after and retry. Markdown 400 -> retry as plain text.
// Other 4xx x3 -> drop loudly (misconfig, not transient). Anything else -> stop,
// retry next pass. Cursor position is irrelevant here: the outbox IS the record.
async function drainOutbox(state, token, chatId, dryRun) {
  while (state.outbox.length) {
    const item = state.outbox[0];
    if (dryRun) {
      console.log(`[dry-run] would post${buyAlertVideo || state.videoFileId ? ' (with video)' : ''}:\n${item.message.text}\nbuttons: ${JSON.stringify(item.message.buttons)}`);
      state.outbox.shift(); state.posted.push(item.key);
      continue;
    }
    await sleep(POST_PACING_MS);
    try {
      await sendTelegram(token, chatId, item, state);
      state.outbox.shift(); state.posted.push(item.key);
      await saveState(state);
      console.log(`Posted buy alert: ${item.summary}`);
    } catch (err) {
      item.attempts = (item.attempts ?? 0) + 1;
      if (err.retryAfterMs) { console.log(`Telegram rate limit, waiting ${Math.round(err.retryAfterMs / 1000)}s...`); await saveState(state); await sleep(err.retryAfterMs); continue; }
      if (err.parseError && !item.plain) { item.plain = true; await saveState(state); continue; }
      if (err.permanent && item.attempts >= 3) {
        console.error(`DROPPING alert after ${item.attempts} permanent Telegram errors (check bot token / chat admin): ${item.summary}: ${err.message}`);
        state.outbox.shift(); state.posted.push(item.key); await saveState(state);
        continue;
      }
      console.error(`Telegram post failed (attempt ${item.attempts}, ${state.outbox.length} queued, retrying next pass): ${err.message}`);
      await saveState(state);
      return;
    }
  }
  await saveState(state);
}

// ---------- scan ----------
function buildEndpoints() {
  const list = [
    { label: 'primary', url: need('ARC_RPC_URL') ?? 'https://rpc.mainnet.arc.io' },
    { label: 'free-wss', url: need('ARC_RPC_WSS_URL') ?? 'wss://rpc.blockdaemon.mainnet.arc.io/websocket' },
    need('ARC_RPC_FALLBACK_URL') && { label: 'paid-fallback', url: need('ARC_RPC_FALLBACK_URL') },
  ].filter(Boolean);
  if (typeof WebSocket === 'undefined') {
    const dropped = list.filter((e) => /^wss?:/.test(e.url));
    if (dropped.length && !buildEndpoints.warned) {
      buildEndpoints.warned = true;
      console.warn(`Node ${process.version} has no global WebSocket (needs 22+): ignoring ${dropped.map((e) => e.label).join(', ')}. Use an https:// backup or upgrade Node.`);
    }
    return list.filter((e) => !/^wss?:/.test(e.url));
  }
  return list;
}

async function scanOnce(state, ctx) {
  const { endpoints, token, poolManager, poolId, usdcIsCurrency0, usdcPoolDecimals, divisor, exclude, minBuyUsd, minBuyTokens, confirmations } = ctx;

  const head = BigInt(await rpcWithFallback(endpoints, 'eth_blockNumber', [])) - confirmations;
  if (state.lastBlock === null) {
    const startBlock = need('START_BLOCK');
    state.lastBlock = startBlock ? BigInt(startBlock).toString() : head.toString();
    await saveState(state);
    console.log(`First run - baseline set to block ${state.lastBlock}. (Delete state.json only if you WANT to skip history.)`);
    return;
  }
  const last = BigInt(state.lastBlock);
  if (head <= last) return;

  const swaps = await getLogsChunked(endpoints, last + 1n, head, { address: poolManager, topics: [SWAP_TOPIC, poolId] });

  // One alert per tx: sum the buy-direction USDC across that tx's swaps in this pool.
  const byTx = new Map();
  let sells = 0;
  for (const log of swaps) {
    const { usdDelta, tokenDelta } = decodeSwap(log, usdcIsCurrency0);
    if (!(usdDelta < 0n && tokenDelta > 0n)) { sells++; continue; }
    const cur = byTx.get(log.transactionHash) ?? { usd: 0n, tokens: 0n, block: log.blockNumber };
    cur.usd += -usdDelta; cur.tokens += tokenDelta;
    byTx.set(log.transactionHash, cur);
  }

  const known = new Set([...state.posted, ...state.outbox.map((i) => i.key)]);
  let queued = 0, dust = 0, totalSupply = undefined;

  for (const [txHash, agg] of byTx) {
    if (known.has(txHash)) continue;
    const usdSpent = Number(agg.usd) / 10 ** usdcPoolDecimals;
    if (usdSpent < minBuyUsd) { dust++; continue; } // no RPC call spent on dust

    // Receipt gives the real buyer (tx sender) and the net SDOGE they received
    // (pool -> non-excluded), i.e. after the 1% tax split to 0xDdaB.
    const receipt = await rpcWithFallback(endpoints, 'eth_getTransactionReceipt', [txHash]);
    if (!receipt) throw new Error(`receipt missing for ${txHash} (RPC lag) - will retry`);
    let net = 0n;
    for (const l of receipt.logs) {
      if (l.address.toLowerCase() !== token || l.topics[0] !== TRANSFER_TOPIC) continue;
      if (fromTopicAddress(l.topics[1]) !== poolManager) continue;
      if (exclude.has(fromTopicAddress(l.topics[2]))) continue;
      net += BigInt(l.data);
    }
    const tokensRaw = net > 0n ? net : agg.tokens;
    const tokens = Number(tokensRaw) / Number(divisor);
    if (tokens < minBuyTokens) continue;
    const buyer = receipt.from.toLowerCase();

    if (totalSupply === undefined) {
      try { totalSupply = await getTotalSupply(endpoints, token, divisor); }
      catch (e) { totalSupply = null; console.error('totalSupply unavailable, alerts skip price/mcap:', e.message); }
    }

    state.outbox.push({
      key: txHash, attempts: 0, createdAt: new Date().toISOString(),
      summary: `${formatAmount(tokens)} SDOGE for ${formatUsd(usdSpent)} by ${buyer} (${txHash.slice(0, 12)})`,
      message: buildMessage({ tokens, usdSpent, buyer, txHash, totalSupply }),
    });
    known.add(txHash);
    await saveState(state); // queued before the cursor moves: a crash here re-scans but never double-posts
    queued++;
  }

  console.log(`Blocks ${last + 1n}-${head}: ${swaps.length} swap(s) -> ${queued} buy alert(s) queued, ${sells} sell/other, ${dust} below $${minBuyUsd}`);
  state.lastBlock = head.toString();
  await saveState(state);
}

function buildContext() {
  const token = need('SDOGE_TOKEN_ADDRESS')?.toLowerCase();
  const poolManager = need('POOL_ADDRESS')?.toLowerCase();
  const poolId = need('POOL_ID')?.toLowerCase();
  const botToken = need('TELEGRAM_BOT_TOKEN');
  const chatId = need('TELEGRAM_CHAT_ID');
  const missing = [!token && 'SDOGE_TOKEN_ADDRESS', !poolManager && 'POOL_ADDRESS', !poolId && 'POOL_ID', !botToken && 'TELEGRAM_BOT_TOKEN', !chatId && 'TELEGRAM_CHAT_ID'].filter(Boolean);
  if (missing.length) return { missing };

  const usdcView = (need('USDC_VIEW_ADDRESS') ?? '0x3600000000000000000000000000000000000000').toLowerCase();
  const decimals = BigInt(need('TOKEN_DECIMALS') ?? '18');
  return {
    endpoints: buildEndpoints(), token, poolManager, poolId, botToken, chatId,
    usdcIsCurrency0: BigInt(usdcView) < BigInt(token), // v4 orders currencies by address
    usdcPoolDecimals: Number(need('USDC_POOL_DECIMALS') ?? '6'), // pool accounts USDC in 6-dec units
    divisor: 10n ** decimals,
    confirmations: BigInt(need('CONFIRMATIONS') ?? '2'),
    minBuyUsd: Number(need('MIN_BUY_USD') ?? '1'),
    minBuyTokens: Number(need('MIN_BUY_TOKENS') ?? '0'),
    exclude: new Set((need('EXCLUDE_TO_ADDRESSES') ?? '').split(',').concat(need('UNIVERSAL_ROUTER_ADDRESS') ?? '').map((a) => a.trim().toLowerCase()).filter(Boolean)),
    dryRun: need('DRY_RUN') === 'true',
  };
}

async function pass(state) {
  const ctx = buildContext();
  if (ctx.missing) { console.log(`Not configured yet - missing: ${ctx.missing.join(', ')}. Skipping.`); return; }
  // Scan and drain are independent: a dead RPC must not block delivering already-queued alerts.
  try { await scanOnce(state, ctx); }
  catch (err) { console.error('Scan failed (cursor not advanced, will retry):', err.message); }
  try { await drainOutbox(state, ctx.botToken, ctx.chatId, ctx.dryRun); }
  catch (err) { console.error('Outbox drain failed (alerts kept, will retry):', err.message); }
}

async function main() {
  const state = await loadState();
  if (state.outbox.length) console.log(`${state.outbox.length} alert(s) still queued from a previous run - will post first.`);
  if (need('RUN_ONCE') === 'true') { await pass(state); return; }
  const interval = Number(need('POLL_INTERVAL_MS') ?? '25000');
  console.log(`Persistent poll loop every ${interval}ms (pm2 stop / Ctrl+C to exit).`);
  for (;;) { await pass(state); await sleep(interval); }
}

main().catch((err) => { console.error('Buy bot fatal error:', err); process.exit(1); });
