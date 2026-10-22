// ZAK Chain: minimal proof-of-work blockchain with signed transfers.
import crypto from 'crypto';
import fs from 'fs';

export const SUPPLY = 1_000_000_000;   // fixed total supply, all in genesis; miners earn fees, never new coins
const TARGET_MS = 10_000;              // aim for one block every 10 seconds
const RETARGET = 10;                   // adjust difficulty every 10 blocks
const START_BITS = 16;                 // leading zero bits required at launch
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

export function newWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    address: publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}
const txBody = t => JSON.stringify([t.from, t.to, t.amount, t.fee, t.nonce]);
export function signTx(wallet, to, amount, nonce, fee = 1) {
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
// Proof of work hashes only 40 bytes: the 32-byte header hash plus an 8-byte nonce. That keeps mining fast and
// lets GPU or native miners work without parsing JSON.
export const headerHash = b => sha(JSON.stringify([b.index, b.prev, b.time, b.bits, b.miner, b.txs]));
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

// Replays blocks, enforcing every rule. Returns state, or throws on the first invalid block.
export function replay(blocks) {
  const bal = {}, nonce = {};
  const g = blocks[0];
  if (g.index !== 0 || g.txs.length !== 1 || !g.txs[0].genesis || g.txs[0].amount !== SUPPLY || blockHash(g) !== g.hash) throw new Error('bad genesis');
  bal[g.txs[0].to] = SUPPLY;
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i], p = blocks[i - 1];
    if (b.index !== i || b.prev !== p.hash || blockHash(b) !== b.hash) throw new Error(`block ${i}: bad link or hash`);
    if (b.bits !== nextBits(blocks.slice(0, i)) || zeroBits(b.hash) < b.bits) throw new Error(`block ${i}: not enough work`);
    if (b.time <= p.time || b.time > Date.now() + 60_000) throw new Error(`block ${i}: bad timestamp`);
    let fees = 0;
    for (const t of b.txs) {
      if (t.genesis || !Number.isInteger(t.amount) || t.amount <= 0 || !Number.isInteger(t.fee) || t.fee < 0) throw new Error(`block ${i}: bad tx`);
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
  constructor(genesisAddress, time = 0) {
    const g = { index: 0, prev: '0'.repeat(64), time, bits: START_BITS, miner: null, txs: [{ genesis: true, to: genesisAddress, amount: SUPPLY }], nonce: 0 };
    g.hash = blockHash(g);
    this.blocks = [g]; this.pending = [];
  }
  state() { return replay(this.blocks); }
  submit(t) {
    if (!Number.isInteger(t.amount) || t.amount <= 0 || !Number.isInteger(t.fee) || t.fee < 0) throw new Error('bad amount or fee');
    if (!verifyTx(t)) throw new Error('bad signature');
    const { bal, nonce } = this.state();
    const mine = this.pending.filter(p => p.from === t.from);
    const spent = mine.reduce((s, p) => s + p.amount + p.fee, 0);
    if ((bal[t.from] || 0) - spent < t.amount + t.fee) throw new Error('insufficient balance');
    if (t.nonce !== (nonce[t.from] || 0) + mine.length + 1) throw new Error('bad nonce (replay?)');
    this.pending.push(t);
  }
  mine(minerAddress) {
    const prev = this.blocks.at(-1);
    const b = { index: prev.index + 1, prev: prev.hash, time: Math.max(Date.now(), prev.time + 1), bits: nextBits(this.blocks), miner: minerAddress, txs: this.pending, nonce: 0 };
    const hh = headerHash(b);
    while (zeroBits(b.hash = powHash(hh, b.nonce)) < b.bits) b.nonce++;
    this.blocks.push(b); this.pending = []; return b;
  }
  valid() { try { const { bal } = replay(this.blocks); return Object.values(bal).reduce((a, v) => a + v, 0) === SUPPLY; } catch { return false; } }
  // Fork choice: adopt a candidate only if it shares genesis, is fully valid, and has more total work.
  consider(blocks) {
    if (blocks[0]?.hash !== this.blocks[0].hash) return false;
    let cand; try { cand = replay(blocks); } catch { return false; }
    if (cand.work <= this.state().work) return false;
    const seen = new Set(blocks.flatMap(b => b.txs.map(t => t.sig)));
    this.blocks = blocks; this.pending = this.pending.filter(t => !seen.has(t.sig));
    return true;
  }
  save(f) { fs.writeFileSync(f, JSON.stringify(this.blocks, null, 2)); }
}
