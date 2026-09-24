import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { Wallets, derivePrivateKey } from '../src/wallets.js';

const SECRET = 'ab'.repeat(32);

test('derivation is pinned: changing it would silently move every user to a new wallet', () => {
  // Cross-checked against Python: hmac.new(bytes.fromhex('ab'*32), b'sdoge-tgpad/wallet/v1/12345/0', sha256)
  assert.equal(derivePrivateKey(SECRET, '12345'), '0xb1f031307939c882655e0de534f5b5a3d60bddb2638977efa51d292714e16cc3');
  const w = new Wallets(SECRET);
  assert.equal(w.address('12345'), '0x691616BA933743AC9F9521A2F415119b45Da291A');
  assert.equal(w.address('999'), '0xd4204aDc218C6b607AED10e232A65F4857f78250');
});

test('same user always gets the same wallet; different users and secrets differ', () => {
  const a = new Wallets(SECRET);
  const b = new Wallets(SECRET);
  assert.equal(a.address('42'), b.address('42'));
  assert.notEqual(a.address('42'), a.address('43'));
  assert.notEqual(a.address('42'), new Wallets('cd'.repeat(32)).address('42'));
});

test('derived key is a real signing key for the reported address', () => {
  const pk = derivePrivateKey(SECRET, '777');
  assert.equal(new Wallet(pk).address, new Wallets(SECRET).address('777'));
});

test('rejects non-numeric telegram ids', () => {
  assert.throws(() => derivePrivateKey(SECRET, 'abc'), /numeric/);
  assert.throws(() => derivePrivateKey(SECRET, '12 34'), /numeric/);
});
