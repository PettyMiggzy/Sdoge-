import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { getAddress } from 'ethers';
import { Bot } from '../src/bot.js';
import { Store } from '../src/store.js';
import { Wallets } from '../src/wallets.js';
import { TxError } from '../src/errors.js';
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
    blockTimeMs: 500,
    maintenanceIntervalMs: 15000,
    txTimeoutSec: 120,
    rpcMaxConcurrent: 8,
    limits: {
      launchesPerUserPerDay: 3,
      launchesPerHourGlobal: 60,
      commandsPerUserPerMinute: 1000,
      reportsPerUserPerDay: 2,
      moderationChecksPerUserPerDay: 100,
      defaultSlippageBps: 100,
      execSlippageBps: 100,
      maxSlippageBps: 3000,
      maxImageBytes: 5_000_000,
      confirmTtlSec: 120,
      wizardTtlSec: 900,
      exportMessageTtlSec: 60,
    },
    moderation: { provider: 'venice', model: 'test-model', timeoutMs: 1000 },
    alerts: { enabled: true, minBuyUsdc: 25, perTokenCooldownSec: 60, channelMaxPerMinute: 15, maxLagBlocks: 120, indexerBehindBlocks: 3000 },
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
    this.downloads = (this.downloads ?? 0) + 1;
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

// Sends straight away, honouring the Sender's last-moment `guard`.
export class DirectSender {
  constructor(tg) { this.tg = tg; }
  send(chatId, method, payload, { guard } = {}) {
    if (guard && !guard()) return Promise.resolve(null);
    return this.tg.call(method, { chat_id: chatId, ...payload });
  }
}

const addr = (prefix, n) => getAddress('0x' + prefix + n.toString(16).padStart(40 - prefix.length, '0'));

