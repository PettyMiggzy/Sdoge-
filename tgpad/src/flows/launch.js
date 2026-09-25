import { createHash } from 'node:crypto';
import { checkText, hasLinkEntity, moderateLaunch } from '../moderation.js';
import { esc, fmtUsdcWei, tokenLine, txLink } from '../format.js';
import { announce, notifyAdmins, notifyReviewers } from './publish.js';
import { unconfirmedLines } from './trade.js';

const uidOf = (m) => String(m.from.id);
// Gas headroom required up front, before the exact estimate exists.
const GAS_BUFFER_WEI = 10n ** 16n;
const NO_LINKS = '❌ No links, domains, @handles, emails or phone numbers. Share socials after launch instead.';

function limitMessage(bot, uid) {
  const perDay = bot.cfg.limits.launchesPerUserPerDay;
  if (bot.launchesToday(uid) >= perDay) return `You've reached today's limit of ${perDay} launches. Try again tomorrow.`;
  if (bot.launchesLastHour() >= bot.cfg.limits.launchesPerHourGlobal) return 'The launchpad is very busy right now. Try again in a little while.';
  return null;
}

async function funds(bot, uid) {
  const wallet = bot.wallets.get(uid);
  const [fee, balance] = await Promise.all([bot.chain.launchFee(), bot.chain.nativeBalance(wallet.address)]);
  return { wallet, fee, balance };
}

const cantAfford = (fee, balance) =>
  `💸 Launching costs ${fmtUsdcWei(fee)} USDC plus a little gas. Your balance is ${fmtUsdcWei(balance)} USDC. /deposit, then /launch again.`;

export const dupReason = (dup) => `Another listed token already uses this ${dup.by} (${dup.name}, $${dup.symbol}).`;

export async function start(bot, m) {
  const uid = uidOf(m);
  if (!bot.chain.canLaunch) return bot.reply(uid, '🚧 Launching opens as soon as the launchpad contracts are live on Arc. Stay tuned!');
  const limit = limitMessage(bot, uid);
  if (limit) return bot.reply(uid, limit);
  // Before the wizard (and again before screening): a wallet that can't pay
  // never gets to make the bot pay for a moderation check.
  const f = await funds(bot, uid);
  if (f.balance < f.fee + GAS_BUFFER_WEI) return bot.reply(uid, cantAfford(f.fee, f.balance));
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
    return { fileId: p.file_id, fileUniqueId: p.file_unique_id ?? p.file_id, mime: 'image/jpeg' };
  }
  if (m.document && /^image\//.test(m.document.mime_type ?? '')) return { asFile: true };
  return null;
}

export async function onInput(bot, m, user, convo) {
  const uid = uidOf(m);
  const d = convo.draft;

  if (['name', 'symbol', 'description'].includes(convo.step) && !m.skip && hasLinkEntity(m)) {
    return bot.reply(uid, `${NO_LINKS}\n\nSend it again without that, or /cancel.`);
  }

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
    const dup = bot.duplicateOf(d.name, symbol);
    return bot.reply(uid, [
      `Ticker: <b>$${esc(symbol)}</b>`,
      ...(dup ? [`⚠️ ${esc(dupReason(dup))} Yours will be checked by a moderator before it's posted in the launch channel, and buyers will need your contract address.`] : []),
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
      // Only Telegram's file id is kept: the image itself is downloaded when
      // it is screened, so an abandoned wizard holds no image in memory.
      d.image = pick;
    }
    bot.setConvo(uid, { ...convo, step: 'description' });
    return bot.reply(uid, '(step 4 of 4) Send a short <b>description</b> (up to 200 characters, plain text, no links), or /skip.');
  }

  if (convo.step === 'description') {
    d.description = m.skip ? '' : (m.text ?? '').trim().replace(/\s*\n\s*/g, ' ');
    bot.clearConvo(uid);
    return preview(bot, uid, d);
  }
}

