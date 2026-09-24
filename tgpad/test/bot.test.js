import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'ethers';
import { derivePrivateKey } from '../src/wallets.js';
import { ADMIN, CHANNEL, E18, StubModerator, acceptTerms, button, makeBot, msg, photo, send, tap } from './helpers.js';

const U = '12345';
const V = '67890';

function addLaunch(bot, overrides = {}) {
  const n = Object.keys(bot.store.data.launches).length + 1;
  const record = {
    key: bot.newLaunchKey(),
    source: 'bot',
    tgUserId: '555',
    index: n - 1,
    token: getAddress('0x' + '77' + n.toString(16).padStart(38, '0')),
    vault: getAddress('0x' + '88' + n.toString(16).padStart(38, '0')),
    poolId: '0x' + n.toString(16).padStart(64, '0'),
    creator: getAddress('0x' + '99'.repeat(20)),
    name: 'Cap Doge',
    symbol: 'CAPD',
    description: '',
    imageFileId: null,
    moderation: { verdict: 'allow', categories: [], reasons: [] },
    status: 'approved',
    hidden: false,
    createdAt: bot.now(),
    txHash: '0x' + '0'.repeat(64),
    channelMessageId: null,
    stats: { buys: 0, sells: 0, volume6: '0', hourly: {} },
    ...overrides,
  };
  bot.store.putLaunch(record);
  return record;
}

async function ready(bot, chain, uid = U, usdc = 100n) {
  await acceptTerms(bot, uid);
  chain.setBalance(bot.wallets.address(uid), usdc * E18);
}

async function runWizard(bot, uid, { name = 'Cap Doge', ticker = 'capd', withPhoto = true, description = 'the goodest boy' } = {}) {
  await send(bot, msg(uid, '/launch'));
  await send(bot, msg(uid, name));
  await send(bot, msg(uid, ticker));
  await send(bot, withPhoto ? photo(uid, 'pic1') : msg(uid, '/skip'));
  await send(bot, description === null ? msg(uid, '/skip') : msg(uid, description));
}

test('terms gate: nothing but /start, /help, /terms works before agreeing', async () => {
  const { bot, tg, store } = await makeBot();
  await send(bot, msg(U, '/wallet'));
  assert.match(tg.lastText(U), /Before you start/);
  assert.equal(button(tg, U), 'tos:ok');
  await send(bot, msg(U, '/help'));
  assert.match(tg.lastText(U), /SDOGE Launchpad/);
  await acceptTerms(bot, U);
  assert.ok(store.user(U).tosAt);
  await send(bot, msg(U, '/wallet'));
  assert.match(tg.lastText(U), /Your wallet/);
  assert.match(tg.lastText(U), new RegExp(bot.wallets.address(U)));
});

test('launch wizard: moderated, previewed, confirmed, launched from the user\'s own wallet, announced', async () => {
  const moderator = new StubModerator('allow');
  const { bot, tg, chain, store } = await makeBot({ moderator });
  await ready(bot, chain);
  await runWizard(bot, U);

  assert.equal(moderator.seen.length, 1);
  assert.equal(moderator.seen[0].symbol, 'CAPD');
  assert.ok(moderator.seen[0].image.buffer.length > 0, 'the actual image bytes were screened');

  const preview = tg.sentTo(U).at(-1);
  assert.equal(preview.method, 'sendPhoto');
  assert.match(preview.payload.caption, /Ready to launch/);
  const confirm = button(tg, U);
  assert.match(confirm, /^ok:/);

  await send(bot, tap(U, confirm, { photo: true }));
  assert.deepEqual(chain.calls.map((c) => c.fn), ['launch']);
  assert.equal(chain.calls[0].from, bot.wallets.address(U), 'creator = the user\'s derived wallet');
  assert.deepEqual(chain.calls[0].draft, { name: 'Cap Doge', symbol: 'CAPD', uri: '' });

  const l = Object.values(store.data.launches)[0];
  assert.equal(l.status, 'approved');
  assert.equal(l.tgUserId, U);
  assert.equal(l.imageFileId, 'pic1');
  const post = tg.sentTo(CHANNEL).at(-1);
  assert.equal(post.method, 'sendPhoto');
  assert.equal(post.payload.photo, 'pic1');
  assert.match(post.payload.caption, new RegExp(l.token));
  assert.ok(l.channelMessageId);
  assert.match(tg.lastEditText(), /is live on Arc/);
  assert.equal(tg.edits().at(-1).method, 'editMessageCaption', 'photo previews are edited via caption');
  assert.ok(store.user(U).tokens.includes(l.token.toLowerCase()));
});

