import assert from 'assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import { spawn } from 'child_process';
import { Chain, newWallet, signTx, SUPPLY, merkleRoot, txId, headerHash, powHash, selectTxs, isAddress, findNonce, MAX_BLOCK_TXS } from './zakchain.mjs';
import { mineGuard, MAX_BODY } from './node.mjs';
const zak = newWallet(), bob = newWallet(), miner = newWallet();
const c = new Chain(zak.address, 1);
const ok = (name, fn) => { fn(); console.log('ok -', name); };

ok('transfer with fee pays the miner and keeps supply fixed', () => {
  c.submit(signTx(zak, bob.address, 1000, 1, 5)); c.mine(miner.address);
  const { bal } = c.state();
  assert.equal(bal[bob.address], 1000); assert.equal(bal[miner.address], 5);
  assert.equal(bal[zak.address], SUPPLY - 1005); assert.ok(c.valid());
});
ok('rejects overspend, replay, forged signature', () => {
  assert.throws(() => c.submit(signTx(bob, zak.address, 999, 1, 5)), /insufficient/);
  assert.throws(() => c.submit(signTx(zak, bob.address, 1, 1)), /nonce/);
  const t = signTx(bob, zak.address, 1, 1); t.amount = 900; assert.throws(() => c.submit(t), /signature/);
});
ok('tampering with an old block invalidates the chain', () => {
  const copy = structuredClone(c.blocks); copy[1].txs[0].amount = 10 ** 9;
  const t = new Chain(zak.address, 1); assert.equal(t.consider(copy), false);
});
ok('difficulty rises when blocks come too fast', () => {
  const start = c.blocks.at(-1).bits;
  while (c.blocks.length < 32) c.mine(miner.address);
  assert.ok(c.blocks.at(-1).bits > start, `bits ${start} -> ${c.blocks.at(-1).bits}`);
  console.log('   difficulty', start, '->', c.blocks.at(-1).bits, 'bits');
});
ok('nodes switch to the chain with more total work, not just more blocks', () => {
  const a = new Chain(zak.address, 1), b = new Chain(zak.address, 1);
  for (let i = 0; i < 3; i++) a.mine(miner.address);
  b.mine(miner.address); b.mine(miner.address);
  assert.equal(b.consider(a.blocks), true); assert.equal(b.blocks.length, 4);
  assert.equal(a.consider(b.blocks.slice(0, 2)), false);
});
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
ok('header hash commits to the transaction merkle root and proof of work stays 40 bytes', () => {
  const a = new Chain(zak.address, 1);
  const recv = [newWallet(), newWallet(), newWallet()];
  recv.forEach((w, i) => a.submit(signTx(zak, w.address, 10 + i, i + 1, 1)));
  const b = a.mine(miner.address);
  assert.equal(b.txs.length, 3);
  const ids = b.txs.map(txId);
  const root = sha(sha(ids[0] + ids[1]) + sha(ids[2] + ids[2]));
  assert.equal(merkleRoot(b.txs), root);
  assert.equal(headerHash(b), sha(JSON.stringify([b.index, b.prev, b.time, b.bits, b.miner, root])));
  const buf = Buffer.alloc(40);
  buf.write(headerHash(b), 0, 'hex');
  buf.writeBigUInt64BE(BigInt(b.nonce), 32);
  assert.equal(buf.length, 40);
  assert.equal(buf.readBigUInt64BE(32), BigInt(b.nonce));
  assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), b.hash);
  assert.equal(powHash(headerHash(b), b.nonce), b.hash);
  const tampered = structuredClone(b);
  tampered.txs[1].amount += 1;
  assert.notEqual(merkleRoot(tampered.txs), root);
  assert.notEqual(headerHash(tampered), headerHash(b));
  assert.notEqual(merkleRoot([b.txs[1], b.txs[0], b.txs[2]]), root);
  assert.equal(merkleRoot([]), sha(JSON.stringify([])));
  assert.ok(a.valid());
});
ok('selectTxs prefers higher fees and will not skip a nonce', () => {
  const a = new Chain(zak.address, 1);
  const pay = [newWallet(), newWallet(), newWallet()];
  pay.forEach((w, i) => a.submit(signTx(zak, w.address, 200, i + 1, 1)));
  a.mine(miner.address);
  a.submit(signTx(pay[0], zak.address, 1, 1, 3));
  a.submit(signTx(pay[1], zak.address, 1, 1, 8));
  a.submit(signTx(pay[1], zak.address, 1, 2, 50));
  a.submit(signTx(pay[2], zak.address, 1, 1, 5));
  // Fee 50 sits on nonce 2, so a one-transaction block must take the fee-8 nonce in front of it.
  assert.deepEqual(selectTxs(a.pending, a.state(), 1).map(t => t.fee), [8]);
  // Once that nonce is packed, the fee-50 follow-up outranks the other senders.
  assert.deepEqual(selectTxs(a.pending, a.state(), 2).map(t => t.fee), [8, 50]);
  a.maxBlockTxs = 2;
  const b = a.mine(miner.address);
  assert.deepEqual(b.txs.map(t => t.fee), [8, 50]);
  assert.deepEqual(a.pending.map(t => t.fee).sort((x, y) => x - y), [3, 5]);
  assert.ok(a.valid());
});
ok('mempool cap evicts the cheapest tail and mining leaves the rest pending', () => {
  const a = new Chain(zak.address, 1);
  const pay = [newWallet(), newWallet(), newWallet()];
  pay.forEach((w, i) => a.submit(signTx(zak, w.address, 100, i + 1, 1)));
  a.mine(miner.address);
  a.maxMempool = 2;
  a.maxBlockTxs = 1;
  a.submit(signTx(pay[0], zak.address, 10, 1, 1));
  a.submit(signTx(pay[1], zak.address, 10, 1, 9));
  assert.throws(() => a.submit(signTx(pay[2], zak.address, 10, 1, 1)), /mempool full/);
  a.submit(signTx(pay[2], zak.address, 10, 1, 4));
  assert.deepEqual(a.pending.map(t => t.fee).sort((x, y) => x - y), [4, 9]);
  const b = a.mine(miner.address);
  assert.deepEqual(b.txs.map(t => t.fee), [9]);
  assert.deepEqual(a.pending.map(t => t.fee), [4]);
  assert.ok(a.valid());
});
ok('reorg revalidates the mempool and drops transactions that no longer apply', () => {
  const funded = new Chain(zak.address, 1);
  funded.submit(signTx(zak, bob.address, 100, 1, 1));
  funded.mine(miner.address);
  funded.submit(signTx(bob, miner.address, 40, 1, 2));
  const empty = new Chain(zak.address, 1);
  empty.mine(miner.address);
  empty.mine(miner.address);
  assert.equal(funded.pending.length, 1);
  assert.equal(funded.offer(empty.blocks), true);
  assert.deepEqual(funded.pending, []);
  const kept = new Chain(zak.address, 1);
  kept.submit(signTx(zak, bob.address, 30, 1, 1));
  assert.equal(kept.offer(empty.blocksFrom(1)), true);
  assert.equal(kept.pending.length, 1);
  assert.equal(kept.pending[0].amount, 30);
  assert.equal(kept.blocks.at(-1).hash, empty.blocks.at(-1).hash);
});
ok('offer appends a connected suffix and refuses a block that does not link', () => {
  const a = new Chain(zak.address, 1), b = new Chain(zak.address, 1);
  a.mine(miner.address); a.mine(miner.address);
  b.mine(miner.address);
  assert.deepEqual(a.blocksFrom(1).map(x => x.index), [1, 2]);
  assert.equal(a.blocksFrom(9).length, 0);
  assert.equal(b.offer(a.blocks.at(-1)), false);
  assert.equal(b.blocks.length, 2);
  assert.equal(b.offer(a.blocksFrom(1)), true);
  assert.equal(b.blocks.at(-1).hash, a.blocks.at(-1).hash);
  const fresh = new Chain(zak.address, 1);
  assert.equal(fresh.offer(a.blocks[1]), true);
  assert.equal(fresh.offer(a.blocks[2]), true);
  assert.equal(fresh.blocks.length, 3);
  const rival = new Chain(zak.address, 1);
  rival.mine(miner.address);
  assert.equal(a.offer(rival.blocksFrom(1)), false);
  assert.equal(a.blocks.length, 3);
});

