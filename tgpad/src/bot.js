import { randomBytes } from 'node:crypto';
import { isAddress } from 'ethers';
import { esc } from './format.js';
import { friendlyError } from './errors.js';
import { KeyedSerializer, SlidingWindow, randomId } from './util.js';
import * as info from './flows/info.js';
import * as launch from './flows/launch.js';
import * as trade from './flows/trade.js';
import * as admin from './flows/admin.js';

// tos:false  -> usable before accepting the terms
// noBanned   -> refused for banned users (launching/buying/reporting).
//               Banned users can always still sell, claim, redeem, withdraw
//               and export: a ban never traps anyone's funds.
// admin      -> silently ignored for non-admins
const COMMANDS = {
  start: { fn: info.start, tos: false },
  help: { fn: info.help, tos: false },
  terms: { fn: info.terms, tos: false },
  cancel: { fn: info.cancel, tos: false },
  skip: { fn: launch.skip },
  wallet: { fn: info.wallet },
  deposit: { fn: info.deposit },
  withdraw: { fn: trade.withdraw },
  export: { fn: trade.exportKey },
  launch: { fn: launch.start, noBanned: true },
  buy: { fn: trade.buy, noBanned: true },
  sell: { fn: trade.sell },
  claim: { fn: trade.claim },
  vault: { fn: info.vault },
  redeem: { fn: trade.redeem },
  token: { fn: info.token },
  trending: { fn: info.trending },
  mylaunches: { fn: info.myLaunches },
  slippage: { fn: info.slippage },
  report: { fn: admin.report, noBanned: true },
  hide: { fn: admin.hide, admin: true },
  unhide: { fn: admin.unhide, admin: true },
  ban: { fn: admin.ban, admin: true },
  unban: { fn: admin.unban, admin: true },
  review: { fn: admin.review, admin: true },
  reports: { fn: admin.reports, admin: true },
  stats: { fn: admin.stats, admin: true },
};

export const MENU = [
  ['launch', 'Launch a new token'],
  ['buy', 'Buy a token: /buy $TICKER 10'],
  ['sell', 'Sell: /sell $TICKER 50%'],
  ['wallet', 'Your wallet and balances'],
  ['deposit', 'How to add USDC'],
  ['claim', 'Claim creator fees'],
  ['vault', 'A token\'s vault floor'],
  ['redeem', 'Burn tokens for the vault floor'],
  ['trending', 'Top tokens by 24h volume'],
  ['token', 'Token info'],
  ['mylaunches', 'Tokens you launched'],
  ['slippage', 'Set max slippage'],
  ['withdraw', 'Send USDC out'],
  ['export', 'Export your private key'],
  ['report', 'Report a token'],
  ['terms', 'Rules and risks'],
  ['help', 'All commands'],
];

const EXECUTORS = {
  launch: launch.execute,
  buy: trade.executeBuy,
  sell: trade.executeSell,
  claim: trade.executeClaim,
  redeem: trade.executeRedeem,
  withdraw: trade.executeWithdraw,
  export: trade.executeExport,
};

export class Bot {
  constructor({ cfg, store, tg, sender, chain, wallets, moderator, blocklist, log = console, now = () => Date.now() }) {
    Object.assign(this, { cfg, store, tg, sender, chain, wallets, moderator, blocklist, log, now });
    this.pending = new Map();
    this.convos = new Map();
    this.cmdLimit = new SlidingWindow(cfg.limits.commandsPerUserPerMinute, 60_000, now);
    this.reportLimit = new SlidingWindow(cfg.limits.reportsPerUserPerDay, 86_400_000, now);
    this.perUser = new KeyedSerializer();
    this.perWallet = new KeyedSerializer();
    this.background = new Set();
    // Wallets with a launch tx in flight: the indexer leaves those Launched
    // events alone so the bot's own record (with the Telegram creator) wins.
    this.inflight = new Set();
    this.username = null;
  }

