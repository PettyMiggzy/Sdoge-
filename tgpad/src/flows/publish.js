import { addrLink, esc } from '../format.js';

const buyUrl = (bot, l) => `https://t.me/${bot.username}?start=b_${l.key}`;

// Only launches that passed moderation (or an admin) are ever posted.
export async function announce(bot, l) {
  const channel = bot.cfg.launchesChannel;
  if (!channel || l.hidden || l.status !== 'approved' || l.channelMessageId) return;
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
  const res = l.imageFileId
    ? await bot.sender.send(channel, 'sendPhoto', { photo: l.imageFileId, caption, parse_mode: 'HTML', reply_markup })
    : await bot.sender.send(channel, 'sendMessage', { text: caption, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup });
  l.channelMessageId = res?.message_id ?? null;
  bot.store.touch();
}

export async function removeAnnouncement(bot, l) {
  if (!l.channelMessageId || !bot.cfg.launchesChannel) return;
  await bot.tg.call('deleteMessage', { chat_id: bot.cfg.launchesChannel, message_id: l.channelMessageId }).catch(() => {});
  l.channelMessageId = null;
  bot.store.touch();
}

export async function notifyReviewers(bot, l, admins = bot.cfg.admins) {
  const m = l.moderation ?? {};
  const caption = [
    `🔎 <b>Review needed</b>: ${esc(l.name)} ($${esc(l.symbol)})`,
    `Source: ${l.source === 'bot' ? `bot user ${esc(l.tgUserId)}` : 'launched directly on-chain'}`,
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

export async function notifyCreator(bot, l, html) {
  if (!l.tgUserId) return;
  await bot.reply(l.tgUserId, html).catch(() => {});
}
