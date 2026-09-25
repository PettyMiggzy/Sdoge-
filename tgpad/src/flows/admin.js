import { esc, fmtAge, fmtCompactUsd, tokenLine } from '../format.js';
import { volume24h } from '../market.js';
import { randomId } from '../util.js';
import { announce, channelPostLink, notifyCreator, notifyReviewers, removeAnnouncement } from './publish.js';

const uidOf = (m) => String(m.from.id);

export async function report(bot, m, user, args, rest) {
  const uid = uidOf(m);
  if (!args[0]) return bot.reply(uid, 'Usage: /report $TICKER what\'s wrong with it');
  const r = bot.resolveToken(args[0], { includeHidden: true, uid });
  if (r.error) return bot.reply(uid, r.error);
  const reason = rest.slice(args[0].length).trim().slice(0, 300);
  if (!reason) return bot.reply(uid, 'Add a short reason after the ticker, e.g. /report $DOGE fake project');
  if (!bot.reportLimit.hit(uid)) return bot.reply(uid, 'You\'ve sent a lot of reports today. Thanks, the team has them.');

  const l = r.launch;
  bot.store.data.reports.push({ id: randomId(6), key: l.key, token: l.token, uid, reason, at: bot.now() });
  bot.store.data.reports = bot.store.data.reports.slice(-500);
  bot.store.touch();
  for (const admin of bot.cfg.admins) {
    bot.reply(admin, `🚩 Report on <b>$${esc(l.symbol)}</b> (${esc(l.name)} · /t_${l.key}) from ${esc(uid)}:\n${esc(reason)}\n\n/hide ${l.token}`).catch(() => {});
  }
  return bot.reply(uid, 'Thanks. A moderator will take a look.');
}

function removalReport(bot, l, r) {
  const channel = bot.cfg.launchesChannel;
  const lines = [];
  if (r.post === 'deleted') lines.push('Its channel post was deleted.');
  else if (r.post === 'replaced') lines.push('Its channel post was replaced with a removal notice (Telegram doesn\'t let bots delete posts older than 48 hours).');
  else if (r.post === 'buttons_removed' || r.post === 'failed') {
    lines.push(`⚠️ Its channel post is still up${r.post === 'buttons_removed' ? ' (its buttons were removed)' : ''}: delete it by hand: ${channelPostLink(channel, l.channelMessageId)}`);
  }
  if (r.alerts) lines.push(`${r.alerts} buy alert(s) removed.`);
  if (r.alertsFailed) lines.push(`⚠️ ${r.alertsFailed} buy alert(s) couldn't be removed; run /hide again or delete them by hand.`);
  return lines;
}

export async function hide(bot, m, user, args, rest) {
  const uid = uidOf(m);
  const r = bot.resolveToken(args[0], { includeHidden: true, strict: true });
  if (r.error) return bot.reply(uid, r.error);
  const l = r.launch;
  l.hidden = true;
  l.hiddenBy = uid;
  l.hiddenAt = bot.now();
  l.hiddenReason = rest.slice(args[0].length).trim() || null;
  bot.store.touch();
  const removal = await removeAnnouncement(bot, l);
  return bot.reply(uid, [
    `🚫 ${tokenLine(l)} is hidden: out of listings and trending, no more buy alerts, and buying through the bot is off. Holders can still sell and redeem.`,
    ...removalReport(bot, l, removal),
  ].join('\n'));
}

export async function unhide(bot, m, user, args) {
  const uid = uidOf(m);
  const r = bot.resolveToken(args[0], { includeHidden: true, strict: true });
  if (r.error) return bot.reply(uid, r.error);
  const l = r.launch;
  l.hidden = false;
  if (l.status === 'rejected') l.status = 'approved';
  bot.store.touch();
  return bot.reply(uid, `✅ ${tokenLine(l)} is visible again. (It isn't re-announced in the channel.)`);
}

// A numeric id is exact. An @username is only as good as the last time its
// holder wrote to the bot (claimUsername clears stale copies), so a ban by
// username is shown with the account it hit and needs a confirming tap.
function findUser(bot, ref) {
  const raw = String(ref ?? '').trim();
  if (/^\d+$/.test(raw)) return { id: raw, user: bot.store.user(raw) };
  const name = raw.replace(/^@/, '').toLowerCase();
  if (!name) return null;
  const hits = Object.entries(bot.store.data.users).filter(([, u]) => u.username?.toLowerCase() === name);
  if (!hits.length) return null;
  if (hits.length > 1) return { ambiguous: hits.map(([id]) => id) };
  return { id: hits[0][0], user: hits[0][1], byUsername: true };
}

function who(bot, id, u) {
  const bits = [];
  if (u?.username) bits.push(`@${esc(u.username)}`);
  bits.push(u?.lastSeenAt ? `last seen ${fmtAge(bot.now() - u.lastSeenAt)} ago` : 'last seen: unknown');
  return `user ${esc(id)} (${bits.join(', ')})`;
}