const verdictKey = (d) => createHash('sha256').update(JSON.stringify([d.image?.fileUniqueId ?? null, d.name, d.symbol, d.description])).digest('hex');

async function screen(bot, uid, d) {
  const draft = { name: d.name, symbol: d.symbol, description: d.description };
  const text = checkText(draft, bot.blocklist);
  if (!text.ok) return { verdict: 'block', stage: 'text', reasons: text.reasons, categories: text.categories };
  if (!bot.moderator) return moderateLaunch({ ...draft, image: d.image ? { fileId: d.image.fileId } : null }, { list: bot.blocklist, llm: null });
  // The model is paid per call: the same draft is screened once a day at
  // most, and each user gets a daily number of checks.
  const key = verdictKey(d);
  const cached = bot.verdicts.get(key);
  if (cached && bot.now() - cached.at < 86_400_000) return cached.mod;
  if (!bot.modLimit.hit(uid)) return { limited: true };
  let image = null;
  if (d.image) {
    try {
      image = { buffer: await bot.tg.downloadFile(d.image.fileId, bot.cfg.limits.maxImageBytes), mime: d.image.mime };
    } catch (err) {
      bot.log.error('image download failed:', err.message);
      return { downloadFailed: true };
    }
  }
  const mod = await moderateLaunch({ ...draft, image }, { list: bot.blocklist, llm: bot.moderator });
  bot.verdicts.set(key, { at: bot.now(), mod });
  if (bot.verdicts.size > 500) bot.verdicts.delete(bot.verdicts.keys().next().value);
  return mod;
}