test('local rules reject a bad name and keep the wizard on that step', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  await send(bot, msg(U, '/launch'));
  await send(bot, msg(U, 'Tether'));
  assert.match(tg.lastText(U), /existing asset/);
  await send(bot, msg(U, 'Good Doge'));
  assert.match(tg.lastText(U), /step 2 of 4/);
});

test('files are refused in favour of photos', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  await send(bot, msg(U, '/launch'));
  await send(bot, msg(U, 'Good Doge'));
  await send(bot, msg(U, 'GDOG'));
  await send(bot, msg(U, null, { document: { file_id: 'doc1', mime_type: 'image/png', file_size: 10 } }));
  assert.match(tg.lastText(U), /as a <b>photo<\/b>/);
});

test('a model "block" stops the launch before anything touches the chain', async () => {
  const { bot, tg, chain } = await makeBot({ moderator: new StubModerator('block') });
  await ready(bot, chain);
  await runWizard(bot, U);
  assert.match(tg.lastText(U), /can't go through/);
  assert.equal(button(tg, U), undefined, 'no confirm button offered');
  assert.equal(chain.calls.length, 0);
});

test('a model "review" launches but holds the announcement until an admin approves', async () => {
  const { bot, tg, chain, store } = await makeBot({ moderator: new StubModerator('review') });
  await ready(bot, chain);
  await runWizard(bot, U);
  assert.match(tg.lastText(U), /moderator will check/);
  await send(bot, tap(U, button(tg, U), { photo: true }));

  const l = Object.values(store.data.launches)[0];
  assert.equal(l.status, 'pending');
  assert.equal(tg.sentTo(CHANNEL).length, 0, 'nothing posted publicly yet');
  const card = tg.last(ADMIN);
  assert.equal(card.photo, 'pic1');
  assert.equal(card.reply_markup.inline_keyboard[0][0].callback_data, `rv:ok:${l.key}`);

  await send(bot, tap(V, `rv:ok:${l.key}`, { photo: true }));
  assert.equal(l.status, 'pending', 'non-admins cannot approve');

  await send(bot, tap(ADMIN, `rv:ok:${l.key}`, { photo: true }));
  assert.equal(l.status, 'approved');
  assert.equal(tg.sentTo(CHANNEL).length, 1);
  assert.match(tg.lastText(U), /passed review/);
});

test('admin rejection hides the token and tells the creator', async () => {
  const { bot, tg, chain, store } = await makeBot({ moderator: new StubModerator('review') });
  await ready(bot, chain);
  await runWizard(bot, U);
  await send(bot, tap(U, button(tg, U), { photo: true }));
  const l = Object.values(store.data.launches)[0];
  await send(bot, tap(ADMIN, `rv:no:${l.key}`, { photo: true }));
  assert.equal(l.status, 'rejected');
  assert.equal(l.hidden, true);
  assert.match(tg.lastText(U), /didn't pass review/);
  assert.equal(tg.sentTo(CHANNEL).length, 0);
});

test('launch limits: per user per day', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  for (let i = 0; i < 3; i++) addLaunch(bot, { tgUserId: U });
  await send(bot, msg(U, '/launch'));
  assert.match(tg.lastText(U), /today's limit of 3/);
});

test('not enough USDC to launch: clear message, no confirmation offered', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain, U, 1n);
  await runWizard(bot, U);
  assert.match(tg.lastText(U), /Launching costs 2 USDC/);
  assert.equal(button(tg, U), undefined);
});

