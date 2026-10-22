import assert from 'assert/strict';
import { Chain, newWallet, signTx, SUPPLY } from './zakchain.mjs';
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
console.log('all tests passed');