const step = async (name, fn) => { await fn(); console.log('ok -', name); };
function startNode(port, peers, extra = {}) {
  fs.rmSync(`data/chain-${port}.json`, { force: true });
  fs.rmSync(`data/chain-${port}.json.tmp`, { force: true });
  const proc = spawn(process.execPath, ['node.mjs'], {
    env: { ...process.env, PORT: String(port), PEERS: peers, ALLOW_MINE: '', ZAK_TEST_MINE_DELAY_MS: '', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', d => { proc.err = (proc.err || '') + d; });
  return proc;
}
async function ready(port) {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/info`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('node did not listen on ' + port);
}
async function tipIs(port, tip) {
  let info;
  for (let i = 0; i < 40; i++) {
    info = await (await fetch(`http://127.0.0.1:${port}/info`)).json();
    if (info.tip === tip) return info;
    await new Promise(r => setTimeout(r, 50));
  }
  return info;
}
await step('nodes serve blocks from a height, gossip new blocks, and resolve a heavier fork', async () => {
  const procs = [
    startNode(7411, 'http://127.0.0.1:7412', { ALLOW_MINE: '1' }),
    startNode(7412, 'http://127.0.0.1:7411,http://127.0.0.1:7413', { ALLOW_MINE: '1' }),
    startNode(7413, 'http://127.0.0.1:7412', { ALLOW_MINE: '1' }),
  ];
  const lone = [];
  try {
    await Promise.all([7411, 7412, 7413].map(ready));
    const mined = await (await fetch(`http://127.0.0.1:7411/mine?miner=${miner.address}`, { method: 'POST' })).json();
    assert.equal(mined.index, 1);
    assert.equal(powHash(headerHash(mined), mined.nonce), mined.hash);
    const part = await (await fetch('http://127.0.0.1:7411/blocks?from=1')).json();
    assert.equal(part.length, 1);
    assert.equal(part[0].hash, mined.hash);
    for (const port of [7411, 7412, 7413]) {
      const info = await tipIs(port, mined.hash);
      assert.equal(info.tip, mined.hash, `port ${port} tip ${info.tip} err ${procs[port - 7411].err || ''}`);
      assert.equal(info.height, 1);
    }
    lone.push(startNode(7414, '', { ALLOW_MINE: '1' }), startNode(7415, '', { ALLOW_MINE: '1' }));
    await Promise.all([7414, 7415].map(ready));
    await fetch('http://127.0.0.1:7414/mine?miner=' + miner.address, { method: 'POST' });
    await fetch('http://127.0.0.1:7415/mine?miner=' + miner.address, { method: 'POST' });
    await fetch('http://127.0.0.1:7415/mine?miner=' + miner.address, { method: 'POST' });
    const heavyTip = await (await fetch('http://127.0.0.1:7415/blocks?from=2')).json();
    assert.equal(heavyTip.length, 1);
    const refused = await (await fetch('http://127.0.0.1:7414/block', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(heavyTip[0]),
    })).json();
    assert.equal(refused.adopted, false);
    assert.equal((await (await fetch('http://127.0.0.1:7414/info')).json()).height, 1);
    const full = await (await fetch('http://127.0.0.1:7415/chain')).json();
    const taken = await (await fetch('http://127.0.0.1:7414/block', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(full),
    })).json();
    assert.equal(taken.adopted, true);
    const left = await (await fetch('http://127.0.0.1:7414/info')).json();
    const right = await (await fetch('http://127.0.0.1:7415/info')).json();
    assert.equal(left.tip, right.tip);
    assert.equal(left.height, 2);
    assert.equal(left.valid, true);
  } finally {
    [...procs, ...lone].forEach(p => p.kill());
    for (const port of [7411, 7412, 7413, 7414, 7415]) {
      fs.rmSync(`data/chain-${port}.json`, { force: true });
      fs.rmSync(`data/chain-${port}.json.tmp`, { force: true });
    }
  }
});
function signRaw(wallet, to, amount, nonce, fee = 1) {
  const t = { from: wallet.address, to, amount, fee, nonce };
  t.sig = crypto.sign(null, Buffer.from(JSON.stringify([t.from, t.to, t.amount, t.fee, t.nonce])), crypto.createPrivateKey(wallet.privateKey)).toString('hex');
  return t;
}
ok('a __proto__ recipient is rejected and cannot break valid()', () => {
  assert.ok(isAddress(zak.address));
  assert.equal(zak.address.length, 88);
  assert.throws(() => signTx(zak, '__proto__', 1, 1), /address/);
  assert.throws(() => signTx(zak, 'abcd', 1, 1), /address/);
  const n = new Chain(zak.address, 1);
  const evil = signRaw(zak, '__proto__', 1, 1);
  assert.throws(() => n.submit(evil), /address/);
  n.pending.push(evil);
  const mined = n.mine(miner.address);
  assert.equal(mined.txs.length, 0);
  assert.equal(Object.getPrototypeOf(n.state().bal), null);
  assert.equal(n.state().bal['__proto__'], undefined);
  assert.ok(n.valid());
  assert.throws(() => n.mine('__proto__'), /miner address/);
  assert.ok(n.valid());
});
ok('a stale cache is dropped on reorg and a stale mined block does not stick', () => {
  const a = new Chain(zak.address, 1);
  a.submit(signTx(zak, bob.address, 100, 1, 1));
  a.mine(miner.address);
  a.submit(signTx(bob, miner.address, 40, 1, 1));
  const prep = a.prepareMine(miner.address);
  assert.equal(prep.block.txs.length, 1);
  const found = findNonce(prep.hh, prep.block.bits);
  prep.block.nonce = found.nonce;
  prep.block.hash = found.hash;
  a._cache = { tip: a.blocks.at(-1).hash, blocks: a.blocks, s: { bal: Object.assign(Object.create(null), { [zak.address]: 1 }), nonce: Object.create(null), work: 1e18 } };
  const heavy = new Chain(zak.address, 1);
  heavy.mine(miner.address); heavy.mine(miner.address); heavy.mine(miner.address);
  assert.equal(a.offer(heavy.blocks), true);
  assert.equal(a.pending.length, 0);
  assert.equal(a.state().bal[zak.address], SUPPLY);
  assert.equal(a.finishMine(prep.block, prep.tip), null);
  assert.equal(a.blocks.at(-1).hash, heavy.blocks.at(-1).hash);
  assert.equal(a.state().bal[bob.address] || 0, 0);
  assert.ok(a.valid());
  const height = a.blocks.length - 1, tip = a.blocks.at(-1).hash;
  const again = a.mine(miner.address);
  assert.equal(again.index, height + 1);
  assert.equal(again.prev, tip);
  assert.ok(a.valid());
});
ok('an oversized block and a bad proof of work are refused before they change the chain', () => {
  const n = new Chain(zak.address, 1);
  const fat = { index: 1, prev: n.blocks[0].hash, time: Date.now(), bits: 16, miner: miner.address, txs: Array.from({ length: MAX_BLOCK_TXS + 1 }, () => ({})), nonce: 0, hash: '00'.repeat(32) };
  assert.equal(n.offer(fat), false);
  const bogus = { index: 1, prev: n.blocks[0].hash, time: Date.now(), bits: 16, miner: miner.address, txs: [], nonce: 0, hash: '00'.repeat(32) };
  assert.equal(n.offer(bogus), false);
  assert.equal(n.blocks.length, 1);
  assert.ok(n.valid());
});
ok('mineGuard is off unless opted in from loopback', () => {
  assert.equal(mineGuard(undefined, '127.0.0.1').status, 403);
  assert.equal(mineGuard('1', '8.8.8.8').error, 'localhost only');
  assert.equal(mineGuard('1', '::ffff:8.8.8.8').status, 403);
  assert.equal(mineGuard('1', '127.0.0.1'), null);
  assert.equal(mineGuard('1', '::1'), null);
  assert.equal(mineGuard('1', '::ffff:127.0.0.1'), null);
});