test('buy: quote, slippage floor, exact args to the router, holdings tracked', async () => {
  const { bot, tg, chain, store, time } = await makeBot();
  await ready(bot, chain);
  const l = addLaunch(bot);
  await send(bot, msg(U, '/buy $capd 10'));
  assert.match(tg.lastText(U), /Buy \$CAPD/);
  await send(bot, tap(U, button(tg, U)));
  const call = chain.calls.find((c) => c.fn === 'buy');
  assert.equal(call.token, l.token);
  assert.equal(call.usdc6, 10_000_000n);
  assert.equal(call.minOut, (10_000_000n * 10n ** 15n * 9500n) / 10000n, '5% default slippage');
  assert.equal(call.deadline, Math.floor(time.t / 1000) + 300);
  assert.match(tg.lastEditText(), /Bought/);
  assert.ok(store.user(U).tokens.includes(l.token.toLowerCase()));
});

test('custom slippage is used for the minimum out', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  addLaunch(bot);
  await send(bot, msg(U, '/slippage 3'));
  await send(bot, msg(U, '/buy CAPD 1'));
  await send(bot, tap(U, button(tg, U)));
  assert.equal(chain.calls.find((c) => c.fn === 'buy').minOut, (1_000_000n * 10n ** 15n * 9700n) / 10000n);
});

test('buy refuses when the wallet can\'t cover amount + gas', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain, U, 5n);
  addLaunch(bot);
  await send(bot, msg(U, '/buy CAPD 10'));
  assert.match(tg.lastText(U), /This buy needs 10/);
  assert.equal(button(tg, U), undefined);
});

test('hidden tokens can\'t be bought through the bot, but holders can still sell', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  const l = addLaunch(bot, { hidden: true });
  await send(bot, msg(U, `/buy ${l.token} 10`));
  assert.match(tg.lastText(U), /hidden by moderators/);
  chain.setTokenBalance(l.token, bot.wallets.address(U), 1000n * E18);
  await send(bot, msg(U, `/sell ${l.token} 50%`));
  assert.match(tg.lastText(U), /Sell \$CAPD/);
  await send(bot, tap(U, button(tg, U)));
  assert.equal(chain.calls.find((c) => c.fn === 'sell').amount, 500n * E18);
});

test('ban: blocks launch/buy/report, never blocks selling, withdrawing or exporting', async () => {
  const { bot, tg, chain, store } = await makeBot();
  await ready(bot, chain);
  const l = addLaunch(bot);
  await send(bot, msg(U, '/buy CAPD 10'));
  const staleBuy = button(tg, U);

  await send(bot, msg(ADMIN, '/ban @user12345 spam'));
  assert.equal(store.user(U).banned, true);

  await send(bot, msg(U, '/launch'));
  assert.match(tg.lastText(U), /can't launch, buy or report/);
  await send(bot, tap(U, staleBuy));
  assert.equal(chain.calls.filter((c) => c.fn === 'buy').length, 0, 'a buy confirmed before the ban is refused');

  chain.setTokenBalance(l.token, bot.wallets.address(U), 10n * E18);
  await send(bot, msg(U, '/sell CAPD all'));
  assert.match(tg.lastText(U), /Sell \$CAPD/);
  await send(bot, msg(U, '/withdraw 5 0x1234567890123456789012345678901234567890'));
  assert.match(tg.lastText(U), /Withdraw/);
  await send(bot, msg(U, '/export'));
  assert.match(tg.lastText(U), /Export private key/);
});

test('one user can\'t confirm another user\'s pending action; the owner still can', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  await ready(bot, chain, V);
  addLaunch(bot);
  await send(bot, msg(U, '/buy CAPD 10'));
  const confirm = button(tg, U);
  await send(bot, tap(V, confirm));
  assert.equal(chain.calls.length, 0);
  await send(bot, tap(U, confirm));
  assert.equal(chain.calls.filter((c) => c.fn === 'buy').length, 1);
  assert.equal(chain.calls[0].from, bot.wallets.address(U));
});

