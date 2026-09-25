// The launch channel: /hide takes things down for real (R2-TGPAD-18), and an
// announcement racing a /hide or a review never outlives it (R2-TGPAD-24).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramError } from '../src/telegram.js';
import { ADMIN, CHANNEL, E18, StubModerator, acceptTerms, addLaunch, button, gate, makeBot, makeCfg, msg, send, settle, tap } from './helpers.js';

const U = '12345';

function refuse(tg, methods) {
  const call = tg.call.bind(tg);
  tg.call = async (method, payload) => {
    if (methods.includes(method)) {
      tg.calls.push({ method, payload });
      throw new TelegramError(method, { ok: false, error_code: 400, description: 'Bad Request: message can\'t be deleted for everyone' });
    }
    return call(method, payload);
  };
}

async function launchPreview(bot, tg, chain, name = 'Scam Doge', ticker = 'SCMD') {
  await acceptTerms(bot, U);
  chain.setBalance(bot.wallets.address(U), 100n * E18);
  await send(bot, msg(U, '/launch'));
  await send(bot, msg(U, name));
  await send(bot, msg(U, ticker));
  await send(bot, msg(U, '/skip'));
  await send(bot, msg(U, '/skip'));
  return button(tg, U);
}

// ---------------------------------------------------------------- R2-TGPAD-18

test('R2-TGPAD-18: a post too old to delete is replaced with a removal notice, and the admin is told', async () => {
  const { bot, tg } = await makeBot();
  await acceptTerms(bot, ADMIN);
  const l = addLaunch(bot, { channelMessageId: 4242, imageFileId: 'pic', channelPhoto: true, createdAt: bot.now() - 3 * 86_400_000 });
  refuse(tg, ['deleteMessage']);
  await send(bot, msg(ADMIN, `/hide ${l.token} phishing`));
  const edit = tg.called('editMessageCaption').at(-1).payload;
  assert.deepEqual([edit.chat_id, edit.message_id, edit.caption], [CHANNEL, 4242, '🚫 Removed by the moderators.']);
  assert.deepEqual(edit.reply_markup, { inline_keyboard: [] }, 'the Buy button is gone');
  assert.match(tg.lastText(ADMIN), /replaced with a removal notice/);
  assert.equal(l.channelMessageId, 4242, 'the post is still tracked');
});

test('R2-TGPAD-18: a post that can\'t be removed at all is reported with a link, and a second /hide retries', async () => {
  const { bot, tg } = await makeBot();
  await acceptTerms(bot, ADMIN);
  const l = addLaunch(bot, { channelMessageId: 555 });
  refuse(tg, ['deleteMessage', 'editMessageText', 'editMessageReplyMarkup']);
  await send(bot, msg(ADMIN, `/hide ${l.token} scam`));
  assert.match(tg.lastText(ADMIN), /still up.*delete it by hand: https:\/\/t\.me\/c\/1\/555/);
  assert.equal(l.channelMessageId, 555, 'kept, so it can be retried');
  tg.call = (await makeBot()).tg.call.bind(tg); // Telegram works again
  await send(bot, msg(ADMIN, `/hide ${l.token} scam`));
  assert.deepEqual(tg.called('deleteMessage').at(-1).payload, { chat_id: CHANNEL, message_id: 555 });
  assert.match(tg.lastText(ADMIN), /channel post was deleted/);
  assert.equal(l.channelMessageId, null);
});

test('R2-TGPAD-18: /hide also takes the token\'s buy alerts down', async () => {
  const { bot, tg } = await makeBot();
  await acceptTerms(bot, ADMIN);
  const l = addLaunch(bot, { alertMessageIds: [301, 302] });
  await send(bot, msg(ADMIN, `/hide ${l.token}`));
  assert.deepEqual(tg.called('deleteMessage').map((c) => c.payload.message_id), [301, 302]);
  assert.match(tg.lastText(ADMIN), /2 buy alert\(s\) removed/);
  assert.deepEqual(l.alertMessageIds, []);
});

// ---------------------------------------------------------------- R2-TGPAD-24