  async init() {
    const me = await this.tg.call('getMe');
    this.username = me.username;
    await this.tg.call('setMyCommands', {
      commands: MENU.map(([command, description]) => ({ command, description })),
      scope: { type: 'all_private_chats' },
    });
  }

  // Updates from one user are handled strictly in order (wizard steps can't
  // race); different users are handled concurrently.
  dispatch(update) {
    const from = update.callback_query?.from ?? update.message?.from ?? update.my_chat_member?.from;
    const key = from ? String(from.id) : 'anon';
    return this.perUser.run(key, () => this.handleUpdate(update));
  }

  async handleUpdate(update) {
    try {
      if (update.my_chat_member) return await this.onMembership(update.my_chat_member);
      if (update.callback_query) return await this.onCallback(update.callback_query);
      if (update.message) return await this.onMessage(update.message);
    } catch (err) {
      this.log.error('update failed:', err);
      const chat = update.message?.chat ?? update.callback_query?.message?.chat;
      if (chat?.type === 'private') {
        await this.reply(chat.id, '⚠️ Something went wrong on our side. Nothing was sent. Try again in a moment.').catch(() => {});
      }
    }
  }

  // ---------- messaging helpers ----------

  reply(chatId, html, { buttons, ...extra } = {}) {
    return this.sender.send(chatId, 'sendMessage', {
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
      ...extra,
    });
  }

  // Photo messages (launch previews, review cards) carry captions, which
  // Telegram edits through a different method than text.
  async edit(chatId, messageId, html, buttons, { caption = false } = {}) {
    const markup = buttons ? { reply_markup: { inline_keyboard: buttons } } : {};
    try {
      if (caption) {
        await this.tg.call('editMessageCaption', { chat_id: chatId, message_id: messageId, caption: html, parse_mode: 'HTML', ...markup });
      } else {
        await this.tg.call('editMessageText', {
          chat_id: chatId, message_id: messageId, text: html, parse_mode: 'HTML', disable_web_page_preview: true, ...markup,
        });
      }
    } catch (err) {
      if (!/message is not modified/i.test(err.description ?? '')) {
        await this.reply(chatId, html, { buttons });
      }
    }
  }

  isAdmin(uid) {
    return this.cfg.admins.has(String(uid));
  }

  explorer(kind, value) {
    return `${this.cfg.explorerUrl}/${kind}/${value}`;
  }

  // Short lowercase-hex key: fits Telegram's /command syntax and deep links.
  newLaunchKey() {
    for (;;) {
      const key = randomBytes(4).toString('hex');
      if (!this.store.launchByKey(key)) return key;
    }
  }

  // ---------- pending confirmations ----------

  confirmButtons(id, confirmLabel = '✅ Confirm') {
    return [[{ text: confirmLabel, callback_data: `ok:${id}` }, { text: '✖ Cancel', callback_data: `no:${id}` }]];
  }

  createPending(uid, kind, params) {
    const id = randomId(9);
    this.pending.set(id, { uid: String(uid), kind, params, expiresAt: this.now() + this.cfg.limits.confirmTtlSec * 1000 });
    for (const [k, v] of this.pending) if (v.expiresAt < this.now()) this.pending.delete(k);
    return id;
  }

  takePending(id, uid) {
    const p = this.pending.get(id);
    if (!p || p.uid !== String(uid)) return null;
    this.pending.delete(id);
    return p.expiresAt >= this.now() ? p : null;
  }

  // ---------- conversations (multi-step wizards) ----------

  setConvo(uid, convo) {
    this.convos.set(String(uid), { ...convo, expiresAt: this.now() + this.cfg.limits.wizardTtlSec * 1000 });
  }

  getConvo(uid) {
    const c = this.convos.get(String(uid));
    if (c && c.expiresAt < this.now()) {
      this.convos.delete(String(uid));
      return null;
    }
    return c ?? null;
  }

  clearConvo(uid) {
    this.convos.delete(String(uid));
  }

  // ---------- token lookup ----------

  visibleLaunches() {
    return Object.values(this.store.data.launches).filter((l) => !l.hidden && l.status === 'approved');
  }

