import { createHmac } from 'node:crypto';
import { Wallet } from 'ethers';

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// Each Telegram user's key is HMAC(master secret, their user id). Nothing
// per-user is stored, so a lost or corrupted store never loses anyone's
// funds, and the master secret is the only thing that needs backing up.
export function derivePrivateKey(secretHex, tgUserId) {
  const id = String(tgUserId);
  if (!/^\d+$/.test(id)) throw new Error('telegram user id must be numeric');
  const secret = Buffer.from(secretHex, 'hex');
  for (let counter = 0; counter < 16; counter++) {
    const digest = createHmac('sha256', secret).update(`sdoge-tgpad/wallet/v1/${id}/${counter}`).digest();
    const k = BigInt('0x' + digest.toString('hex'));
    if (k > 0n && k < SECP256K1_N) return '0x' + digest.toString('hex');
  }
  throw new Error('could not derive a valid key');
}

export class Wallets {
  #secret;
  #cache = new Map();

  constructor(secretHex, provider = null) {
    this.#secret = secretHex;
    this.provider = provider;
  }

  get(tgUserId) {
    const id = String(tgUserId);
    let w = this.#cache.get(id);
    if (!w) {
      w = new Wallet(derivePrivateKey(this.#secret, id), this.provider);
      this.#cache.set(id, w);
    }
    return w;
  }

  address(tgUserId) {
    return this.get(tgUserId).address;
  }

  // Keeps the cache to the `max` most recently created wallets (they're
  // re-derived on demand anyway).
  trim(max) {
    for (const id of this.#cache.keys()) {
      if (this.#cache.size <= max) break;
      this.#cache.delete(id);
    }
  }
}