async function preview(bot, uid, d) {
  let f = await funds(bot, uid);
  if (f.balance < f.fee + GAS_BUFFER_WEI) return bot.reply(uid, cantAfford(f.fee, f.balance));
  await bot.reply(uid, '🔎 Checking your launch…');
  let mod = await screen(bot, uid, d);
  if (mod.limited) return bot.reply(uid, 'You\'ve run the launch check many times today. Try again tomorrow.');
  if (mod.downloadFailed) return bot.reply(uid, 'Couldn\'t download your image. Start again with /launch.');
  if (mod.verdict === 'block') {
    bot.log.warn(`launch blocked for ${uid} at ${mod.stage}: ${mod.categories.join(',')} ${mod.reasons.join(' ')}`);
    return bot.reply(uid, `❌ This launch can't go through.\n${esc(mod.reasons.join(' '))}\n\nStart again with /launch.`);
  }
  // The model can't know a ticker or name is already taken: a copy of a
  // listed token always goes to a moderator before it's promoted.
  const dup = bot.duplicateOf(d.name, d.symbol);
  if (dup && mod.verdict === 'allow') mod = { ...mod, verdict: 'review', reasons: [...mod.reasons, dupReason(dup)] };

  // Screening can take a while: the fee and balance shown are read after it.
  f = await funds(bot, uid);
  let gasCost;
  try {
    ({ gasCost } = await bot.chain.estimateLaunch(f.wallet, { name: d.name, symbol: d.symbol, uri: '' }, f.fee));
  } catch (err) {
    bot.log.error('launch estimate failed:', err);
    return bot.reply(uid, 'Couldn\'t prepare the launch right now (the network rejected a test run). Try again shortly.');
  }
  if (f.balance < f.fee + gasCost) return bot.reply(uid, cantAfford(f.fee, f.balance));

  // The fee is part of what the user confirms: exactly this is sent, so a fee
  // change before the tap makes the launch fail instead of costing more.
  const id = bot.createPending(uid, 'launch', {
    name: d.name,
    symbol: d.symbol,
    description: d.description,
    imageFileId: d.image?.fileId ?? null,
    moderation: { verdict: mod.verdict, categories: mod.categories, reasons: mod.reasons },
    fee: f.fee,
  });
  const text = [
    '🚀 <b>Ready to launch</b>',
    '',
    `<b>${esc(d.name)}</b> ($${esc(d.symbol)})`,
    ...(d.description ? [esc(d.description)] : []),
    '',
    'Supply: 1,000,000,000, all of it in the pool with liquidity locked forever.',
    'You earn 0.5% of every buy as the creator.',
    `Cost: <b>${fmtUsdcWei(f.fee)} USDC</b> + ~${fmtUsdcWei(gasCost, 4)} USDC gas`,
    ...(mod.verdict === 'review' ? ['', '⏳ A moderator will check this before it\'s posted in the launch channel. Your token still goes live immediately.'] : []),
    ...(dup ? [`(${esc(dupReason(dup))})`] : []),
    ...unconfirmedLines(bot, uid, 'launch', 'launch'),
  ].join('\n');
  const buttons = bot.confirmButtons(id, '🚀 Launch');
  if (d.image) {
    return bot.sender.send(uid, 'sendPhoto', { photo: d.image.fileId, caption: text, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
  }
  return bot.reply(uid, text, { buttons });
}

// Everything needed to record a launch as the user's, persisted under the
// launch transaction's hash before it is broadcast. JSON only (no BigInt).
function pendingRecord(uid, p, now) {
  return {
    uid: String(uid),
    name: p.name,
    symbol: p.symbol,
    description: p.description ?? '',
    imageFileId: p.imageFileId ?? null,
    moderation: p.moderation,
    fee: String(p.fee),
    at: now,
  };
}

export async function execute(bot, uid, p, track = {}) {
  const user = bot.store.user(uid);
  if (user.banned) return { text: 'Your account can\'t launch right now. Nothing was sent.' };
  const limit = limitMessage(bot, uid);
  if (limit) return { text: `${limit} Nothing was sent.` };
  // Blocklist edits made since the preview still apply.
  const recheck = checkText(p, bot.blocklist);
  if (!recheck.ok) return { text: `❌ ${esc(recheck.reasons.join(' '))} Nothing was sent.` };

  const wallet = bot.wallets.get(uid);
  // This wallet's launches are this user's, whoever records them first.
  bot.store.data.botWallets[wallet.address.toLowerCase()] = String(uid);
  const res = await bot.chain.launch(wallet, { name: p.name, symbol: p.symbol, uri: '' }, p.fee, {
    ...track,
    onSigned: async (hash, info) => {
      bot.store.data.pendingLaunches[hash] = pendingRecord(uid, p, bot.now());
      try {
        if (track.onSigned) await track.onSigned(hash, info);
        else await bot.store.flush();
      } catch (err) {
        delete bot.store.data.pendingLaunches[hash];
        throw err;
      }
    },
    onFinal: (hash, outcome) => {
      if (outcome !== 'confirmed') {
        delete bot.store.data.pendingLaunches[hash];
        bot.store.touch();
      }
      track.onFinal?.(hash, outcome);
    },
  });
  const record = recordBotLaunch(bot, { txHash: res.txHash, ev: res });
  return launchResult(bot, record);
}

// Posts an approved launch, or sends pending ones to the moderators. Not
// awaited by the user's job: a busy channel must not hold the user's queue.
function publish(bot, record) {
  const job = (record.status === 'approved' ? announce(bot, record) : notifyReviewers(bot, record).then(() => false))
    .catch(async (err) => {
      bot.log.error('publishing a launch failed:', err);
      await notifyAdmins(bot, `⚠️ Couldn't post ${tokenLine(record)} in the launch channel: ${esc(err.message)}. /t_${record.key}`);
      return false;
    });
  bot.publishing.set(record.key, job);
  bot.track(job.finally(() => bot.publishing.delete(record.key)));
}

// Records a launch the bot sent, from its Launched event. Called by whoever
// sees it first (the executing job, the indexer or the restart reconciler);
// later calls are no-ops. Returns the record, or null if the launch isn't a
// pending bot launch.
export function recordBotLaunch(bot, { txHash, ev }) {
  const pending = bot.store.data.pendingLaunches?.[txHash];
  const existing = bot.store.launch(ev.token);
  if (existing?.source === 'bot') {
    if (pending) {
      delete bot.store.data.pendingLaunches[txHash];
      bot.store.touch();
    }
    return existing;
  }
  if (!pending) return existing;

  const dup = bot.duplicateOf(pending.name, pending.symbol, ev.token);
  const moderation = dup && pending.moderation?.verdict === 'allow'
    ? { ...pending.moderation, verdict: 'review', reasons: [...(pending.moderation.reasons ?? []), dupReason(dup)] }
    : pending.moderation;
  const status = moderation?.verdict === 'allow' ? 'approved' : 'pending';
  const record = {
    key: existing?.key ?? bot.newLaunchKey(),
    source: 'bot',
    tgUserId: pending.uid,
    index: ev.index,
    token: ev.token,
    vault: ev.vault,
    poolId: ev.poolId,
    creator: ev.creator,
    name: pending.name,
    symbol: pending.symbol,
    description: pending.description,
    imageFileId: pending.imageFileId,
    moderation,
    // An indexer record already hidden by a moderator stays that way.
    status: existing?.hidden ? existing.status : status,
    hidden: existing?.hidden ?? false,
    createdAt: existing?.createdAt ?? bot.now(),
    txHash,
    fee: pending.fee,
    channelMessageId: existing?.channelMessageId ?? null,
    stats: existing?.stats ?? { buys: 0, sells: 0, volume6: '0', hourly: {} },
  };
  bot.store.putLaunch(record);
  const user = bot.store.user(pending.uid);
  user.tokens = [...new Set([...(user.tokens ?? []), ev.token.toLowerCase()])].slice(-50);
  delete bot.store.data.pendingLaunches[txHash];
  bot.store.touch();
  if (!record.hidden) publish(bot, record);
  return record;
}

// The creator's result message. The channel line only claims what is true:
// while the post is still on its way, `after` updates it once it's known.
export function launchResult(bot, record) {
  const text = (announceLine) => [
    `🎉 <b>$${esc(record.symbol)} is live on Arc!</b>`,
    '',
    tokenLine(record),
    `CA: <code>${record.token}</code>`,
    `Vault: <code>${record.vault}</code>`,
    `${record.fee ? `Launch fee paid: ${fmtUsdcWei(BigInt(record.fee))} USDC · ` : ''}${txLink(bot.cfg.explorerUrl, record.txHash, 'launch transaction')}`,
    ...(announceLine ? ['', announceLine] : ['']),
    'Share it: buyers can use /buy with your contract address.',
  ].join('\n');
  const buttons = [[
    { text: '🟢 Buy some', callback_data: `b:${record.key}` },
    { text: '🔍 Explorer', url: bot.explorer('token', record.token) },
  ]];
  const hiddenLine = '🚫 A moderator hid it, so it won\'t be announced.';
  if (record.hidden) return { text: text(hiddenLine), buttons };
  if (record.status !== 'approved') return { text: text('⏳ It\'ll be announced once a moderator approves it.'), buttons };
  if (!bot.cfg.launchesChannel) return { text: text(null), buttons };
  if (record.channelMessageId) return { text: text('📣 Announced in the launch channel.'), buttons };
  return {
    text: text('📣 Posting it in the launch channel…'),
    buttons,
    after: async () => {
      const posted = await (bot.publishing.get(record.key) ?? Boolean(record.channelMessageId));
      if (posted && record.channelMessageId) return { text: text('📣 Announced in the launch channel.'), buttons };
      if (record.hidden || record.status !== 'approved') return { text: text(hiddenLine), buttons };
      return { text: text('⚠️ The launch channel post didn\'t go through; the team has been told.'), buttons };
    },
  };
}
