import { Interface, getAddress, isError } from 'ethers';
import { FACTORY_ABI, SWAP_TOPIC } from './abi.js';
import { LAUNCHED_TOPIC } from './chain.js';
import { checkText } from './moderation.js';
import { TOTAL_SUPPLY, recordSwap, usdPerToken } from './market.js';
import { notifyReviewers } from './flows/publish.js';
import { dupReason, recordBotLaunch } from './flows/launch.js';
import { esc, fmtCompactUsd, fmtPrice, fmtUsdc6, short } from './format.js';
import { SlidingWindow } from './util.js';

const factoryIface = new Interface(FACTORY_ABI);
// Arc's public RPC refuses eth_getLogs over 10k blocks or 20,000 results.
export const MAX_RANGE = 2000;
// Pool ids per Swap query (an OR of topic values).
const POOLS_PER_QUERY = 100;
const TWO255 = 1n << 255n;
const TWO256 = 1n << 256n;
const word = (data, i) => BigInt('0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64));
const signed = (v) => (v >= TWO255 ? v - TWO256 : v);
const yieldToLoop = () => new Promise((r) => setImmediate(r));

// The node's own message, which ethers wraps as "could not coalesce error".
export function rpcMessage(err) {
  return err?.info?.error?.message ?? err?.error?.message ?? err?.shortMessage ?? err?.message ?? String(err);
}

// A window too big for the RPC: too many results, too many blocks, or so
// slow it timed out. The cure is a smaller window, not the same one again.
export function isRangeError(err) {
  if (isError(err, 'TIMEOUT')) return true;
  const code = err?.info?.error?.code ?? err?.error?.code;
  return code === -32005 || code === -32012
    || /max results|too many (results|logs)|range too (large|wide)|exceed(s|ed)? .*(range|limit|results)|response size|limit exceeded|query timeout/i.test(`${rpcMessage(err)} ${err?.message ?? ''}`);
}

// Buy alerts go only to tokens that went through the bot's own screening or
// an admin: a launch made directly on-chain is never promoted on its own.
const promotable = (l) => !l.hidden && l.status === 'approved' && (l.source === 'bot' || Boolean(l.reviewedBy));

export class Indexer {
  constructor({ bot }) {
    this.bot = bot;
    this.alertBudget = new SlidingWindow(bot.cfg.alerts.channelMaxPerMinute, 60_000, bot.now);
    this.lastAlert = new Map();
    // Grows back to MAX_RANGE after it had to shrink.
    this.range = MAX_RANGE;
    this.head = null;
    this.lastRangeError = null;
    // On-chain launches are screened one at a time, off the tick.
    this.screening = Promise.resolve();
  }

  // One bounded chunk per call; a restart after downtime catches up over
  // several ticks instead of one huge query. Nothing is recorded unless every
  // query for the chunk succeeded; a chunk the RPC finds too big is halved.
  async tick() {
    const { store, chain, cfg } = this.bot;
    const head = await chain.blockNumber();
    this.head = head;
    const st = store.data.indexer;
    if (st.lastBlock == null) {
      st.lastBlock = head;
      store.touch();
      return;
    }
    const from = st.lastBlock + 1;
    if (from > head) return;
    const to = Math.min(head, from + this.range - 1);

    let launched;
    let swaps;
    try {
      launched = cfg.factory ? await chain.getLogs({ address: cfg.factory, topics: [LAUNCHED_TOPIC], fromBlock: from, toBlock: to }) : [];
      // Only launchpad pools (including ones launched in this very chunk),
      // never every swap on the shared PoolManager.
      const ids = new Set(Object.values(store.data.launches).map((l) => String(l.poolId).toLowerCase()));
      for (const log of launched) if (log.topics?.[2]) ids.add(log.topics[2].toLowerCase());
      const list = [...ids];
      swaps = [];
      for (let i = 0; i < list.length; i += POOLS_PER_QUERY) {
        swaps.push(...await chain.getLogs({ address: cfg.poolManager, topics: [SWAP_TOPIC, list.slice(i, i + POOLS_PER_QUERY)], fromBlock: from, toBlock: to }));
      }
    } catch (err) {
      if (isRangeError(err) && to > from) {
        this.range = Math.max(1, (to - from + 1) >> 1);
        this.lastRangeError = rpcMessage(err);
        return;
      }
      throw err;
    }

    for (const log of launched) {
      // Not awaited: screening (a paid model call, admin cards) never slows the chunk.
      this.onLaunched(log).catch((err) => this.bot.log.error('launch screening failed:', err));
    }
    for (let i = 0; i < swaps.length; i++) {
      this.onSwap(swaps[i], undefined, head);
      if (i % 1000 === 999) await yieldToLoop();
    }
    st.lastBlock = to;
    store.touch();
    if (this.range < MAX_RANGE) this.range = Math.min(MAX_RANGE, this.range * 2);
  }

  // Blocks the indexer is behind the chain head, as of the last tick.
  behind() {
    const last = this.bot.store.data.indexer.lastBlock;
    return this.head == null || last == null ? 0 : Math.max(0, this.head - last);
  }

  // Every Launched log is recorded. The bot's own launches (their tx hash was
  // saved before broadcast) become the user's full record; anything else is
  // an on-chain launch, attributed to a bot user if it came from their
  // wallet, and screened like the bot screens its own. Returns a promise
  // that settles once screening is done.
  onLaunched(log) {
    const { bot } = this;
    let parsed;
    try { parsed = factoryIface.parseLog(log); } catch { parsed = null; }
    if (!parsed) return Promise.resolve();
    const ev = {
      index: Number(parsed.args.index),
      poolId: parsed.args.poolId,
      token: getAddress(parsed.args.token),
      vault: getAddress(parsed.args.vault),
      creator: getAddress(parsed.args.creator),
    };
    if (log.transactionHash && bot.store.data.pendingLaunches?.[log.transactionHash]) {
      const record = recordBotLaunch(bot, { txHash: log.transactionHash, ev });
      return Promise.resolve(record && bot.publishing.get(record.key)).then(() => {});
    }
    if (bot.store.launch(ev.token)) return Promise.resolve();

    const name = String(parsed.args.name);
    const symbol = String(parsed.args.symbol);
    const record = {
      key: bot.newLaunchKey(),
      source: 'chain',
      tgUserId: bot.store.data.botWallets?.[ev.creator.toLowerCase()] ?? null,
      ...ev,
      name,
      symbol,
      description: '',
      imageFileId: null,
      moderation: null,
      status: 'pending',
      hidden: false,
      createdAt: bot.now(),
      txHash: log.transactionHash,
      channelMessageId: null,
      stats: { buys: 0, sells: 0, volume6: '0', hourly: {} },
    };
    const text = checkText({ name, symbol, description: '' }, bot.blocklist);
    if (!text.ok) {
      record.moderation = { verdict: 'block', categories: text.categories, reasons: text.reasons };
      record.status = 'rejected';
      record.hidden = true;
      bot.store.putLaunch(record);
      return Promise.resolve();
    }
    if (!bot.moderator) {
      record.moderation = { verdict: 'review', categories: [], reasons: ['Not screened: moderation is off.'] };
      this.#dupCheck(record);
      bot.store.putLaunch(record);
      return notifyReviewers(bot, record);
    }
    record.screening = true;
    bot.store.putLaunch(record);
    const job = this.screening.then(() => this.#screen(record));
    this.screening = job.catch(() => {});
    return job;
  }

  // A copy of a listed token's ticker or name always goes to a moderator.
  #dupCheck(record) {
    const dup = this.bot.duplicateOf(record.name, record.symbol, record.token);
    if (!dup) return false;
    record.moderation = { ...record.moderation, reasons: [...(record.moderation?.reasons ?? []), dupReason(dup)] };
    return true;
  }

  async #screen(record) {
    const { bot } = this;
    let r;
    try {
      r = await bot.moderator.review({ name: record.name, symbol: record.symbol, description: '', image: null });
    } catch (err) {
      r = { verdict: 'review', categories: [], reason: `moderation failed: ${err.message}` };
    }
    record.screening = false;
    record.moderation = { verdict: r.verdict, categories: r.categories, reasons: r.reason ? [r.reason] : [] };
    const dup = this.#dupCheck(record);
    if (r.verdict === 'block') {
      record.status = 'rejected';
      record.hidden = true;
    } else {
      record.status = r.verdict === 'allow' && !dup ? 'approved' : 'pending';
    }
    bot.store.touch();
    if (record.status === 'pending' && !record.hidden) await notifyReviewers(bot, record);
  }

  // `head` dates the log: backlog swaps are booked in the hour they happened
  // and never alerted as if they were fresh.
  onSwap(log, l = this.bot.store.launchByPoolId(log.topics[1]), head = this.head) {
    if (!l) return;
    // Non-indexed Swap fields: amount0, amount1, sqrtPriceX96, liquidity, tick, fee.
    // Amounts are the swapper's deltas: negative = paid in. USDC is currency0.
    const amount0 = signed(word(log.data, 0));
    const amount1 = signed(word(log.data, 1));
    const sqrtPriceX96 = word(log.data, 2);
    const isBuy = amount0 < 0n && amount1 > 0n;
    const usdc6 = amount0 < 0n ? -amount0 : amount0;
    const block = log.blockNumber == null ? null : Number(log.blockNumber);
    const lag = head == null || block == null ? 0 : Math.max(0, head - block);
    const at = this.bot.now() - lag * (this.bot.cfg.blockTimeMs ?? 500);
    recordSwap(l, { usdc6, isBuy, sqrtPriceX96, at });
    if (isBuy && lag <= (this.bot.cfg.alerts.maxLagBlocks ?? 120)) this.maybeAlert(l, usdc6, sqrtPriceX96);
  }

  maybeAlert(l, usdc6, sqrtPriceX96) {
    const { bot } = this;
    const a = bot.cfg.alerts;
    const channel = bot.cfg.launchesChannel;
    if (!a.enabled || !channel || !promotable(l)) return;
    if (usdc6 < BigInt(Math.round(a.minBuyUsdc * 1e6))) return;
    const now = bot.now();
    if (now - (this.lastAlert.get(l.key) ?? 0) < a.perTokenCooldownSec * 1000) return;
    if (!this.alertBudget.hit('channel')) return;
    this.lastAlert.set(l.key, now);

    const price = usdPerToken(sqrtPriceX96);
    bot.sender.send(channel, 'sendMessage', {
      text: [
        `🟢 <b>$${esc(l.symbol)}</b> buy: <b>${fmtUsdc6(usdc6)} USDC</b>`,
        `${esc(l.name)} · <code>${short(l.token)}</code>`,
        `Price ${fmtPrice(price)} · MCap ${fmtCompactUsd(price * TOTAL_SUPPLY)}`,
      ].join('\n'),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: '🟢 Buy in bot', url: `https://t.me/${bot.username}?start=b_${l.key}` }]] },
    }, { guard: () => promotable(l) })
      .then((res) => {
        // Remembered so /hide can take alerts down too.
        if (!res?.message_id) return;
        l.alertMessageIds = [...(l.alertMessageIds ?? []), res.message_id].slice(-50);
        bot.store.touch();
      })
      .catch((err) => bot.log.error('buy alert failed:', err.message));
  }
}
