// ZAK Chain: minimal proof-of-work blockchain with signed transfers.
import crypto from 'crypto';
import fs from 'fs';

export const SUPPLY = 1_000_000_000;   // fixed total supply, all in genesis; miners earn fees, never new coins
const TARGET_MS = 10_000;              // aim for one block every 10 seconds
const RETARGET = 10;                   // adjust difficulty every 10 blocks
const START_BITS = 16;                 // leading zero bits required at launch
export const MAX_MEMPOOL = 1024;       // pending transactions a node will keep
export const MAX_BLOCK_TXS = 100;      // highest-fee transactions packed into one block
// Ed25519 SPKI DER: 12-byte header 302a300506032b6570032100 plus the 32-byte key.
const ADDRESS_RE = /^302a300506032b6570032100[0-9a-f]{64}$/;
export function isAddress(a) { return typeof a === 'string' && ADDRESS_RE.test(a); }
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const dict = () => Object.create(null);
function cloneDict(src) { const out = dict(); if (src) for (const k of Object.keys(src)) out[k] = src[k]; return out; }

export function newWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    address: publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}
const txBody = t => JSON.stringify([t.from, t.to, t.amount, t.fee, t.nonce]);
export function signTx(wallet, to, amount, nonce, fee = 1) {
  if (!isAddress(to) || !isAddress(wallet?.address)) throw new Error('bad address');
  const t = { from: wallet.address, to, amount, fee, nonce };
  t.sig = crypto.sign(null, Buffer.from(txBody(t)), crypto.createPrivateKey(wallet.privateKey)).toString('hex');
  return t;
}
function verifyTx(t) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(t.from, 'hex'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(txBody(t)), key, Buffer.from(t.sig, 'hex'));
  } catch { return false; }
}
function txOk(t) {
  return !!t && !t.genesis && isAddress(t.from) && isAddress(t.to) && Number.isInteger(t.amount) && t.amount > 0 && Number.isInteger(t.fee) && t.fee >= 0 && typeof t.sig === 'string' && verifyTx(t);
}

// Canonical id. Genesis outputs have no signature; transfers commit to every signed field.
export function txId(t) {
  return sha(t?.genesis
    ? JSON.stringify(['genesis', t.to, t.amount])
    : JSON.stringify([t.from, t.to, t.amount, t.fee, t.nonce, t.sig]));
}

// Merkle root over transaction ids. An odd node is paired with a copy of itself, so every
// block, including one with a single transfer, has a defined root.
export function merkleRoot(txs) {
  if (!txs?.length) return sha(JSON.stringify([]));
  let level = txs.map(txId);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha(level[i] + (level[i + 1] ?? level[i])));
    level = next;
  }
  return level[0];
}

// Proof of work hashes only 40 bytes: the 32-byte header hash plus an 8-byte big-endian nonce.
// The header hash commits to the transaction Merkle root rather than the raw transactions, which
// keeps the native miner's input exactly those 40 bytes.
export const headerHash = b => sha(JSON.stringify([b.index, b.prev, b.time, b.bits, b.miner, merkleRoot(b.txs)]));
export const powHash = (hh, nonce) => { const buf = Buffer.alloc(40); buf.write(hh, 0, 'hex'); buf.writeBigUInt64BE(BigInt(nonce), 32); return crypto.createHash('sha256').update(buf).digest('hex'); };
const blockHash = b => powHash(headerHash(b), b.nonce);
export const zeroBits = h => { let n = 0; for (const c of h) { const v = parseInt(c, 16); if (v === 0) { n += 4; continue; } return n + Math.clz32(v) - 28; } return n; };
const work = b => 2 ** b.bits;

// Difficulty for the block after `blocks`: retarget every RETARGET blocks by log2(target time / actual time),
// clamped to ±4 bits (16x) per step so a sudden flood of hash power is absorbed within a few retargets.
export function nextBits(blocks) {
  const tip = blocks.at(-1);
  if (tip.index < 2 * RETARGET || tip.index % RETARGET !== 0) return tip.bits ?? START_BITS;
  const took = tip.time - blocks.at(-1 - RETARGET).time, want = TARGET_MS * RETARGET;
  const step = Math.max(-4, Math.min(4, Math.round(Math.log2(want / Math.max(took, 1)))));
  return Math.max(8, tip.bits + step);
}