test('R2-TGPAD-24: /hide while the announcement waits for its channel slot: the post comes down as soon as it lands', async () => {
  const { bot, tg, chain, store } = await makeBot({ moderator: new StubModerator('allow') });
  const slot = gate();
  const direct = bot.sender;
  bot.sender = { send: async (chat, method, payload, opts) => { if (String(chat) === CHANNEL) await slot.promise; return direct.send(chat, method, payload, opts); } };
  const ok = await launchPreview(bot, tg, chain);
  await acceptTerms(bot, ADMIN);
  const job = bot.dispatch(tap(U, ok));
  await settle();
  const l = Object.values(store.data.launches)[0];
  assert.equal(l.channelMessageId, null);
  await bot.dispatch(msg(ADMIN, `/hide ${l.token} scam`));
  // The guard runs right before the send: nothing is posted at all.
  slot.open();
  await job;
  await bot.drain();
  assert.equal(tg.sentTo(CHANNEL).length, 0);
  assert.match(tg.lastEditText(), /A moderator hid it, so it won't be announced/);
  assert.doesNotMatch(tg.lastEditText(), /Announced in the launch channel/);
});

test('R2-TGPAD-24: hidden while the post was on its way: it is deleted right after it lands', async () => {
  const { bot, tg } = await makeBot();
  const l = addLaunch(bot);
  const { announce } = await import('../src/flows/publish.js');
  const direct = bot.sender;
  // The API call itself is in flight when the admin hides the token.
  bot.sender = { send: async (chat, method, payload, opts) => {
    const res = await direct.send(chat, method, payload, opts);
    l.hidden = true;
    return res;
  } };
  assert.equal(await announce(bot, l), false);
  const posted = tg.sentTo(CHANNEL).at(-1);
  assert.ok(posted);
  assert.equal(tg.called('deleteMessage').at(-1).payload.chat_id, CHANNEL, 'taken straight down');
  assert.equal(l.channelMessageId, null);
});

test('R2-TGPAD-24: with no launch channel, the creator isn\'t told "Announced"', async () => {
  const { bot, tg, chain } = await makeBot({ cfg: makeCfg({ launchesChannel: '' }) });
  const ok = await launchPreview(bot, tg, chain, 'Quiet Doge', 'QUIET');
  await send(bot, tap(U, ok));
  assert.match(tg.lastEditText(), /is live on Arc/);
  assert.doesNotMatch(tg.lastEditText(), /nnounced/);
});

test('R2-TGPAD-24: when the channel post fails, the creator is told so (and admins hear about it)', async () => {
  const { bot, tg, chain } = await makeBot();
  const ok = await launchPreview(bot, tg, chain, 'Good Doge', 'GDOG');
  const call = tg.call.bind(tg);
  tg.call = async (method, payload) => {
    if (String(payload.chat_id) === CHANNEL) throw new TelegramError(method, { ok: false, error_code: 403, description: 'Forbidden: bot is not a member of the channel chat' });
    return call(method, payload);
  };
  await send(bot, tap(U, ok));
  assert.match(tg.lastEditText(), /launch channel post didn't go through/);
  assert.match(tg.lastText(ADMIN), /Couldn't post .*Good Doge/);
});

test('R2-TGPAD-24: an approved review only says "announced" once the post is up', async () => {
  const { bot, tg, chain, store } = await makeBot({ moderator: new StubModerator('review') });
  const ok = await launchPreview(bot, tg, chain, 'Good Doge', 'GDOG');
  await send(bot, tap(U, ok));
  const l = Object.values(store.data.launches)[0];
  const call = tg.call.bind(tg);
  tg.call = async (method, payload) => {
    if (String(payload.chat_id) === CHANNEL) throw new TelegramError(method, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
    return call(method, payload);
  };
  await send(bot, tap(ADMIN, `rv:ok:${l.key}`, { photo: true }));
  assert.equal(l.status, 'approved');
  assert.match(tg.lastText(U), /passed review\./);
  assert.doesNotMatch(tg.lastText(U), /announced/);
});
