import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tgpad-store-')), 'store.json');

// ---------------------------------------------------------------- R2-TGPAD-20

test('R2-TGPAD-20: only one process can own the store; a second is refused while the first runs', async () => {
  const file = tmpFile();
  const first = await Store.open(file);
  await first.lock();
  // A second process (e.g. `npm start` while pm2 runs the bot).
  const script = `import { Store } from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)};
    const s = await Store.open(${JSON.stringify(file)});
    try { await s.lock(); console.log('LOCKED'); } catch (e) { console.log('REFUSED ' + e.message); }`;
  const second = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.match(second.stdout, /REFUSED Another tgpad process \(pid \d+\)/);
  await first.unlock();
  assert.equal(fs.existsSync(`${file}.lock`), false);
  const third = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.match(third.stdout, /LOCKED/, 'free again once the first one stopped');
});

test('R2-TGPAD-20: a lock left by a process that died is taken over', async () => {
  const file = tmpFile();
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  fs.writeFileSync(`${file}.lock`, `${dead}\n`);
  const s = await Store.open(file);
  await s.lock();
  assert.equal(fs.readFileSync(`${file}.lock`, 'utf8').trim(), String(process.pid));
  await s.unlock();
});

test('R2-TGPAD-20: saves never interleave into a corrupt file', async () => {
  const file = tmpFile();
  const a = await Store.open(file);
  const b = await Store.open(file);
  a.data.blob = 'a'.repeat(3_000_000);
  b.data.blob = 'b'.repeat(1_000_000);
  for (let i = 0; i < 20; i++) {
    const r = await Promise.allSettled([a.save(), b.save()]);
    assert.deepEqual(r.map((x) => x.status), ['fulfilled', 'fulfilled']);
    const blob = JSON.parse(fs.readFileSync(file, 'utf8')).blob;
    assert.ok(blob === a.data.blob || blob === b.data.blob);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), [], 'no temp files left behind');
});

// ---------------------------------------------------------------- R2-TGPAD-19

test('R2-TGPAD-19: a username belongs to whoever uses it now', async () => {
  const s = await Store.open(tmpFile());
  s.claimUsername('5000', 'moondev', 1);
  s.claimUsername('7000000', 'MoonDev', 2);
  assert.equal(s.user('5000').username, null);
  assert.equal(s.user('7000000').username, 'MoonDev');
  s.claimUsername('7000000', null, 3);
  assert.equal(s.user('7000000').username, null, 'dropping a username clears it');
});

test('pool ids are looked up through an index, including launches added later', async () => {
  const s = await Store.open(tmpFile());
  s.putLaunch({ token: '0xAa00000000000000000000000000000000000001', poolId: '0xABC', key: 'k1' });
  assert.equal(s.launchByPoolId('0xabc').key, 'k1');
  s.putLaunch({ token: '0xAa00000000000000000000000000000000000002', poolId: '0xDEF', key: 'k2' });
  assert.equal(s.launchByPoolId('0xdef').key, 'k2');
  s.data.launches['0xaa00000000000000000000000000000000000003'] = { token: '0xaa00000000000000000000000000000000000003', poolId: '0x123', key: 'k3' };
  assert.equal(s.launchByPoolId('0x123').key, 'k3', 'records added behind its back are still found');
  assert.equal(s.launchByPoolId('0x999'), null);
});