  resolveToken(arg, { includeHidden = false } = {}) {
    const raw = String(arg ?? '').trim();
    if (!raw) return { error: 'Tell me which token: its $TICKER or contract address.' };
    if (isAddress(raw)) {
      const l = this.store.launch(raw);
      if (!l) return { error: 'That address isn\'t a token from this launchpad.' };
      if (l.hidden && !includeHidden) return { error: 'That token has been hidden by moderators. You can still /sell or /redeem it if you hold some.' };
      return { launch: l };
    }
    const symbol = raw.replace(/^\$/, '').toUpperCase();
    const pool = includeHidden ? Object.values(this.store.data.launches) : this.visibleLaunches();
    const matches = pool.filter((l) => l.symbol === symbol);
    if (matches.length === 1) return { launch: matches[0] };
    if (!matches.length) return { error: `No token $${esc(symbol)} here. Try /trending, or paste the contract address.` };
    const list = matches
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, 5)
      .map((l) => `• <code>${l.token}</code> (/t_${l.key})`)
      .join('\n');
    return { error: `Several tokens use $${esc(symbol)}. Use the contract address:\n${list}` };
  }

  launchesToday(uid) {
    const since = this.now() - 86_400_000;
    return Object.values(this.store.data.launches).filter((l) => l.tgUserId === String(uid) && l.createdAt >= since).length;
  }

  launchesLastHour() {
    const since = this.now() - 3_600_000;
    return Object.values(this.store.data.launches).filter((l) => l.source === 'bot' && l.createdAt >= since).length;
  }

  // ---------- inbound ----------

  async onMembership(update) {
    const chat = update.chat;
    const status = update.new_chat_member?.status;
    if (chat.type === 'private' || !['member', 'administrator'].includes(status)) return;
    if (chat.type === 'channel' && String(chat.id) === String(this.cfg.launchesChannel)) return;
    if (!this.cfg.allowedGroups.has(String(chat.id))) {
      await this.tg.call('leaveChat', { chat_id: chat.id }).catch(() => {});
    }
  }

  async onMessage(m) {
    if (m.chat.type !== 'private') {
      // Staying in random groups is how bots get mass-reported: leave.
      if (!this.cfg.allowedGroups.has(String(m.chat.id))) {
        await this.tg.call('leaveChat', { chat_id: m.chat.id }).catch(() => {});
      }
      return;
    }
    if (m.from?.is_bot) return;
    const uid = String(m.from.id);
    if (!this.cmdLimit.hit(uid)) return;

    const user = this.store.user(uid);
    if (m.from.username && user.username !== m.from.username) {
      user.username = m.from.username;
      this.store.touch();
    }

    const text = (m.text ?? '').trim();
    if (text.startsWith('/')) {
      const [head, ...args] = text.split(/\s+/);
      const cmd = head.slice(1).split('@')[0].toLowerCase();
      return this.onCommand(m, user, cmd, args, text.slice(head.length).trim());
    }
    const convo = this.getConvo(uid);
    if (convo) return this.onConvoInput(m, user, convo);
    return this.reply(uid, 'Send /help to see what I can do.');
  }

  async onCommand(m, user, cmd, args, rest) {
    const uid = String(m.from.id);
    if (cmd.startsWith('t_')) return info.token(this, m, user, [cmd.slice(2)], cmd.slice(2), { byKey: true });

    const entry = COMMANDS[cmd];
    if (!entry) return this.reply(uid, 'I don\'t know that command. /help lists them all.');
    if (entry.admin && !this.isAdmin(uid)) return this.reply(uid, 'I don\'t know that command. /help lists them all.');
    if (entry.tos !== false && !entry.admin && !user.tosAt) return info.terms(this, m, user);
    if (entry.noBanned && user.banned) {
      return this.reply(uid, 'Your account can\'t launch, buy or report right now. You can still use /wallet, /sell, /claim, /redeem, /withdraw and /export.');
    }
    if (!['skip', 'cancel'].includes(cmd)) this.clearConvo(uid);
    return entry.fn(this, m, user, args, rest);
  }

  async onConvoInput(m, user, convo) {
    if (convo.flow === 'launch') return launch.onInput(this, m, user, convo);
    if (convo.flow === 'buyAmount') return trade.onBuyAmount(this, m, user, convo);
    this.clearConvo(m.from.id);
  }

  async onCallback(cq) {
    const uid = String(cq.from.id);
    const chatId = cq.message?.chat?.id;
    const messageId = cq.message?.message_id;
    const answer = (text) => this.tg.call('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text } : {}) }).catch(() => {});
    if (cq.message?.chat?.type !== 'private') return answer();

    const [kind, a, b] = String(cq.data ?? '').split(':');
    const user = this.store.user(uid);
    const captioned = Boolean(cq.message?.photo);

    if (kind === 'tos') {
      user.tosAt = this.now();
      this.store.touch();
      await answer('Thanks!');
      return this.edit(chatId, messageId, '✅ Terms accepted. Send /launch to create a token, or /help for everything else.');
    }
    if (kind === 'no') {
      this.takePending(a, uid);
      await answer('Cancelled');
      return this.edit(chatId, messageId, 'Cancelled.', undefined, { caption: captioned });
    }
    if (kind === 'ok') {
      const action = this.takePending(a, uid);
      if (!action) {
        await answer('That confirmation expired.');
        return this.edit(chatId, messageId, 'That confirmation expired. Start again.', undefined, { caption: captioned });
      }
      if (['launch', 'buy'].includes(action.kind) && user.banned) {
        await answer();
        return this.edit(chatId, messageId, 'Your account can\'t launch or buy right now.', undefined, { caption: captioned });
      }
      await answer('Working on it…');
      await this.edit(chatId, messageId, '⏳ Working on it…', undefined, { caption: captioned });
      return this.runInBackground(uid, action, chatId, messageId, captioned);
    }
    if (!user.tosAt && ['b', 'ba', 's', 'sa', 'v'].includes(kind)) {
      await answer();
      return info.terms(this, { from: cq.from }, user);
    }
    if (kind === 's') {
      await answer();
      return trade.promptSellAmount(this, uid, a);
    }
    if (kind === 'sa') {
      await answer();
      return trade.prepareSellByKey(this, uid, a, `${b}%`);
    }
    if (kind === 'v') {
      await answer();
      const l = this.store.launchByKey(a);
      return l ? info.vault(this, { from: cq.from }, user, [l.token]) : this.reply(uid, 'Token not found.');
    }
    if (kind === 'rv') {
      await answer();
      if (!this.isAdmin(uid)) return;
      return admin.decideReview(this, uid, a === 'ok', b, chatId, messageId);
    }
    if (kind === 'b') {
      await answer();
      if (user.banned) return this.reply(uid, 'Your account can\'t buy right now.');
      return trade.promptBuyAmount(this, uid, a);
    }
    if (kind === 'ba') {
      await answer();
      if (user.banned) return this.reply(uid, 'Your account can\'t buy right now.');
      return trade.prepareBuyByKey(this, uid, a, b);
    }
    return answer();
  }

  // Confirmed actions wait on the chain; run them outside the per-user queue
  // so the user can keep using the bot, but serialize per wallet so two of
  // one user's transactions never race for a nonce.
  runInBackground(uid, action, chatId, messageId, captioned = false) {
    const exec = EXECUTORS[action.kind];
    const address = this.wallets.address(uid);
    const job = this.perWallet
      .run(address, () => exec(this, uid, action.params))
      .then(
        (res) => this.edit(chatId, messageId, res.text, res.buttons, { caption: captioned }),
        (err) => {
          this.log.error(`${action.kind} failed for ${uid}:`, err);
          return this.edit(chatId, messageId, `❌ ${esc(friendlyError(err))}`, undefined, { caption: captioned });
        },
      )
      .catch((err) => this.log.error('background edit failed:', err))
      .finally(() => this.background.delete(job));
    this.background.add(job);
    return job;
  }

  async drain() {
    await Promise.allSettled([...this.background]);
  }
}
