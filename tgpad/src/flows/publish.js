import { addrLink, esc, tokenLine } from '../format.js';

const buyUrl = (bot, l) => `https://t.me/${bot.username}?start=b_${l.key}`;
const REMOVED = '🚫 Removed by the moderators.';

// May appear in the launch channel.
export const isPublic = (l) => !l.hidden && l.status === 'approved';

// A link admins can open to find a channel message by hand.
export function channelPostLink(channel, messageId) {
  const c = String(channel);
  if (c.startsWith('@')) return `https://t.me/${c.slice(1)}/${messageId}`;
  return `https://t.me/c/${c.replace(/^-100/, '')}/${messageId}`;
}

// Only launches that passed moderation (or an admin) are ever posted.
// Resolves true only if the post is up. Hidden is re-checked right before the
// send and again after it: a /hide while the post waited for its channel slot
// must win.
export async function announce(bot, l) {
  const channel = bot.cfg.launchesChannel;
  if (!channel || !isPublic(l)) return false;
  if (l.channelMessageId) return true;
  const caption = [
    `🚀 <b>${esc(l.name)}</b> ($${esc(l.symbol)}) just launched on Arc`,
    ...(l.description ? ['', esc(l.description)] : []),
    '',
    `CA: <code>${l.token}</code>`,
    `Creator: ${addrLink(bot.cfg.explorerUrl, l.creator)}`,
    '',
    '1B supply, all of it in the pool, liquidity locked forever. 0.5% of every buy backs the meme vault floor.',
  ].join('\n');
  const reply_markup = { inline_keyboard: [[
    { text: '🟢 Buy in bot', url: buyUrl(bot, l) },
    { text: '🔍 Explorer', url: bot.explorer('token', l.token) },
  ]] };
  const guard = () => isPublic(l) && !l.channelMessageId;
  const res = l.imageFileId
    ? await bot.sender.send(channel, 'sendPhoto', { photo: l.imageFileId, caption, parse_mode: 'HTML', reply_markup }, { guard })
    : await bot.sender.send(channel, 'sendMessage', { text: caption, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup }, { guard });
  if (!res?.message_id) return false;
  l.channelMessageId = res.message_id;
  l.channelPhoto = Boolean(l.imageFileId);
  bot.store.touch();
  if (!isPublic(l)) {
    // Hidden or rejected while the post was on its way: take it straight down.
    const r = await removeAnnouncement(bot, l);
    if (r.post === 'failed') await notifyAdmins(bot, `⚠️ $${esc(l.symbol)} was hidden while its announcement was being posted, and the post couldn't be removed. Delete it by hand: ${channelPostLink(channel, res.message_id)}`);
    return false;
  }
  return true;
}

// Deletes a channel message; bots can't delete channel posts older than 48 h,
// so failing that it's edited into a removal notice with no buttons.
async function removeChannelMessage(bot, messageId, { photo }) {
  const chat_id = bot.cfg.launchesChannel;
  try {
    await bot.tg.call('deleteMessage', { chat_id, message_id: messageId });
    return 'deleted';
  } catch {}
  const reply_markup = { inline_keyboard: [] };
  try {
    if (photo) await bot.tg.call('editMessageCaption', { chat_id, message_id: messageId, caption: REMOVED, reply_markup });
    else await bot.tg.call('editMessageText', { chat_id, message_id: messageId, text: REMOVED, reply_markup });
    return 'replaced';
  } catch {}
  try {
    await bot.tg.call('editMessageReplyMarkup', { chat_id, message_id: messageId, reply_markup });
    return 'buttons_removed';
  } catch {}
  return 'failed';
}

// Takes a token's announcement and buy alerts out of the channel. Keeps the
// ids of anything it couldn't remove, so a second /hide can retry.
// Returns { post: 'none'|'deleted'|'replaced'|'buttons_removed'|'failed', alerts, alertsFailed }.
export async function removeAnnouncement(bot, l) {
  const out = { post: 'none', alerts: 0, alertsFailed: 0 };
  if (!bot.cfg.launchesChannel) return out;
  if (l.channelMessageId && l.channelPostRemoved) out.post = 'replaced';
  else if (l.channelMessageId) {
    out.post = await removeChannelMessage(bot, l.channelMessageId, { photo: l.channelPhoto ?? Boolean(l.imageFileId) });
    if (out.post === 'deleted') l.channelMessageId = null;
    else if (out.post === 'replaced') l.channelPostRemoved = true;
  }
  const keep = [];
  for (const id of l.alertMessageIds ?? []) {
    const r = await removeChannelMessage(bot, id, { photo: false });
    if (r === 'deleted' || r === 'replaced') out.alerts++;
    else {
      out.alertsFailed++;
      keep.push(id);
    }
  }
  l.alertMessageIds = keep;
  bot.store.touch();
  return out;
}

export async function notifyReviewers(bot, l, admins = bot.cfg.admins) {
  const m = l.moderation ?? {};
  const caption = [
    `🔎 <b>Review needed</b>: ${tokenLine(l)}`,
    `Source: ${l.source === 'bot' ? `bot user ${esc(l.tgUserId)}` : `launched directly on-chain${l.tgUserId ? ` (bot user ${esc(l.tgUserId)}'s wallet)` : ''}`}`,
    `CA: <code>${l.token}</code>`,
    ...(l.description ? [`Description: ${esc(l.description)}`] : []),
    `Screening: ${esc(m.verdict ?? 'n/a')}${m.categories?.length ? ` (${esc(m.categories.join(', '))})` : ''}`,
    ...(m.reasons?.length ? [`Why: ${esc(m.reasons.join(' '))}`] : []),
  ].join('\n');
  const reply_markup = { inline_keyboard: [[
    { text: '✅ Approve', callback_data: `rv:ok:${l.key}` },
    { text: '🚫 Reject & hide', callback_data: `rv:no:${l.key}` },
  ]] };
  for (const admin of admins) {
    const send = l.imageFileId
      ? bot.sender.send(admin, 'sendPhoto', { photo: l.imageFileId, caption, parse_mode: 'HTML', reply_markup })
      : bot.sender.send(admin, 'sendMessage', { text: caption, parse_mode: 'HTML', reply_markup });
    await send.catch((err) => bot.log.error(`review card to admin ${admin} failed:`, err.message));
  }
}

export async function notifyAdmins(bot, html) {
  await Promise.all([...bot.cfg.admins].map((admin) => bot.reply(admin, html).catch((err) => bot.log.error(`admin alert to ${admin} failed:`, err.message))));
}

export async function notifyCreator(bot, l, html) {
  if (!l.tgUserId) return;
  await bot.reply(l.tgUserId, html).catch(() => {});
}
