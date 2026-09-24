import { Interface, getAddress } from 'ethers';
import { FACTORY_ABI, SWAP_TOPIC } from './abi.js';
import { LAUNCHED_TOPIC } from './chain.js';
import { checkText } from './moderation.js';
import { TOTAL_SUPPLY, recordSwap, usdPerToken } from './market.js';
import { notifyReviewers } from './flows/publish.js';
import { esc, fmtCompactUsd, fmtPrice, fmtUsdc6 } from './format.js';
import { SlidingWindow } from './util.js';

const factoryIface = new Interface(FACTORY_ABI);
const MAX_RANGE = 2000; // Arc's RPC caps eth_getLogs at 10k blocks
const TWO255 = 1n << 255n;
const TWO256 = 1n << 256n;
const word = (data, i) => BigInt('0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64));
const signed = (v) => (v >= TWO255 ? v - TWO256 : v);

export class Indexer {
  constructor({ bot }) {
    this.bot = bot;
    this.alertBudget = new SlidingWindow(bot.cfg.alerts.channelMaxPerMinute, 60_000, bot.now);
    this.lastAlert = new Map();
  }

  // One bounded chunk per call; a restart after downtime catches up over
  // several ticks instead of one huge query.
  async tick() {
    const { store, chain, cfg } = this.bot;
    const head = await chain.blockNumber();
    const st = store.data.indexer;
    if (st.lastBlock == null) {
      st.lastBlock = head;
      store.touch();
      return;
    }
    const from = st.lastBlock + 1;
    if (from > head) return;
    const to = Math.min(head, from + MAX_RANGE - 1);

    if (cfg.factory) {
      const logs = await chain.getLogs({ address: cfg.factory, topics: [LAUNCHED_TOPIC], fromBlock: from, toBlock: to });
      for (const log of logs) await this.onLaunched(log);
    }
    if (Object.keys(store.data.launches).length) {
      const logs = await chain.getLogs({ address: cfg.poolManager, topics: [SWAP_TOPIC], fromBlock: from, toBlock: to });
      for (const log of logs) this.onSwap(log);
    }
    st.lastBlock = to;
    store.touch();
  }

  // Launches made directly on-chain (not through the bot) get the same text
  // screening. They are never auto-announced; admins review anything unclear.
  async onLaunched(log) {
    const { bot } = this;
    const parsed = factoryIface.parseLog(log);
    if (!parsed) return;
    const token = getAddress(parsed.args.token);
    const creator = getAddress(parsed.args.creator);
    if (bot.store.launch(token) || bot.inflight.has(creator)) return;

    const name = String(parsed.args.name);
    const symbol = String(parsed.args.symbol);
    const text = checkText({ name, symbol, description: '' }, bot.blocklist);
    let moderation;
    let status = 'pending';
    if (!text.ok) {
      moderation = { verdict: 'block', categories: text.categories, reasons: text.reasons };
      status = 'rejected';
    } else if (bot.moderator) {
      const r = await bot.moderator.review({ name, symbol, description: '', image: null });
      moderation = { verdict: r.verdict, categories: r.categories, reasons: r.reason ? [r.reason] : [] };
      status = r.verdict === 'allow' ? 'approved' : r.verdict === 'block' ? 'rejected' : 'pending';
    } else {
      moderation = { verdict: 'review', categories: [], reasons: ['Not screened: moderation is off.'] };
    }

    const record = {
      key: bot.newLaunchKey(),
      source: 'chain',
      tgUserId: null,
      index: Number(parsed.args.index),
      token,
      vault: getAddress(parsed.args.vault),
      poolId: parsed.args.poolId,
      creator,
      name,
      symbol,
      description: '',
      imageFileId: null,
      moderation,
      status,
      hidden: status === 'rejected',
      createdAt: bot.now(),
      txHash: log.transactionHash,
      channelMessageId: null,
      stats: { buys: 0, sells: 0, volume6: '0', hourly: {} },
    };
    bot.store.putLaunch(record);
    if (status === 'pending') await notifyReviewers(bot, record);
  }

  onSwap(log) {
    const l = this.bot.store.launchByPoolId(log.topics[1]);
    if (!l) return;
    // Non-indexed Swap fields: amount0, amount1, sqrtPriceX96, liquidity, tick, fee.
    // Amounts are the swapper's deltas: negative = paid in. USDC is currency0.
    const amount0 = signed(word(log.data, 0));
    const amount1 = signed(word(log.data, 1));
    const sqrtPriceX96 = word(log.data, 2);
    const isBuy = amount0 < 0n && amount1 > 0n;
    const usdc6 = amount0 < 0n ? -amount0 : amount0;
    recordSwap(l, { usdc6, isBuy, sqrtPriceX96, at: this.bot.now() });
    if (isBuy) this.maybeAlert(l, usdc6, sqrtPriceX96);
  }

  maybeAlert(l, usdc6, sqrtPriceX96) {
    const { bot } = this;
    const a = bot.cfg.alerts;
    const channel = bot.cfg.launchesChannel;
    if (!a.enabled || !channel || l.hidden || l.status !== 'approved') return;
    if (usdc6 < BigInt(Math.round(a.minBuyUsdc * 1e6))) return;
    const now = bot.now();
    if (now - (this.lastAlert.get(l.key) ?? 0) < a.perTokenCooldownSec * 1000) return;
    if (!this.alertBudget.hit('channel')) return;
    this.lastAlert.set(l.key, now);

    const price = usdPerToken(sqrtPriceX96);
    bot.sender.send(channel, 'sendMessage', {
      text: `🟢 <b>$${esc(l.symbol)}</b> buy: <b>${fmtUsdc6(usdc6)} USDC</b>\nPrice ${fmtPrice(price)} · MCap ${fmtCompactUsd(price * TOTAL_SUPPLY)}`,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: '🟢 Buy in bot', url: `https://t.me/${bot.username}?start=b_${l.key}` }]] },
    }).catch((err) => bot.log.error('buy alert failed:', err.message));
  }
}