export async function ban(bot, m, user, args, rest) {
  const uid = uidOf(m);
  const target = findUser(bot, args[0]);
  if (!target) return bot.reply(uid, 'Usage: /ban <telegram id or @username> [reason]. Someone banned by @username must have used the bot before.');
  if (target.ambiguous) return bot.reply(uid, `Several accounts used that username: ${target.ambiguous.map(esc).join(', ')}. Ban by numeric id instead.`);
  if (bot.isAdmin(target.id)) return bot.reply(uid, 'Admins can\'t be banned here.');
  const reason = rest.slice(String(args[0]).length).trim() || null;
  if (target.byUsername) {
    const id = bot.createPending(uid, 'ban', { target: target.id, reason });
    return bot.reply(uid, `Ban ${who(bot, target.id, target.user)}?${reason ? `\nReason: ${esc(reason)}` : ''}`, { buttons: bot.confirmButtons(id, '🚫 Ban') });
  }
  return bot.reply(uid, applyBan(bot, target.id, reason));
}

function applyBan(bot, id, reason) {
  const u = bot.store.user(id);
  u.banned = true;
  u.bannedAt = bot.now();
  u.banReason = reason;
  bot.store.touch();
  return `🚫 ${who(bot, id, u)} can no longer launch, buy or report. They can still sell, claim, redeem and withdraw. Use /hide for their tokens.`;
}

export async function executeBan(bot, uid, p) {
  if (!bot.isAdmin(uid)) return { text: 'Only admins can ban.' };
  if (bot.isAdmin(p.target)) return { text: 'Admins can\'t be banned here.' };
  return { text: applyBan(bot, p.target, p.reason) };
}

export async function unban(bot, m, user, args) {
  const uid = uidOf(m);
  const target = findUser(bot, args[0]);
  if (!target) return bot.reply(uid, 'Usage: /unban <telegram id or @username>');
  if (target.ambiguous) return bot.reply(uid, `Several accounts used that username: ${target.ambiguous.map(esc).join(', ')}. Unban by numeric id instead.`);
  target.user.banned = false;
  bot.store.touch();
  return bot.reply(uid, `✅ ${who(bot, target.id, target.user)} is unbanned.`);
}

export async function review(bot, m) {
  const uid = uidOf(m);
  const pending = Object.values(bot.store.data.launches).filter((l) => l.status === 'pending' && !l.hidden && !l.screening);
  if (!pending.length) return bot.reply(uid, 'Nothing waiting for review.');
  await bot.reply(uid, `${pending.length} launch(es) waiting for review:`);
  for (const l of pending.slice(0, 20)) await notifyReviewers(bot, l, [uid]);
}

export async function decideReview(bot, adminUid, approve, key, chatId, messageId) {
  const l = bot.store.launchByKey(key);
  const caption = (html) => bot.edit(chatId, messageId, html, undefined, { caption: true });
  if (!l) return caption('That launch no longer exists.');
  if (l.status !== 'pending') return caption(`Already handled: ${esc(l.status)}${l.hidden ? ' (hidden)' : ''}.`);
  l.reviewedBy = adminUid;
  l.reviewedAt = bot.now();
  if (approve) {
    l.status = 'approved';
    bot.store.touch();
    // The creator hears only what actually happened, once it has.
    bot.track(announce(bot, l)
      .catch((err) => {
        bot.log.error('announce failed:', err.message);
        return false;
      })
      .then((posted) => notifyCreator(bot, l, posted
        ? `✅ ${tokenLine(l)} passed review and was announced in the launch channel.`
        : `✅ ${tokenLine(l)} passed review.`)));
    return caption(`✅ Approved ${tokenLine(l)}.`);
  }
  l.status = 'rejected';
  l.hidden = true;
  bot.store.touch();
  await removeAnnouncement(bot, l);
  await notifyCreator(bot, l, `🚫 ${tokenLine(l)} didn't pass review, so it won't be listed or promoted in this bot. The token itself stays on-chain.`);
  return caption(`🚫 Rejected and hid ${tokenLine(l)}.`);
}

export async function reports(bot, m) {
  const uid = uidOf(m);
  const recent = bot.store.data.reports.slice(-10).reverse();
  if (!recent.length) return bot.reply(uid, 'No reports.');
  const lines = recent.map((r) => {
    const l = bot.store.launchByKey(r.key);
    return `• $${esc(l?.symbol ?? '?')} ${esc(l?.name ?? '')} (/t_${r.key}) by ${esc(r.uid)}: ${esc(r.reason)}`;
  });
  return bot.reply(uid, ['🚩 <b>Latest reports</b>', ...lines].join('\n'));
}

export async function stats(bot, m) {
  const uid = uidOf(m);
  const launches = Object.values(bot.store.data.launches);
  const day = bot.now() - 86_400_000;
  const vol = launches.reduce((s, l) => s + volume24h(l, bot.now()), 0n);
  return bot.reply(uid, [
    '📊 <b>Launchpad stats</b>',
    `Users: ${Object.keys(bot.store.data.users).length}`,
    `Launches: ${launches.length} (${launches.filter((l) => l.createdAt >= day).length} in 24h)`,
    `Live: ${launches.filter((l) => !l.hidden && l.status === 'approved').length} · Pending review: ${launches.filter((l) => l.status === 'pending' && !l.hidden).length} · Hidden: ${launches.filter((l) => l.hidden).length}`,
    `24h volume: ${fmtCompactUsd(Number(vol) / 1e6)}`,
    `Banned users: ${Object.values(bot.store.data.users).filter((u) => u.banned).length}`,
    `Reports: ${bot.store.data.reports.length}`,
    `Transactions awaiting confirmation: ${Object.keys(bot.store.data.txs ?? {}).length}`,
  ].join('\n'));
}