await step('POST /mine is off by default, CORS is GET-only, and a large body is refused', async () => {
  const procs = [
    startNode(7421, ''),
    startNode(7422, '', { ALLOW_MINE: '1', ZAK_TEST_MINE_DELAY_MS: '800' }),
  ];
  try {
    await Promise.all([7421, 7422].map(ready));
    const info = await fetch('http://127.0.0.1:7421/info');
    assert.equal(info.headers.get('access-control-allow-origin'), '*');
    const denied = await fetch(`http://127.0.0.1:7421/mine?miner=${miner.address}`, { method: 'POST' });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    assert.equal((await denied.json()).error, 'mining disabled');
    assert.equal((await (await fetch('http://127.0.0.1:7421/info')).json()).height, 0);
    const opt = await fetch('http://127.0.0.1:7421/mine', { method: 'OPTIONS' });
    assert.equal(opt.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
    const tooBig = await fetch('http://127.0.0.1:7421/block', { method: 'POST', body: 'x'.repeat(MAX_BODY + 1), headers: { 'content-type': 'application/json' } });
    assert.equal(tooBig.status, 413);
    const mineP = fetch(`http://127.0.0.1:7422/mine?miner=${miner.address}`, { method: 'POST' });
    await new Promise(r => setTimeout(r, 200));
    const t0 = Date.now();
    const during = await fetch('http://127.0.0.1:7422/info', { signal: AbortSignal.timeout(300) });
    assert.ok(during.ok);
    assert.ok(Date.now() - t0 < 300, 'info blocked while mining');
    const won = await (await mineP).json();
    assert.equal(won.index, 1);
    assert.equal(powHash(headerHash(won), won.nonce), won.hash);
    assert.equal((await (await fetch('http://127.0.0.1:7422/info')).json()).valid, true);
  } finally {
    procs.forEach(p => p.kill());
    for (const port of [7421, 7422]) {
      fs.rmSync(`data/chain-${port}.json`, { force: true });
      fs.rmSync(`data/chain-${port}.json.tmp`, { force: true });
    }
  }
});
console.log('all tests passed');
