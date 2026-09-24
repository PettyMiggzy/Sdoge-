import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { getAddress } from 'ethers';
import { Bot } from '../src/bot.js';
import { Store } from '../src/store.js';
import { Wallets } from '../src/wallets.js';
import { loadBlocklist } from '../src/moderation.js';

export const ADMIN = '900';
export const CHANNEL = '-1001';
export const E18 = 10n ** 18n;

export function makeCfg(overrides = {}) {
  return {
    chainId: 5042,
    rpcUrl: 'http://localhost:0',
    explorerUrl: 'https://explorer.arc.io',
    usdc: '0x3600000000000000000000000000000000000000',
    poolManager: getAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951'),
    factory: '0x1111111111111111111111111111111111111111',
    hook: '0x2222222222222222222222222222222222222222',
    router: '0x3333333333333333333333333333333333333333',
    launchesChannel: CHANNEL,
    allowedGroups: new Set(),
    admins: new Set([ADMIN]),
    telegramToken: 'test-token',
    walletSecret: 'ab'.repeat(32),
    veniceKey: '',
    dataDir: '',
    pollIntervalMs: 1000,
    limits: {
      launchesPerUserPerDay: 3,
      launchesPerHourGlobal: 60,
      commandsPerUserPerMinute: 1000,
      reportsPerUserPerDay: 2,
      defaultSlippageBps: 500,
      maxSlippageBps: 3000,
      maxImageBytes: 5_000_000,
      confirmTtlSec: 120,
      wizardTtlSec: 900,
      exportMessageTtlSec: 60,
    },
    moderation: { provider: 'venice', model: 'test-model', timeoutMs: 1000 },
    alerts: { enabled: true, minBuyUsdc: 25, perTokenCooldownSec: 60, channelMaxPerMinute: 15 },
    ...overrides,
  };
}

export class FakeTelegram {
  constructor() {
    this.calls = [];
    this.nextMessageId = 100;
  }

  async call(method, payload = {}) {
    this.calls.push({ method, payload });
    if (method === 'getMe') return { id: 1, username: 'sdogepadbot' };
    if (method === 'sendMessage' || method === 'sendPhoto') return { message_id: this.nextMessageId++ };
    return true;
  }

  async downloadFile(fileId) {
    return Buffer.from(`image-bytes-for-${fileId}`);
  }

  sentTo(chatId) {
    return this.calls.filter((c) => ['sendMessage', 'sendPhoto'].includes(c.method) && String(c.payload.chat_id) === String(chatId));
  }

  last(chatId) {
    return this.sentTo(chatId).at(-1)?.payload;
  }

  lastText(chatId) {
    const p = this.last(chatId);
    return p?.text ?? p?.caption ?? '';
  }

  edits() {
    return this.calls.filter((c) => c.method === 'editMessageText' || c.method === 'editMessageCaption');
  }

  lastEditText() {
    const e = this.edits().at(-1)?.payload;
    return e?.text ?? e?.caption ?? '';
  }

  called(method) {
    return this.calls.filter((c) => c.method === method);
  }
}

export class DirectSender {
  constructor(tg) { this.tg = tg; }
  send(chatId, method, payload) { return this.tg.call(method, { chat_id: chatId, ...payload }); }
}

const addr = (prefix, n) => getAddress('0x' + prefix + n.toString(16).padStart(40 - prefix.length, '0'));

export class FakeChain {
  constructor() {
    this.canLaunch = true;
    this.canTrade = true;
    this.canClaim = true;
    this.fee = 2n * E18;
    this.balances = new Map();
    this.tokenBalances = new Map();
    this.owedByAddr = new Map();
    this.vault = { backing6: 0n, supply: 10n ** 27n, floor18: 0n };
    this.calls = [];
    this.launches = 0;
    this.failNext = null;
  }

  #maybeFail() {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }

  setBalance(address, wei) { this.balances.set(address, wei); }
  setTokenBalance(token, address, amount) { this.tokenBalances.set(`${token.toLowerCase()}:${address}`, amount); }

  async nativeBalance(a) { return this.balances.get(a) ?? 0n; }
  async tokenBalance(t, a) { return this.tokenBalances.get(`${t.toLowerCase()}:${a}`) ?? 0n; }
  async launchFee() { return this.fee; }
  async estimateLaunch() { return { fee: this.fee, gasCost: 10n ** 15n }; }
  async poolSqrtPrice() { return 2n ** 96n * 1000n; }
  async isContract() { return false; }
  async owed(a) { return this.owedByAddr.get(a) ?? 0n; }
  async vaultState() { return this.vault; }
  async quoteRedeem(vault, amount) { return this.vault.supply > 0n ? (amount * this.vault.backing6) / this.vault.supply : 0n; }
  async blockNumber() { return 1000; }
  async getLogs() { return []; }

