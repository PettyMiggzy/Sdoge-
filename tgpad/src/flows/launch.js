import { checkText, moderateLaunch } from '../moderation.js';
import { esc, fmtUsdcWei, txLink } from '../format.js';
import { announce, notifyReviewers } from './publish.js';

const uidOf = (m) => String(m.from.id);

function limitMessage(bot, uid) {
  const perDay = bot.cfg.limits.launchesPerUserPerDay;
  if (bot.launchesToday(uid) >= perDay) return `You've reached today's limit of ${perDay} launches. Try again tomorrow.`;
  if (bot.launchesLastHour() >= bot.cfg.limits.launchesPerHourGlobal) return 'The launchpad is very busy right now. Try again in a little while.';
  return null;
}

export async function start(bot, m) {
  const uid = uidOf(m);
  if (!bot.chain.canLaunch) return bot.reply(uid, '🚧 Launching opens as soon as the launchpad contracts are live on Arc. Stay tuned!');
  const limit = limitMessage(bot, uid);
  if (limit) return bot.reply(uid, limit);
  bot.setConvo(uid, { flow: 'launch', step: 'name', draft: {} });
  return bot.reply(uid, '🚀 <b>New launch</b> (step 1 of 4)\n\nSend the token <b>name</b>, 2 to 32 characters. /cancel anytime.');
}

export async function skip(bot, m, user) {
  const uid = uidOf(m);
  const convo = bot.getConvo(uid);
  if (convo?.flow !== 'launch' || !['image', 'description'].includes(convo.step)) return bot.reply(uid, 'Nothing to skip right now.');
  return onInput(bot, { ...m, text: '', skip: true }, user, convo);
}

