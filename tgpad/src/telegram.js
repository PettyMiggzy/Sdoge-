import { sleep } from './util.js';

export class TelegramError extends Error {
  constructor(method, body) {
    super(`Telegram ${method} failed: ${body?.error_code} ${body?.description ?? ''}`.trim());
    this.code = body?.error_code;
    this.description = String(body?.description ?? '');
    this.retryAfterMs = body?.parameters?.retry_after ? (body.parameters.retry_after + 1) * 1000 : null;
  }
}

// Thin Bot API client. The token is only ever put in the request URL, never
// in errors or logs.
export class Telegram {
  #token;

  constructor(token, { fetchImpl = fetch, apiBase = 'https://api.telegram.org' } = {}) {
    this.#token = token;
    this.fetch = fetchImpl;
    this.apiBase = apiBase;
  }

  async call(method, payload = {}, { timeoutMs = 20000, retries = 3, signal } = {}) {
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const res = await this.fetch(`${this.apiBase}/bot${this.#token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const body = await res.json();
      if (body.ok) return body.result;
      const err = new TelegramError(method, body);
      if (err.retryAfterMs && attempt < retries && !signal?.aborted) {
        await sleep(err.retryAfterMs);
        continue;
      }
      throw err;
    }
  }

  async callMultipart(method, fields, { timeoutMs = 60000 } = {}) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      if (v instanceof Blob) form.append(k, v, `${k}.jpg`);
      else form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    const res = await this.fetch(`${this.apiBase}/bot${this.#token}/${method}`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    if (!body.ok) throw new TelegramError(method, body);
    return body.result;
  }

  // `signal` lets shutdown abort the long poll instead of waiting it out.
  getUpdates(offset, timeoutSec = 25, { signal } = {}) {
    return this.call(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query', 'my_chat_member'] },
      { timeoutMs: (timeoutSec + 15) * 1000, retries: 1, signal },
    );
  }

  async downloadFile(fileId, maxBytes) {
    const file = await this.call('getFile', { file_id: fileId });
    if (file.file_size && file.file_size > maxBytes) throw new Error('file too large');
    const res = await this.fetch(`${this.apiBase}/file/bot${this.#token}/${file.file_path}`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('file too large');
    return buf;
  }
}

// Outgoing-message pacing: Telegram throttles (and eventually restricts)
// bots that exceed ~1 msg/s per private chat, ~20 msg/min per group or
// channel, or ~30 msg/s overall.
// - Sends to one chat stay in order, spaced by that chat's gap.
// - A chat waiting out its own gap never holds anyone else back: it only takes
//   one of the global slots (globalGapMs apart) once it is ready to send.
// - `guard` is checked right before the API call; returning false skips the
//   send (resolves null), e.g. for a post whose token was hidden meanwhile.
export class Sender {
  #chains = new Map();
  #lastByChat = new Map();
  #queued = new Map();
  #globalNext = 0;
  #sends = 0;

  constructor(tg, { privateGapMs = 1000, groupGapMs = 3100, globalGapMs = 40, now = () => Date.now(), wait = sleep } = {}) {
    this.tg = tg;
    this.privateGapMs = privateGapMs;
    this.groupGapMs = groupGapMs;
    this.globalGapMs = globalGapMs;
    this.now = now;
    this.wait = wait;
  }

  send(chatId, method, payload, { guard } = {}) {
    const key = String(chatId);
    this.#queued.set(key, (this.#queued.get(key) ?? 0) + 1);
    const prev = this.#chains.get(key) ?? Promise.resolve();
    const run = async () => {
      const gap = key.startsWith('-') ? this.groupGapMs : this.privateGapMs;
      const last = this.#lastByChat.get(key);
      if (last !== undefined) {
        const own = last + gap - this.now();
        if (own > 0) await this.wait(own);
      }
      const slot = Math.max(this.now(), this.#globalNext);
      this.#globalNext = slot + this.globalGapMs;
      const global = slot - this.now();
      if (global > 0) await this.wait(global);
      if (guard && !guard()) return null;
      try {
        return method === 'sendPhoto' && payload.photo instanceof Blob
          ? await this.tg.callMultipart(method, { chat_id: chatId, ...payload })
          : await this.tg.call(method, { chat_id: chatId, ...payload });
      } finally {
        this.#lastByChat.set(key, this.now());
      }
    };
    const next = prev.then(run, run);
    this.#chains.set(key, next.catch(() => {}).finally(() => {
      const left = (this.#queued.get(key) ?? 1) - 1;
      if (left > 0) this.#queued.set(key, left);
      else this.#queued.delete(key);
    }));
    if (++this.#sends % 500 === 0) this.#prune();
    return next;
  }

  // Idle chats whose gap is long over don't need to be remembered.
  #prune() {
    const t = this.now();
    for (const [key, at] of this.#lastByChat) {
      if (!this.#queued.has(key) && t - at > 60_000) {
        this.#lastByChat.delete(key);
        this.#chains.delete(key);
      }
    }
  }
}