test('confirmations expire, and each one can only be used once', async () => {
  const { bot, tg, chain, time } = await makeBot();
  await ready(bot, chain);
  addLaunch(bot);
  await send(bot, msg(U, '/buy CAPD 10'));
  const first = button(tg, U);
  time.t += 121_000;
  await send(bot, tap(U, first));
  assert.equal(chain.calls.length, 0);
  assert.match(tg.lastEditText(), /expired/);

  await send(bot, msg(U, '/buy CAPD 10'));
  const second = button(tg, U);
  await send(bot, tap(U, second));
  await send(bot, tap(U, second));
  assert.equal(chain.calls.filter((c) => c.fn === 'buy').length, 1);
});

test('the bot leaves groups it wasn\'t invited to by the team', async () => {
  const { bot, tg } = await makeBot();
  await send(bot, { update_id: 1, message: { message_id: 1, from: { id: 1 }, chat: { id: -5, type: 'supergroup' }, text: '/buy x' } });
  assert.equal(tg.called('leaveChat').at(-1).payload.chat_id, -5);
  await send(bot, { update_id: 2, my_chat_member: { from: { id: 1 }, chat: { id: -6, type: 'group' }, new_chat_member: { status: 'member' } } });
  assert.equal(tg.called('leaveChat').at(-1).payload.chat_id, -6);
  await send(bot, { update_id: 3, my_chat_member: { from: { id: 1 }, chat: { id: Number(CHANNEL), type: 'channel' }, new_chat_member: { status: 'administrator' } } });
  assert.equal(tg.called('leaveChat').length, 2, 'stays in its own launch channel');
});

test('withdraw guards destinations and sends exact 18-decimal amounts', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  await send(bot, msg(U, '/withdraw 5 0x0000000000000000000000000000000000000001'));
  assert.match(tg.lastText(U), /precompile address/);
  await send(bot, msg(U, `/withdraw 5 ${bot.wallets.address(U)}`));
  assert.match(tg.lastText(U), /your bot wallet itself/);
  await send(bot, msg(U, '/withdraw 5 0xnotanaddress'));
  assert.match(tg.lastText(U), /isn't a valid address/);

  const dest = '0x1234567890123456789012345678901234567890';
  await send(bot, msg(U, `/withdraw 5.5 ${dest}`));
  await send(bot, tap(U, button(tg, U)));
  const call = chain.calls.find((c) => c.fn === 'withdraw');
  assert.equal(call.value, 55n * 10n ** 17n);
  assert.equal(call.to, getAddress(dest));

  await send(bot, msg(U, `/withdraw all ${dest}`));
  await send(bot, tap(U, button(tg, U)));
  assert.equal(chain.calls.filter((c) => c.fn === 'withdraw').at(-1).value, 100n * E18 - 10n ** 15n);
});

test('export sends the derived key, spoilered and non-forwardable', async () => {
  const { bot, tg, chain, cfg } = await makeBot();
  await ready(bot, chain);
  await send(bot, msg(U, '/export'));
  await send(bot, tap(U, button(tg, U)));
  const keyMsg = tg.sentTo(U).find((c) => c.payload.text?.includes('tg-spoiler'));
  assert.ok(keyMsg);
  assert.equal(keyMsg.payload.protect_content, true);
  assert.ok(keyMsg.payload.text.includes(derivePrivateKey(cfg.walletSecret, U)));
});

test('redeem previews the vault payout and warns when selling pays more', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  const l = addLaunch(bot);
  chain.setTokenBalance(l.token, bot.wallets.address(U), 100n * E18);
  chain.vault = { usdc6: 1_000_000n, owed6: 0n, circulating: 10_000n * E18 };
  await send(bot, msg(U, '/redeem CAPD all'));
  const text = tg.lastText(U);
  assert.match(text, /Get: ~<b>0\.01 USDC<\/b>/);
  assert.match(text, /Selling would get/);
  await send(bot, tap(U, button(tg, U)));
  assert.equal(chain.calls.find((c) => c.fn === 'redeem').amount, 100n * E18);

  chain.vault = { usdc6: 0n, owed6: 0n, circulating: 10_000n * E18 };
  await send(bot, msg(U, '/redeem CAPD all'));
  assert.match(tg.lastText(U), /vault is empty/);
});