// Only real photos: Telegram re-encodes them to JPEG and hands back a file_id
// that sendPhoto accepts everywhere, which documents don't guarantee.
function pickPhoto(m, maxBytes) {
  if (m.photo?.length) {
    const p = m.photo[m.photo.length - 1];
    if (p.file_size && p.file_size > maxBytes) return { tooBig: true };
    return { fileId: p.file_id, mime: 'image/jpeg' };
  }
  if (m.document && /^image\//.test(m.document.mime_type ?? '')) return { asFile: true };
  return null;
}

export async function onInput(bot, m, user, convo) {
  const uid = uidOf(m);
  const d = convo.draft;

  if (convo.step === 'name') {
    const name = (m.text ?? '').trim().replace(/\s+/g, ' ');
    const r = checkText({ name, symbol: 'OK', description: '' }, bot.blocklist);
    if (!r.ok) return bot.reply(uid, `❌ ${esc(r.reasons.join(' '))}\n\nSend another name, or /cancel.`);
    d.name = name;
    bot.setConvo(uid, { ...convo, step: 'symbol' });
    return bot.reply(uid, `Name: <b>${esc(name)}</b>\n\n(step 2 of 4) Send the <b>ticker</b>, 2 to 10 letters or numbers (e.g. DOGE).`);
  }

  if (convo.step === 'symbol') {
    const symbol = (m.text ?? '').trim().replace(/^\$/, '').toUpperCase();
    const r = checkText({ name: d.name, symbol, description: '' }, bot.blocklist);
    if (!r.ok) return bot.reply(uid, `❌ ${esc(r.reasons.join(' '))}\n\nSend another ticker, or /cancel.`);
    d.symbol = symbol;
    bot.setConvo(uid, { ...convo, step: 'image' });
    const clash = bot.visibleLaunches().some((l) => l.symbol === symbol);
    return bot.reply(uid, [
      `Ticker: <b>$${esc(symbol)}</b>`,
      ...(clash ? ['⚠️ Another token already uses this ticker, so buyers will need your contract address to find yours.'] : []),
      '',
      '(step 3 of 4) Send the token <b>image</b> as a photo (square works best), or /skip.',
    ].join('\n'));
  }

  if (convo.step === 'image') {
    if (!m.skip) {
      const pick = pickPhoto(m, bot.cfg.limits.maxImageBytes);
      if (!pick) return bot.reply(uid, 'Send an image as a photo, or /skip.');
      if (pick.asFile) return bot.reply(uid, 'Send it as a <b>photo</b>, not as a file, so it can appear in the launch post.');
      if (pick.tooBig) return bot.reply(uid, 'That image is too large. Send a smaller one.');
      try {
        const buffer = await bot.tg.downloadFile(pick.fileId, bot.cfg.limits.maxImageBytes);
        d.image = { buffer, mime: pick.mime, fileId: pick.fileId };
      } catch (err) {
        bot.log.error('image download failed:', err.message);
        return bot.reply(uid, 'Couldn\'t download that image. Try sending it again.');
      }
    }
    bot.setConvo(uid, { ...convo, step: 'description' });
    return bot.reply(uid, '(step 4 of 4) Send a short <b>description</b> (up to 200 characters, no links), or /skip.');
  }

  if (convo.step === 'description') {
    d.description = m.skip ? '' : (m.text ?? '').trim();
    bot.clearConvo(uid);
    return preview(bot, uid, d);
  }
}

async function preview(bot, uid, d) {
  await bot.reply(uid, '🔎 Checking your launch…');
  const mod = await moderateLaunch(
    { name: d.name, symbol: d.symbol, description: d.description, image: d.image ? { buffer: d.image.buffer, mime: d.image.mime } : null },
    { list: bot.blocklist, llm: bot.moderator },
  );
  if (mod.verdict === 'block') {
    bot.log.warn(`launch blocked for ${uid} at ${mod.stage}: ${mod.categories.join(',')} ${mod.reasons.join(' ')}`);
    return bot.reply(uid, `❌ This launch can't go through.\n${esc(mod.reasons.join(' '))}\n\nStart again with /launch.`);
  }

  const wallet = bot.wallets.get(uid);
  const [fee, balance] = await Promise.all([bot.chain.launchFee(), bot.chain.nativeBalance(wallet.address)]);
  if (balance <= fee) {
    return bot.reply(uid, `💸 Launching costs ${fmtUsdcWei(fee)} USDC plus a little gas. Your balance is ${fmtUsdcWei(balance)} USDC. /deposit, then /launch again.`);
  }
  let gasCost;
  try {
    ({ gasCost } = await bot.chain.estimateLaunch(wallet, { name: d.name, symbol: d.symbol, uri: '' }));
  } catch (err) {
    bot.log.error('launch estimate failed:', err);
    return bot.reply(uid, 'Couldn\'t prepare the launch right now (the network rejected a test run). Try again shortly.');
  }

  const id = bot.createPending(uid, 'launch', {
    name: d.name,
    symbol: d.symbol,
    description: d.description,
    imageFileId: d.image?.fileId ?? null,
    moderation: { verdict: mod.verdict, categories: mod.categories, reasons: mod.reasons },
  });
  const text = [
    '🚀 <b>Ready to launch</b>',
    '',
    `<b>${esc(d.name)}</b> ($${esc(d.symbol)})`,
    ...(d.description ? [esc(d.description)] : []),
    '',
    'Supply: 1,000,000,000, all of it in the pool with liquidity locked forever.',
    'You earn 0.5% of every buy as the creator.',
    `Cost: <b>${fmtUsdcWei(fee)} USDC</b> + ~${fmtUsdcWei(gasCost, 4)} USDC gas`,
    ...(mod.verdict === 'review' ? ['', '⏳ A moderator will check this before it\'s posted in the launch channel. Your token still goes live immediately.'] : []),
  ].join('\n');
  const buttons = bot.confirmButtons(id, '🚀 Launch');
  if (d.image) {
    return bot.sender.send(uid, 'sendPhoto', { photo: d.image.fileId, caption: text, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
  }
  return bot.reply(uid, text, { buttons });
}

export async function execute(bot, uid, p) {
  const user = bot.store.user(uid);
  if (user.banned) return { text: 'Your account can\'t launch right now.' };
  const limit = limitMessage(bot, uid);
  if (limit) return { text: limit };
  // Blocklist edits made since the preview still apply.
  const recheck = checkText(p, bot.blocklist);
  if (!recheck.ok) return { text: `❌ ${esc(recheck.reasons.join(' '))}` };

  const wallet = bot.wallets.get(uid);
  bot.inflight.add(wallet.address);
  let res;
  try {
    res = await bot.chain.launch(wallet, { name: p.name, symbol: p.symbol, uri: '' });
  } finally {
    bot.inflight.delete(wallet.address);
  }

  const record = {
    key: bot.newLaunchKey(),
    source: 'bot',
    tgUserId: uid,
    index: res.index,
    token: res.token,
    vault: res.vault,
    poolId: res.poolId,
    creator: res.creator,
    name: p.name,
    symbol: p.symbol,
    description: p.description,
    imageFileId: p.imageFileId,
    moderation: p.moderation,
    status: p.moderation.verdict === 'allow' ? 'approved' : 'pending',
    hidden: false,
    createdAt: bot.now(),
    txHash: res.txHash,
    channelMessageId: null,
    stats: { buys: 0, sells: 0, volume6: '0', hourly: {} },
  };
  bot.store.putLaunch(record);
  user.tokens = [...new Set([...(user.tokens ?? []), res.token.toLowerCase()])];
  bot.store.touch();

  if (record.status === 'approved') await announce(bot, record).catch((err) => bot.log.error('announce failed:', err.message));
  else await notifyReviewers(bot, record);

  return {
    text: [
      `🎉 <b>$${esc(p.symbol)} is live on Arc!</b>`,
      '',
      `CA: <code>${res.token}</code>`,
      `Vault: <code>${res.vault}</code>`,
      txLink(bot.cfg.explorerUrl, res.txHash, 'launch transaction'),
      '',
      record.status === 'approved' ? 'Announced in the launch channel.' : 'It\'ll be announced once a moderator approves it.',
      'Share it: buyers can use /buy with your contract address.',
    ].join('\n'),
    buttons: [[
      { text: '🟢 Buy some', callback_data: `b:${record.key}` },
      { text: '🔍 Explorer', url: bot.explorer('token', res.token) },
    ]],
  };
}