  async launch(signer, draft) {
    this.#maybeFail();
    this.calls.push({ fn: 'launch', from: signer.address, draft });
    const n = ++this.launches;
    return {
      txHash: '0x' + 'a'.repeat(63) + n,
      index: n - 1,
      poolId: '0x' + n.toString(16).padStart(64, '0'),
      token: addr('77', n),
      vault: addr('88', n),
      creator: signer.address,
    };
  }

  // 1 USDC (1e6) buys 1000 tokens (1000e18).
  async quoteBuy(token, usdc6) { return usdc6 * 10n ** 15n; }
  async quoteSell(token, amount) { return amount / 10n ** 15n; }

  async buy(signer, token, usdc6, minOut, deadline) {
    this.#maybeFail();
    this.calls.push({ fn: 'buy', from: signer.address, token, usdc6, minOut, deadline });
    return { txHash: '0x' + 'b'.repeat(64), received: usdc6 * 10n ** 15n };
  }

  async sell(signer, token, amount, minOut, deadline) {
    this.#maybeFail();
    this.calls.push({ fn: 'sell', from: signer.address, token, amount, minOut, deadline });
    return { txHash: '0x' + 'c'.repeat(64), received6: amount / 10n ** 15n };
  }

  async claim(signer) {
    this.calls.push({ fn: 'claim', from: signer.address });
    return { txHash: '0x' + 'd'.repeat(64), received6: this.owedByAddr.get(signer.address) ?? 0n };
  }

  async redeem(signer, l, amount, minOut) {
    this.calls.push({ fn: 'redeem', from: signer.address, token: l.token, amount, minOut });
    return { txHash: '0x' + 'e'.repeat(64), received6: 123n };
  }

  async maxWithdrawable(signer) { return (this.balances.get(signer.address) ?? 0n) - 10n ** 15n; }

  async withdraw(signer, to, value) {
    this.calls.push({ fn: 'withdraw', from: signer.address, to, value });
    return { txHash: '0x' + 'f'.repeat(64) };
  }
}

export class StubModerator {
  constructor(verdict = 'allow') {
    this.verdict = verdict;
    this.seen = [];
  }

  async review(draft) {
    this.seen.push(draft);
    return { verdict: this.verdict, categories: this.verdict === 'allow' ? [] : ['other'], reason: `stub ${this.verdict}` };
  }
}

export async function makeBot({ moderator = new StubModerator('allow'), cfg = makeCfg(), clock } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgpad-test-'));
  const store = await Store.open(path.join(dir, 'store.json'));
  const tg = new FakeTelegram();
  const chain = new FakeChain();
  const time = clock ?? { t: 1_800_000_000_000 };
  const bot = new Bot({
    cfg,
    store,
    tg,
    sender: new DirectSender(tg),
    chain,
    wallets: new Wallets(cfg.walletSecret),
    moderator,
    blocklist: loadBlocklist(),
    log: { error() {}, warn() {}, info() {} },
    now: () => time.t,
  });
  await bot.init();
  return { bot, tg, chain, store, cfg, time };
}

let updateSeq = 1;

export function msg(uid, text, extra = {}) {
  const id = updateSeq++;
  return {
    update_id: id,
    message: {
      message_id: id,
      from: { id: Number(uid), is_bot: false, username: `user${uid}` },
      chat: { id: Number(uid), type: 'private' },
      ...(text === null ? {} : { text }),
      ...extra,
    },
  };
}

export function photo(uid, fileId = 'photo-file-1') {
  return msg(uid, null, { photo: [{ file_id: `${fileId}-small`, file_size: 100 }, { file_id: fileId, file_size: 1000 }] });
}

export function tap(uid, data, { messageId = 1, photo: isPhoto = false } = {}) {
  const id = updateSeq++;
  return {
    update_id: id,
    callback_query: {
      id: `cq${id}`,
      from: { id: Number(uid) },
      data,
      message: { message_id: messageId, chat: { id: Number(uid), type: 'private' }, ...(isPhoto ? { photo: [{ file_id: 'x' }] } : {}) },
    },
  };
}

// The callback_data of a button on the last message sent to a chat.
export function button(tg, chatId, index = 0) {
  const kb = tg.last(chatId)?.reply_markup?.inline_keyboard ?? [];
  return kb.flat()[index]?.callback_data;
}

export async function send(bot, update) {
  await bot.dispatch(update);
  await bot.drain();
}

export async function acceptTerms(bot, uid) {
  await send(bot, tap(uid, 'tos:ok'));
}