// Pack up to `limit` transactions. Of the spends whose nonce is next, the highest fee goes in first.
// A later nonce is never chosen ahead of the one it depends on.
export function selectTxs(pending, state, limit = MAX_BLOCK_TXS) {
  const groups = new Map();
  for (const t of pending) {
    if (!t?.from) continue;
    let list = groups.get(t.from);
    if (!list) groups.set(t.from, list = []);
    list.push(t);
  }
  const heads = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.nonce - b.nonce);
    heads.push({ list, i: 0, alive: true });
  }
  const bal = cloneDict(state.bal), nonce = cloneDict(state.nonce), selected = [];
  while (selected.length < limit) {
    let best = null;
    for (const h of heads) {
      if (!h.alive) continue;
      const t = h.list[h.i];
      if (!txOk(t) || t.nonce !== (nonce[t.from] || 0) + 1 || (bal[t.from] || 0) < t.amount + t.fee) { h.alive = false; continue; }
      if (!best || t.fee > best.t.fee) best = { h, t };
    }
    if (!best) break;
    bal[best.t.from] -= best.t.amount + best.t.fee;
    nonce[best.t.from] = best.t.nonce;
    selected.push(best.t);
    best.h.i++;
    if (best.h.i >= best.h.list.length) best.h.alive = false;
  }
  return selected;
}

// Replays blocks, enforcing every rule. Returns state, or throws on the first invalid block.
// Header and proof-of-work checks only. Signature and balance checks stay in replay, so a
// forged hash or an oversized block is rejected before that more expensive walk.
export function headersOk(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) return false;
  const g = blocks[0];
  if (!g || g.index !== 0 || !Array.isArray(g.txs) || g.txs.length !== 1 || !isAddress(g.txs[0]?.to) || blockHash(g) !== g.hash) return false;
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i], p = blocks[i - 1];
    if (!b || b.index !== i || b.prev !== p.hash) return false;
    if (!Array.isArray(b.txs) || b.txs.length > MAX_BLOCK_TXS) return false;
    if (b.bits !== nextBits(blocks.slice(0, i))) return false;
    if (typeof b.time !== 'number' || b.time <= p.time || b.time > Date.now() + 60_000) return false;
    if (!isAddress(b.miner)) return false;
    let hash;
    try { hash = powHash(headerHash(b), b.nonce); } catch { return false; }
    if (hash !== b.hash || zeroBits(b.hash) < b.bits) return false;
  }
  return true;
}

// Search the 40-byte proof-of-work input. ZAK_TEST_MINE_DELAY_MS blocks the caller first,
// which is how tests show this work is not running on the node event loop.
export function findNonce(hh, bits) {
  const wait = +process.env.ZAK_TEST_MINE_DELAY_MS || 0;
  if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  let nonce = 0;
  for (;;) {
    const hash = powHash(hh, nonce);
    if (zeroBits(hash) >= bits) return { nonce, hash };
    if (!Number.isSafeInteger(++nonce)) throw new Error('nonce space exhausted');
  }
}

export function replay(blocks) {
  const bal = dict(), nonce = dict();
  const g = blocks[0];
  if (g.index !== 0 || g.txs.length !== 1 || !g.txs[0].genesis || g.txs[0].amount !== SUPPLY || !isAddress(g.txs[0].to) || blockHash(g) !== g.hash) throw new Error('bad genesis');
  bal[g.txs[0].to] = SUPPLY;
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i], p = blocks[i - 1];
    if (b.index !== i || b.prev !== p.hash || blockHash(b) !== b.hash) throw new Error(`block ${i}: bad link or hash`);
    if (!Array.isArray(b.txs) || b.txs.length > MAX_BLOCK_TXS) throw new Error(`block ${i}: too many txs`);
    if (b.bits !== nextBits(blocks.slice(0, i)) || zeroBits(b.hash) < b.bits) throw new Error(`block ${i}: not enough work`);
    if (b.time <= p.time || b.time > Date.now() + 60_000) throw new Error(`block ${i}: bad timestamp`);
    if (!isAddress(b.miner)) throw new Error(`block ${i}: bad miner`);
    let fees = 0;
    for (const t of b.txs) {
      if (t.genesis || !Number.isInteger(t.amount) || t.amount <= 0 || !Number.isInteger(t.fee) || t.fee < 0) throw new Error(`block ${i}: bad tx`);
      if (!isAddress(t.from) || !isAddress(t.to)) throw new Error(`block ${i}: bad address`);
      if (!verifyTx(t)) throw new Error(`block ${i}: bad signature`);
      if (t.nonce !== (nonce[t.from] || 0) + 1) throw new Error(`block ${i}: bad nonce`);
      if ((bal[t.from] || 0) < t.amount + t.fee) throw new Error(`block ${i}: overspend`);
      bal[t.from] -= t.amount + t.fee; bal[t.to] = (bal[t.to] || 0) + t.amount; nonce[t.from] = t.nonce; fees += t.fee;
    }
    if (fees) bal[b.miner] = (bal[b.miner] || 0) + fees;
  }
  return { bal, nonce, work: blocks.reduce((s, b) => s + (b.bits ? work(b) : 0), 0) };
}

