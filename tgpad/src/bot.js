import { randomBytes } from 'node:crypto';
import { isAddress } from 'ethers';
import { esc, fmtAge, fmtCompactUsd, txLink } from './format.js';
import { describeFailure, nothingDone } from './errors.js';
import { volume24h } from './market.js';
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
  ban: admin.executeBan,
};

// Updates one account may have waiting at once; a flood beyond this is dropped.
const MAX_QUEUED_PER_USER = 20;
// An unconfirmed transaction is given up on (and the user told) after this long.
const STALE_TX_MS = 86_400_000;

const normName = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

export class Bot {
  constructor({ cfg, store, tg, sender, chain, wallets, moderator, blocklist, log = console, now = () => Date.now() }) {
    Object.assign(this, { cfg, store, tg, sender, chain, wallets, moderator, blocklist, log, now });
    this.pending = new Map();
    // Confirmation ids already used: { uid, outcome: confirmed|cancelled|expired, at }.
    // A late or repeated tap on one gets a toast and never edits the result.
    this.settled = new Map();
    this.convos = new Map();
    this.cmdLimit = new SlidingWindow(cfg.limits.commandsPerUserPerMinute, 60_000, now);
    this.reportLimit = new SlidingWindow(cfg.limits.reportsPerUserPerDay, 86_400_000, now);
    this.modLimit = new SlidingWindow(cfg.limits.moderationChecksPerUserPerDay ?? 10, 86_400_000, now);
    this.verdicts = new Map();
    this.perUser = new KeyedSerializer();
    this.perWallet = new KeyedSerializer();
    this.background = new Set();
    // Hashes a live job is still polling; the reconciler leaves those alone.
    this.watching = new Set();
    // Launch key -> promise of its announcement (true when posted).
    this.publishing = new Map();
    this.stopping = false;
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
  // race); different users are handled concurrently. Confirmed transactions
  // run outside this queue (runInBackground), so they never hold it. Handlers
  // count as background work, so drain() also waits for one that was queued
  // when shutdown began.
  dispatch(update) {
    const from = update.callback_query?.from ?? update.message?.from ?? update.my_chat_member?.from;
    const key = from ? String(from.id) : 'anon';
    if (this.perUser.depth(key) >= MAX_QUEUED_PER_USER) {
      const cq = update.callback_query;
      if (cq) return this.tg.call('answerCallbackQuery', { callback_query_id: cq.id, text: 'Slow down a little, then try again.' }).catch(() => {});
      return Promise.resolve();
    }
    return this.track(this.perUser.run(key, () => this.handleUpdate(update)));
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
  // Telegram edits through a different method than text. Edits are paced
  // like messages (same per-chat order as everything else sent there).
  async edit(chatId, messageId, html, buttons, { caption = false } = {}) {
    const markup = buttons ? { reply_markup: { inline_keyboard: buttons } } : {};
    try {
      if (caption) {
        await this.sender.send(chatId, 'editMessageCaption', { message_id: messageId, caption: html, parse_mode: 'HTML', ...markup });
      } else {
        await this.sender.send(chatId, 'editMessageText', {
          message_id: messageId, text: html, parse_mode: 'HTML', disable_web_page_preview: true, ...markup,
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

  // Fire-and-forget work that shutdown must still wait for.
  track(promise) {
    const t = Promise.resolve(promise)
      .catch((err) => this.log.error('background task failed:', err))
      .finally(() => this.background.delete(t));
    this.background.add(t);
    return t;
  }

  // ---------- pending confirmations ----------

  confirmButtons(id, confirmLabel = '✅ Confirm') {
    return [[{ text: confirmLabel, callback_data: `ok:${id}` }, { text: '✖ Cancel', callback_data: `no:${id}` }]];
  }

  createPending(uid, kind, params) {
    const id = randomId(9);
    this.pending.set(id, { uid: String(uid), kind, params, expiresAt: this.now() + this.cfg.limits.confirmTtlSec * 1000 });
    for (const [k, v] of this.pending) {
      if (v.expiresAt < this.now()) {
        this.pending.delete(k);
        this.settle(k, v.uid, 'expired');
      }
    }
    return id;
  }

  // { status: 'ok', action } | { status: 'expired' } | { status: 'unknown' }
  takePending(id, uid) {
    const p = this.pending.get(id);
    if (!p || p.uid !== String(uid)) return { status: 'unknown' };
    this.pending.delete(id);
    if (p.expiresAt < this.now()) {
      this.settle(id, uid, 'expired');
      return { status: 'expired' };
    }
    return { status: 'ok', action: p };
  }

  settle(id, uid, outcome) {
    this.settled.set(id, { uid: String(uid), outcome, at: this.now() });
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

  // A listed token already using this ticker or name, or null.
  duplicateOf(name, symbol, exceptToken = null) {
    const n = normName(name);
    const s = String(symbol ?? '').toUpperCase();
    const except = exceptToken ? exceptToken.toLowerCase() : null;
    for (const l of this.visibleLaunches()) {
      if (l.token.toLowerCase() === except) continue;
      const by = String(l.symbol).toUpperCase() === s ? 'ticker' : normName(l.name) === n ? 'name' : null;
      if (by) return { by, name: l.name, symbol: l.symbol, token: l.token, key: l.key };
    }
    return null;
  }

  // Tickers aren't unique. Candidates, in order until one tier has any:
  // - for holders' commands (includeHidden): tokens the user holds, then
  //   listed tokens, then everything (hidden, pending, rejected);
  // - otherwise listed tokens only;
  // - strict (admins): every match, so nothing is picked for them.
  // Duplicates are listed with name, address, age and volume.
  resolveToken(arg, { includeHidden = false, uid = null, strict = false } = {}) {
    const raw = String(arg ?? '').trim();
    if (!raw) return { error: 'Tell me which token: its $TICKER or contract address.' };
    if (isAddress(raw)) {
      const l = this.store.launch(raw);
      if (!l) return { error: 'That address isn\'t a token from this launchpad.' };
      if (l.hidden && !includeHidden) return { error: 'That token has been hidden by moderators. You can still /sell or /redeem it if you hold some.' };
      return { launch: l };
    }
    const symbol = raw.replace(/^\$/, '').toUpperCase();
    const all = Object.values(this.store.data.launches).filter((l) => l.symbol === symbol);
    const visible = all.filter((l) => !l.hidden && l.status === 'approved');
    let tiers;
    if (!includeHidden) tiers = [visible];
    else if (strict) tiers = [all];
    else {
      const held = new Set(uid ? this.store.user(uid).tokens ?? [] : []);
      tiers = [all.filter((l) => held.has(l.token.toLowerCase())), visible, all];
    }
    const matches = tiers.find((t) => t.length) ?? [];
    if (matches.length === 1) return { launch: matches[0] };
    if (!matches.length) return { error: `No token $${esc(symbol)} here. Try /trending, or paste the contract address.` };
    const now = this.now();
    const vol = (l) => volume24h(l, now);
    const list = matches
      .sort((a, b) => {
        const d = vol(b) - vol(a);
        if (d !== 0n) return d > 0n ? 1 : -1;
        const t = BigInt(b.stats?.volume6 ?? 0) - BigInt(a.stats?.volume6 ?? 0);
        if (t !== 0n) return t > 0n ? 1 : -1;
        return (a.createdAt ?? 0) - (b.createdAt ?? 0);
      })
      .slice(0, 5)
      .map((l) => {
        const state = l.hidden ? ' · hidden' : l.status !== 'approved' ? ` · ${esc(l.status)}` : '';
        return `• <b>${esc(l.name)}</b> · ${fmtAge(now - (l.createdAt ?? now))} old · ${fmtCompactUsd(Number(vol(l)) / 1e6)} 24h${state}\n  <code>${l.token}</code> (/t_${l.key})`;
      })
      .join('\n');
    return { error: `Several tokens use $${esc(symbol)}. Use the contract address:\n${list}` };
  }

  // Launches whose outcome is still unknown count too: a user can't launch
  // again (and pay again) while the last one may still be going through.
  launchesToday(uid) {
    const since = this.now() - 86_400_000;
    const id = String(uid);
    const recorded = Object.values(this.store.data.launches).filter((l) => l.tgUserId === id && l.createdAt >= since).length;
    const inFlight = Object.values(this.store.data.pendingLaunches ?? {}).filter((p) => p.uid === id && p.at >= since).length;
    return recorded + inFlight;
  }

  launchesLastHour() {
    const since = this.now() - 3_600_000;
    const recorded = Object.values(this.store.data.launches).filter((l) => l.source === 'bot' && l.createdAt >= since).length;
    const inFlight = Object.values(this.store.data.pendingLaunches ?? {}).filter((p) => p.at >= since).length;
    return recorded + inFlight;
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
    this.store.claimUsername(uid, m.from.username ?? null, this.now());

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
    if (cq.from.username) this.store.claimUsername(uid, cq.from.username, this.now());
    const captioned = Boolean(cq.message?.photo);

    // A confirmation that was already used: its message shows (or will show)
    // the real result, which a late or repeated tap must never overwrite.
    if (kind === 'ok' || kind === 'no') {
      const done = this.settled.get(a);
      if (done && done.uid === uid) {
        if (done.outcome === 'confirmed') return answer(kind === 'no' ? 'Too late to cancel: it was already confirmed.' : 'Already confirmed. The result will appear here.');
        if (done.outcome === 'cancelled') return answer('Already cancelled.');
      }
    }
    // Taps share the per-user budget with commands.
    if (!this.cmdLimit.hit(uid)) return answer('Slow down a little, then try again.');

    if (kind === 'tos') {
      user.tosAt = this.now();
      this.store.touch();
      await answer('Thanks!');
      return this.edit(chatId, messageId, '✅ Terms accepted. Send /launch to create a token, or /help for everything else.');
    }
    if (kind === 'no') {
      const t = this.takePending(a, uid);
      if (t.status === 'ok') {
        this.settle(a, uid, 'cancelled');
        await answer('Cancelled');
        return this.edit(chatId, messageId, 'Cancelled.', undefined, { caption: captioned });
      }
      if (t.status === 'expired' || this.settled.get(a)?.outcome === 'expired') {
        await answer('That confirmation had expired.');
        return this.edit(chatId, messageId, 'That confirmation expired. Nothing was sent.', undefined, { caption: captioned });
      }
      return answer('Nothing to cancel.');
    }
    if (kind === 'ok') {
      if (this.stopping) return answer('The bot is restarting. Try again in a minute; nothing was sent.');
      const t = this.takePending(a, uid);
      if (t.status !== 'ok') {
        if (t.status === 'expired' || this.settled.get(a)?.outcome === 'expired') {
          await answer('That confirmation expired.');
          return this.edit(chatId, messageId, 'That confirmation expired. Start again.', undefined, { caption: captioned });
        }
        return answer('That confirmation isn\'t valid anymore.');
      }
      const action = t.action;
      if (['launch', 'buy'].includes(action.kind) && user.banned) {
        this.settle(a, uid, 'cancelled');
        await answer();
        return this.edit(chatId, messageId, 'Your account can\'t launch or buy right now. Nothing was sent.', undefined, { caption: captioned });
      }
      this.settle(a, uid, 'confirmed');
      await answer('Working on it…');
      await this.edit(chatId, messageId, '⏳ Working on it…', undefined, { caption: captioned });
      this.runInBackground(uid, action, chatId, messageId, captioned);
      return;
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

  // ---------- confirmed actions ----------

  // Confirmed actions wait on the chain. They run outside the per-user queue
  // (onCallback doesn't await them), so the user can keep using the bot, and
  // are serialized per wallet so two of one user's transactions never race
  // for a nonce. Every transaction is recorded by hash before it's broadcast:
  // the result message always says what is known, with the link.
  runInBackground(uid, action, chatId, messageId, captioned = false) {
    const exec = EXECUTORS[action.kind];
    const address = this.wallets.address(uid);
    const hashes = [];
    const jobId = randomId(6);
    this.store.data.jobs[jobId] = { uid: String(uid), kind: action.kind, chatId, messageId, captioned, at: this.now(), sent: false };
    this.store.touch();
    const track = {
      onSigned: async (hash, meta = {}) => {
        const label = meta.label ?? action.kind;
        this.store.data.txs[hash] = { hash, uid: String(uid), kind: action.kind, label, chatId, messageId, captioned, sentAt: this.now() };
        const job = this.store.data.jobs[jobId];
        const wasSent = job?.sent;
        if (job) job.sent = true;
        try {
          await this.store.flush();
        } catch (err) {
          delete this.store.data.txs[hash];
          if (job) job.sent = wasSent;
          throw err;
        }
        this.watching.add(hash);
        hashes.push({ hash, label, outcome: null });
      },
      onFinal: (hash, outcome) => {
        const h = hashes.find((x) => x.hash === hash);
        if (h) h.outcome = outcome;
        delete this.store.data.txs[hash];
        this.store.touch();
      },
    };
    const edit = (text, buttons) => this.edit(chatId, messageId, text, buttons, { caption: captioned });
    const job = this.perWallet
      .run(address, () => exec(this, uid, action.params, track))
      .then(
        async (res) => {
          await edit(res.text, res.buttons);
          if (res.after) this.track(res.after().then((next) => (next ? edit(next.text, next.buttons) : null)));
        },
        async (err) => {
          this.log.error(`${action.kind} failed for ${uid}:`, err);
          await edit(this.failureText(err, action.kind, hashes));
        },
      )
      .finally(() => {
        for (const h of hashes) this.watching.delete(h.hash);
        delete this.store.data.jobs[jobId];
        this.store.touch();
      });
    return this.track(job);
  }

  // Jobs a previous process didn't finish (killed, crashed). One that never
  // got as far as recording a transaction sent nothing; one that did is
  // either still tracked by hash (reconcileTxs updates its message) or had
  // its outcome known but not shown.
  recoverJobs() {
    const tracked = new Set(Object.values(this.store.data.txs ?? {}).map((t) => `${t.chatId}:${t.messageId}`));
    for (const [id, job] of Object.entries(this.store.data.jobs ?? {})) {
      delete this.store.data.jobs[id];
      this.store.touch();
      if (tracked.has(`${job.chatId}:${job.messageId}`)) continue;
      const text = job.sent
        ? '⚠️ The bot restarted while this was finishing. Check /wallet to see whether it went through before trying again.'
        : '⚠️ The bot restarted before this was sent. Nothing was sent, so nothing was spent. Try again.';
      this.track(this.edit(job.chatId, job.messageId, text, undefined, { caption: job.captioned }));
    }
  }

  // What the user is told when a confirmed action fails: only what is known.
  failureText(err, kind, hashes = []) {
    const priorConfirmed = hashes.some((h) => h.outcome === 'confirmed' && h.hash !== err?.hash);
    const text = describeFailure(err, { explorerUrl: this.cfg.explorerUrl, kind, priorConfirmed });
    if (text) return text;
    // Not a transaction error. If something was sent, say what is known about it.
    const open = hashes.findLast((h) => h.outcome === null);
    if (open) return describeFailure({ outcome: 'unknown', hash: open.hash, label: open.label }, { explorerUrl: this.cfg.explorerUrl, kind });
    const done = hashes.findLast((h) => h.outcome === 'confirmed');
    if (done) return `✅ It went through on-chain (${txLink(this.cfg.explorerUrl, done.hash)}), but I couldn't show the result. Check /wallet.`;
    return '❌ Something went wrong before anything was sent, so nothing was spent. Try again in a moment.';
  }

  // Transactions whose outcome wasn't known when their job ended (or when the
  // bot restarted): once a receipt shows up, the user's message is updated
  // (and a launch recorded as theirs); after a day, they're told it most
  // likely never went through.
  async reconcileTxs() {
    for (const rec of Object.values(this.store.data.txs ?? {})) {
      if (this.watching.has(rec.hash)) continue;
      let receipt;
      try {
        receipt = await this.chain.getReceipt(rec.hash);
      } catch {
        continue;
      }
      const link = txLink(this.cfg.explorerUrl, rec.hash);
      const edit = (text, buttons) => this.edit(rec.chatId, rec.messageId, text, buttons, { caption: rec.captioned });
      if (!receipt) {
        if (this.now() - rec.sentAt < STALE_TX_MS) continue;
        delete this.store.data.txs[rec.hash];
        delete this.store.data.pendingLaunches?.[rec.hash];
        this.store.touch();
        await edit(`⚠️ Still no confirmation for this ${rec.label} after 24 hours (${link}). It was most likely dropped and never went through: check /wallet before trying again.`);
        continue;
      }
      delete this.store.data.txs[rec.hash];
      this.store.touch();
      const ok = receipt.status === 1;
      if (ok && rec.label === 'launch') {
        const ev = this.chain.launchedEvent(receipt);
        const record = ev && launch.recordBotLaunch(this, { txHash: rec.hash, ev });
        if (record) {
          const res = launch.launchResult(this, record);
          await edit(res.text, res.buttons);
          if (res.after) this.track(res.after().then((next) => (next ? edit(next.text, next.buttons) : null)));
          continue;
        }
      }
      if (!ok) {
        delete this.store.data.pendingLaunches?.[rec.hash];
        this.store.touch();
      }
      if (rec.label === 'approve') {
        await edit(ok
          ? `✅ Update: the token approval went through (${link}), but the ${rec.kind} itself was never sent, so nothing was traded. Try again if you still want to.`
          : `❌ Update: the token approval reverted (${link}). Nothing was traded; only a little gas was spent.`);
      } else {
        await edit(ok
          ? `✅ Update: this ${rec.label} went through after all · ${link}. Check /wallet.`
          : `❌ Update: this ${rec.label} reverted on-chain. ${nothingDone(rec.kind)}; only the gas fee was spent · ${link}`);
      }
    }
  }

  // Exported-key messages are deleted on a timer, and also persisted so a
  // restart inside the window still deletes them.
  scheduleDeletion(chatId, messageId, delayMs) {
    const entry = { chatId: String(chatId), messageId, at: this.now() + delayMs };
    this.store.data.deletions.push(entry);
    this.store.touch();
    const timer = setTimeout(() => this.track(this.#deleteNow(entry)), delayMs);
    timer.unref?.();
  }

  async #deleteNow(entry) {
    const i = this.store.data.deletions.findIndex((d) => d.chatId === entry.chatId && d.messageId === entry.messageId);
    if (i < 0) return;
    this.store.data.deletions.splice(i, 1);
    this.store.touch();
    await this.tg.call('deleteMessage', { chat_id: entry.chatId, message_id: entry.messageId }).catch(() => {});
  }

  async processDeletions() {
    const now = this.now();
    for (const entry of [...(this.store.data.deletions ?? [])]) {
      if (entry.at <= now) await this.#deleteNow(entry);
    }
  }

  // Forgets what has expired, so memory doesn't grow with every visitor.
  sweep() {
    const now = this.now();
    for (const [k, c] of this.convos) if (c.expiresAt < now) this.convos.delete(k);
    for (const [k, p] of this.pending) {
      if (p.expiresAt < now) {
        this.pending.delete(k);
        this.settle(k, p.uid, 'expired');
      }
    }
    for (const [k, s] of this.settled) if (now - s.at > 86_400_000) this.settled.delete(k);
    for (const [k, v] of this.verdicts) if (now - v.at > 86_400_000) this.verdicts.delete(k);
    this.cmdLimit.prune();
    this.reportLimit.prune();
    this.modLimit.prune();
    this.wallets.trim?.(1000);
  }

  // Waits until no background job is left, including ones started while
  // waiting. Resolves false if `timeoutMs` runs out first.
  async drain({ timeoutMs = Infinity } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (this.background.size) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      let timer;
      const timeout = Number.isFinite(left) ? new Promise((r) => { timer = setTimeout(r, left); }) : null;
      await Promise.race([Promise.allSettled([...this.background]), ...(timeout ? [timeout] : [])]);
      clearTimeout(timer);
    }
    return true;
  }
}
