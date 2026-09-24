import { esc, fmtCompactUsd } from '../format.js';
import { volume24h } from '../market.js';
import { randomId } from '../util.js';
import { announce, notifyCreator, notifyReviewers, removeAnnouncement } from './publish.js';

const uidOf = (m) => String(m.from.id);

export async function report(bot, m, user, args, rest) {
  const uid = uidOf(m);
  if (!args[0]) return bot.reply(uid, 'Usage: /report $TICKER what\'s wrong with it');
  const r = bot.resolveToken(args[0], { includeHidden: true });
  if (r.error) return bot.reply(uid, r.error);
  const reason = rest.slice(args[0].length).trim().slice(0, 300);
  if (!reason) return bot.reply(uid, 'Add a short reason after the ticker, e.g. /report $DOGE fake project');
  if (!bot.reportLimit.hit(uid)) return bot.reply(uid, 'You\'ve sent a lot of reports today. Thanks, the team has them.');

  const l = r.launch;
  bot.store.data.reports.push({ id: randomId(6), key: l.key, token: l.token, uid, reason, at: bot.now() });
  bot.store.data.reports = bot.store.data.reports.slice(-500);
  bot.store.touch();
  for (const admin of bot.cfg.admins) {
    bot.reply(admin, `🚩 Report on <b>$${esc(l.symbol)}</b> (/t_${l.key}) from ${esc(uid)}:\n${esc(reason)}\n\n/hide ${l.token}`).catch(() => {});
  }
  return bot.reply(uid, 'Thanks. A moderator will take a look.');
}

export async function hide(bot, m, user, args, rest) {
  const uid = uidOf(m);
  const r = bot.resolveToken(args[0], { includeHidden: true });
  if (r.error) return bot.reply(uid, r.error);
  const l = r.launch;
  l.hidden = true;
  l.hiddenBy = uid;
  l.hiddenAt = bot.now();
  l.hiddenReason = rest.slice(args[0].length).trim() || null;
  bot.store.touch();
  await removeAnnouncement(bot, l);
  return bot.reply(uid, `🚫 $${esc(l.symbol)} is hidden: out of listings and trending, and buying through the bot is off. Holders can still sell and redeem.`);
}

export async function unhide(bot, m, user, args) {
  const uid = uidOf(m);
  const r = bot.resolveToken(args[0], { includeHidden: true });
  if (r.error) return bot.reply(uid, r.error);
  const l = r.launch;
  l.hidden = false;
  if (l.status === 'rejected') l.status = 'approved';
  bot.store.touch();
  return bot.reply(uid, `✅ $${esc(l.symbol)} is visible again. (It isn't re-announced in the channel.)`);
}

function findUser(bot, ref) {
  const raw = String(ref ?? '').trim();
  if (/^\d+$/.test(raw)) return { id: raw, user: bot.store.user(raw) };
  const name = raw.replace(/^@/, '').toLowerCase();
  const hit = Object.entries(bot.store.data.users).find(([, u]) => u.username?.toLowerCase() === name);
  return hit ? { id: hit[0], user: hit[1] } : null;
}

export async function ban(bot, m, user, args, rest) {
  const uid = uidOf(m);
  const target = findUser(bot, args[0]);
  if (!target) return bot.reply(uid, 'Usage: /ban <telegram id or @username> [reason]. They must have used the bot before.');
  if (bot.isAdmin(target.id)) return bot.reply(uid, 'Admins can\'t be banned here.');
  target.user.banned = true;
  target.user.bannedAt = bot.now();
  target.user.banReason = rest.slice(String(args[0]).length).trim() || null;
  bot.store.touch();
  return bot.reply(uid, `🚫 User ${esc(target.id)} can no longer launch, buy or report. They can still sell, claim, redeem and withdraw. Use /hide for their tokens.`);
}

export async function unban(bot, m, user, args) {
  const uid = uidOf(m);
  const target = findUser(bot, args[0]);
  if (!target) return bot.reply(uid, 'Usage: /unban <telegram id or @username>');
  target.user.banned = false;
  bot.store.touch();
  return bot.reply(uid, `✅ User ${esc(target.id)} is unbanned.`);
}

export async function review(bot, m) {
  const uid = uidOf(m);
  const pending = Object.values(bot.store.data.launches).filter((l) => l.status === 'pending' && !l.hidden);
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
    await announce(bot, l).catch((err) => bot.log.error('announce failed:', err.message));
    await notifyCreator(bot, l, `✅ <b>$${esc(l.symbol)}</b> passed review and was announced in the launch channel.`);
    return caption(`✅ Approved $${esc(l.symbol)} (${esc(l.name)}).`);
  }
  l.status = 'rejected';
  l.hidden = true;
  bot.store.touch();
  await notifyCreator(bot, l, `🚫 <b>$${esc(l.symbol)}</b> didn't pass review, so it won't be listed or promoted in this bot. The token itself stays on-chain.`);
  return caption(`🚫 Rejected and hid $${esc(l.symbol)} (${esc(l.name)}).`);
}

export async function reports(bot, m) {
  const uid = uidOf(m);
  const recent = bot.store.data.reports.slice(-10).reverse();
  if (!recent.length) return bot.reply(uid, 'No reports.');
  const lines = recent.map((r) => {
    const l = bot.store.launchByKey(r.key);
    return `• $${esc(l?.symbol ?? '?')} (/t_${r.key}) by ${esc(r.uid)}: ${esc(r.reason)}`;
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
  ].join('\n'));
}