// Integer square root, for a pool price consistent with the fake quotes.
function isqrt(n) {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

// Mirrors src/chain.js: every write reports its hash to track.onSigned before
// "broadcast" and its outcome to track.onFinal, and failures are TxErrors.
//   failNext     an error thrown before anything is signed
//   outcomeNext  'unknown' | 'reverted' | 'refused', or { outcome, reason },
//                for the next transaction after it was signed
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
    this.txCount = 0;
    this.failNext = null;
    this.outcomeNext = null;
    this.needsApproval = false;
    this.receipts = new Map();
  }

  #maybeFail() {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }

  async #tx(label, track, result) {
    this.#maybeFail();
    const hash = '0x' + label.slice(0, 1).charCodeAt(0).toString(16) + (++this.txCount).toString(16).padStart(62, '0');
    await track?.onSigned?.(hash, { label });
    const next = this.outcomeNext;
    if (next) {
      this.outcomeNext = null;
      const { outcome, reason = null } = typeof next === 'string' ? { outcome: next } : next;
      if (outcome !== 'unknown') track?.onFinal?.(hash, outcome);
      throw new TxError(outcome, `fake ${outcome}: ${hash}`, { hash, reason, label });
    }
    const res = result(hash);
    this.receipts.set(hash, { hash, status: 1, launched: res.launched ?? null });
    track?.onFinal?.(hash, 'confirmed');
    return res;
  }

  setBalance(address, wei) { this.balances.set(address, wei); }
  setTokenBalance(token, address, amount) { this.tokenBalances.set(`${token.toLowerCase()}:${address}`, amount); }

  async nativeBalance(a) { return this.balances.get(a) ?? 0n; }
  async tokenBalance(t, a) { return this.tokenBalances.get(`${t.toLowerCase()}:${a}`) ?? 0n; }
  async launchFee() { return this.fee; }
  async estimateLaunch(signer, draft, fee) { return { fee, gasCost: 10n ** 15n }; }
  // 1 USDC buys 1000 tokens: $0.001 a token, like the fake quotes below.
  async poolSqrtPrice() { return isqrt((10n ** 15n) << 192n); }
  async isContract() { return false; }
  async owed(a) { return this.owedByAddr.get(a) ?? 0n; }
  async vaultState() { return this.vault; }
  async quoteRedeem(vault, amount) { return this.vault.supply > 0n ? (amount * this.vault.backing6) / this.vault.supply : 0n; }
  async blockNumber() { return 1000; }
  async getLogs() { return []; }
  async getReceipt(hash) { return this.receipts.get(hash) ?? null; }
  launchedEvent(receipt) { return receipt.launched ?? null; }

  // Like LaunchpadFactory: the fee sent must equal the current fee exactly.
  // (No fee at all is how the pre-fix Chain behaved: it re-read the fee and
  // paid whatever it was.)
  async launch(signer, draft, fee, track) {
    this.calls.push({ fn: 'launch', from: signer.address, draft, fee });
    if ((fee ?? this.fee) !== this.fee) {
      throw new TxError('not_sent', 'fake WrongLaunchFee', { reason: { name: 'WrongLaunchFee', args: [fee, this.fee] }, label: 'launch' });
    }
    return this.#tx('launch', track, (hash) => {
      const n = ++this.launches;
      // Distinct from addLaunch()'s 0x77.../0x88... records.
      const ev = {
        index: n - 1,
        poolId: '0x' + 'f' + n.toString(16).padStart(63, '0'),
        token: addr('a7', n),
        vault: addr('a8', n),
        creator: signer.address,
      };
      return { txHash: hash, ...ev, launched: ev };
    });
  }

  // 1 USDC (1e6) buys 1000 tokens (1000e18).
  async quoteBuy(token, usdc6) { return usdc6 * 10n ** 15n; }
  async quoteSell(token, amount) { return amount / 10n ** 15n; }

  async buy(signer, token, usdc6, minOut, deadline, track) {
    this.calls.push({ fn: 'buy', from: signer.address, token, usdc6, minOut, deadline });
    return this.#tx('buy', track, (hash) => ({ txHash: hash, received: usdc6 * 10n ** 15n }));
  }

  async #approval(track) {
    if (this.needsApproval) await this.#tx('approve', track, (hash) => ({ txHash: hash }));
  }

  async sell(signer, token, amount, minOut, deadline, track) {
    this.calls.push({ fn: 'sell', from: signer.address, token, amount, minOut, deadline });
    await this.#approval(track);
    return this.#tx('sell', track, (hash) => ({ txHash: hash, received6: amount / 10n ** 15n }));
  }

  async claim(signer, track) {
    this.calls.push({ fn: 'claim', from: signer.address });
    return this.#tx('claim', track, (hash) => ({ txHash: hash, received6: this.owedByAddr.get(signer.address) ?? 0n }));
  }

  async redeem(signer, l, amount, minOut, track) {
    this.calls.push({ fn: 'redeem', from: signer.address, token: l.token, amount, minOut });
    await this.#approval(track);
    return this.#tx('redeem', track, (hash) => ({ txHash: hash, received6: 123n }));
  }

  async maxWithdrawable(signer) { return (this.balances.get(signer.address) ?? 0n) - 10n ** 15n; }

  async withdraw(signer, to, value, track) {
    this.calls.push({ fn: 'withdraw', from: signer.address, to, value });
    return this.#tx('withdraw', track, (hash) => ({ txHash: hash }));
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
    log: { error() {}, warn() {}, info() {}, log() {} },
    now: () => time.t,
  });
  await bot.init();
  return { bot, tg, chain, store, cfg, time, dir };
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
  return msg(uid, null, { photo: [{ file_id: `${fileId}-small`, file_unique_id: `${fileId}-u-small`, file_size: 100 }, { file_id: fileId, file_unique_id: `${fileId}-u`, file_size: 1000 }] });
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

// A launch record as the store holds it.
export function addLaunch(bot, overrides = {}) {
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

export const gate = () => {
  let open;
  const promise = new Promise((r) => { open = r; });
  return { promise, open };
};

export const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