test('admin /hide pulls the channel post; non-admins can\'t even see the command', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  await acceptTerms(bot, ADMIN);
  const l = addLaunch(bot, { channelMessageId: 42 });
  await send(bot, msg(U, `/hide ${l.token}`));
  assert.match(tg.lastText(U), /don't know that command/);
  assert.equal(l.hidden, false);
  await send(bot, msg(ADMIN, `/hide ${l.token} scam`));
  assert.equal(l.hidden, true);
  assert.equal(l.hiddenReason, 'scam');
  assert.deepEqual(tg.called('deleteMessage').at(-1).payload, { chat_id: CHANNEL, message_id: 42 });
});

test('reports reach admins and are rate-limited', async () => {
  const { bot, tg, chain, store } = await makeBot();
  await ready(bot, chain);
  addLaunch(bot);
  await send(bot, msg(U, '/report CAPD fake team'));
  assert.match(tg.lastText(ADMIN), /Report on <b>\$CAPD<\/b>/);
  await send(bot, msg(U, '/report CAPD again'));
  await send(bot, msg(U, '/report CAPD and again'));
  assert.match(tg.lastText(U), /a lot of reports/);
  assert.equal(store.data.reports.length, 2);
});

test('deep link and quick-amount buttons lead to a buy preview', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  const l = addLaunch(bot);
  await send(bot, msg(U, `/start b_${l.key}`));
  assert.match(tg.lastText(U), /How much USDC/);
  assert.equal(button(tg, U, 1), `ba:${l.key}:10`);
  await send(bot, tap(U, `ba:${l.key}:10`));
  assert.match(tg.lastText(U), /Spend: <b>10 USDC<\/b>/);

  await send(bot, msg(U, `/start b_${l.key}`));
  await send(bot, msg(U, '2.5'));
  assert.match(tg.lastText(U), /Spend: <b>2\.5 USDC<\/b>/);
});

test('a failed transaction shows a friendly error, not RPC internals', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  addLaunch(bot);
  await send(bot, msg(U, '/buy CAPD 10'));
  chain.failNext = Object.assign(new Error('execution reverted: TooLittleReceived()'), { shortMessage: 'execution reverted: TooLittleReceived()' });
  await send(bot, tap(U, button(tg, U)));
  assert.match(tg.lastEditText(), /slippage limit/);
});

test('trading and launching show a clear "not live yet" state before contracts are set', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  chain.canLaunch = false;
  chain.canTrade = false;
  await send(bot, msg(U, '/launch'));
  assert.match(tg.lastText(U), /opens as soon as the launchpad contracts are live/);
  await send(bot, msg(U, '/buy CAPD 1'));
  assert.match(tg.lastText(U), /Trading opens/);
});

test('an RPC failure while preparing a command gets a reply instead of silence', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  addLaunch(bot);
  chain.quoteBuy = async () => { throw new Error('socket hang up'); };
  await send(bot, msg(U, '/buy CAPD 10'));
  assert.match(tg.lastText(U), /Couldn't get a price/);
  chain.nativeBalance = async () => { throw new Error('socket hang up'); };
  await send(bot, msg(U, '/wallet'));
  assert.match(tg.lastText(U), /Something went wrong on our side/);
});

test('ticker lookups with duplicates ask for the contract address', async () => {
  const { bot, tg, chain } = await makeBot();
  await ready(bot, chain);
  addLaunch(bot);
  addLaunch(bot);
  await send(bot, msg(U, '/token CAPD'));
  assert.match(tg.lastText(U), /Several tokens use \$CAPD/);
});