export class Chain {
  constructor(genesisAddress, time = 0, { maxMempool = MAX_MEMPOOL, maxBlockTxs = MAX_BLOCK_TXS } = {}) {
    const g = { index: 0, prev: '0'.repeat(64), time, bits: START_BITS, miner: null, txs: [{ genesis: true, to: genesisAddress, amount: SUPPLY }], nonce: 0 };
    g.hash = blockHash(g);
    this.blocks = [g]; this.pending = [];
    this.maxMempool = maxMempool; this.maxBlockTxs = Math.min(maxBlockTxs, MAX_BLOCK_TXS);
  }
  invalidate() { this._cache = null; }
  // Replaying the whole chain is O(n), so cache the result per tip. The cache is dropped on every
  // chain switch, and it is also ignored if it was built for a different block array.
  state() {
    const tip = this.blocks.at(-1).hash;
    if (!this._cache || this._cache.tip !== tip || this._cache.blocks !== this.blocks) this._cache = { tip, blocks: this.blocks, s: replay(this.blocks) };
    return this._cache.s;
  }
  // Blocks whose index is >= height, inclusive. Empty when height is past the tip.
  blocksFrom(height = 0) {
    const h = Number(height);
    if (!Number.isInteger(h) || h < 0) return [];
    return this.blocks.slice(h);
  }
  // True when `incoming` is a full chain with our genesis, or a suffix whose parent we already have.
  links(incoming) {
    const blocks = Array.isArray(incoming) ? incoming : [incoming];
    if (!blocks[0] || typeof blocks[0].hash !== 'string') return false;
    if (blocks[0].index === 0) return blocks[0].hash === this.blocks[0].hash;
    return this.blocks.some(b => b.hash === blocks[0].prev);
  }
  // Drop the cheapest tail (the highest nonce of its sender) until the pool fits.
  // Only tails are removed, so a sender is never left with a hole in their nonces.
  trimPending(list = this.pending) {
    const out = [...list];
    while (out.length > this.maxMempool) {
      const tail = new Map();
      out.forEach((t, i) => {
        const prev = tail.get(t.from);
        if (prev === undefined || t.nonce > out[prev].nonce) tail.set(t.from, i);
      });
      let worst = null;
      for (const i of tail.values()) {
        // Equal fees keep the earlier transaction. The newcomer is the one that has to wait.
        if (worst === null || out[i].fee < out[worst].fee || (out[i].fee === out[worst].fee && i > worst)) worst = i;
      }
      out.splice(worst, 1);
    }
    return out;
  }
  // Keep pending transactions that still pay, sign, and follow the sender's next nonce.
  revalidatePending() {
    const { bal, nonce } = this.state();
    const spent = dict(), seq = dict(), kept = [], seen = new Set();
    const ordered = [...this.pending].sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : a.nonce - b.nonce);
    for (const t of ordered) {
      if (!t?.sig || seen.has(t.sig) || !txOk(t)) continue;
      if (t.nonce !== (nonce[t.from] || 0) + (seq[t.from] || 0) + 1) continue;
      if ((bal[t.from] || 0) - (spent[t.from] || 0) < t.amount + t.fee) continue;
      spent[t.from] = (spent[t.from] || 0) + t.amount + t.fee;
      seq[t.from] = (seq[t.from] || 0) + 1;
      seen.add(t.sig);
      kept.push(t);
    }
    this.pending = this.trimPending(kept);
  }
  submit(t) {
    if (!isAddress(t?.from) || !isAddress(t?.to)) throw new Error('bad address');
    if (!Number.isInteger(t.amount) || t.amount <= 0 || !Number.isInteger(t.fee) || t.fee < 0) throw new Error('bad amount or fee');
    if (!verifyTx(t)) throw new Error('bad signature');
    if (this.pending.some(p => p.sig === t.sig)) throw new Error('duplicate');
    const { bal, nonce } = this.state();
    const mine = this.pending.filter(p => p.from === t.from);
    const spent = mine.reduce((s, p) => s + p.amount + p.fee, 0);
    if ((bal[t.from] || 0) - spent < t.amount + t.fee) throw new Error('insufficient balance');
    if (t.nonce !== (nonce[t.from] || 0) + mine.length + 1) throw new Error('bad nonce (replay?)');
    this.pending.push(t);
    if (this.pending.length > this.maxMempool) {
      const trimmed = this.trimPending();
      if (!trimmed.some(p => p.sig === t.sig)) { this.pending.pop(); throw new Error('mempool full'); }
      this.pending = trimmed;
    }
  }
  prepareMine(minerAddress) {
    this.revalidatePending();
    if (!isAddress(minerAddress)) throw new Error('bad miner address');
    const prev = this.blocks.at(-1);
    const txs = selectTxs(this.pending, this.state(), Math.min(this.maxBlockTxs, MAX_BLOCK_TXS));
    const block = { index: prev.index + 1, prev: prev.hash, time: Math.max(Date.now(), prev.time + 1), bits: nextBits(this.blocks), miner: minerAddress, txs, nonce: 0 };
    return { block, hh: headerHash(block), tip: prev.hash };
  }
  // Commit a block that was mined against `tip`. A reorg that moved the tip drops the block,
  // clears the state cache, and rechecks the mempool so a stale template cannot wedge the node.
  finishMine(b, tip) {
    this.invalidate();
    try { this.revalidatePending(); } catch { this.invalidate(); }
    if (this.blocks.at(-1).hash !== tip) return null;
    if (!b || b.prev !== tip || !Array.isArray(b.txs) || b.txs.length > MAX_BLOCK_TXS || !isAddress(b.miner)) return null;
    let hash;
    try { hash = powHash(headerHash(b), b.nonce); } catch { return null; }
    if (hash !== b.hash || zeroBits(b.hash) < b.bits || b.bits !== nextBits(this.blocks)) return null;
    this.blocks.push(b);
    this.invalidate();
    try { this.state(); }
    catch {
      this.blocks.pop();
      this.invalidate();
      try { this.revalidatePending(); } catch { this.invalidate(); }
      return null;
    }
    const used = new Set(b.txs.map(t => t.sig).filter(Boolean));
    this.pending = this.pending.filter(t => !used.has(t.sig));
    this.revalidatePending();
    return b;
  }
  mine(minerAddress) {
    const prep = this.prepareMine(minerAddress);
    const found = findNonce(prep.hh, prep.block.bits);
    prep.block.nonce = found.nonce;
    prep.block.hash = found.hash;
    const sealed = this.finishMine(prep.block, prep.tip);
    if (!sealed) throw new Error('stale chain');
    return sealed;
  }
  valid() { try { const { bal } = this.state(); return Object.values(bal).reduce((a, v) => a + v, 0) === SUPPLY; } catch { return false; } }
  // Fork choice: adopt a candidate only if it shares genesis, is fully valid, and has more total work.
  consider(blocks) {
    if (!blocks?.length || blocks[0]?.hash !== this.blocks[0].hash) return false;
    if (!headersOk(blocks)) return false;
    let cand; try { cand = replay(blocks); } catch { return false; }
    // Drop a cache left over from the previous tip before comparing work. A stale cache
    // must not veto a heavier chain, and it must not be reused after the switch.
    this.invalidate();
    let current = -1;
    try { current = this.state().work; } catch { this.invalidate(); }
    if (cand.work <= current) return false;
    this.blocks = blocks;
    this.invalidate();
    this._cache = { tip: blocks.at(-1).hash, blocks: this.blocks, s: cand };
    this.revalidatePending();
    return true;
  }
  // Accept one block, a suffix that links to a block we have, or a full chain.
  // False means the blocks do not connect or lose on total work; the caller then downloads the full chain.
  offer(incoming) {
    const blocks = Array.isArray(incoming) ? incoming : [incoming];
    if (!blocks.length || blocks.some(b => !b || typeof b.hash !== 'string')) return false;
    if (blocks[0].index === 0) return this.consider(blocks);
    const parent = this.blocks.findIndex(b => b.hash === blocks[0].prev);
    if (parent < 0) return false;
    return this.consider(this.blocks.slice(0, parent + 1).concat(blocks));
  }
  save(f) { fs.writeFileSync(f, JSON.stringify(this.blocks, null, 2)); }
}
