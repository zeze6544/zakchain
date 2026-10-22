// ZAK miner: node miner.mjs <yourAddress> [nodeUrl] [threads]
// Mines on every CPU core in parallel, shows live hashrate, earns the fees in each block it wins.
import os from 'os';
import crypto from 'crypto';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { Chain, nextBits } from './zakchain.mjs';

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const zeroBits = h => { let n = 0; for (const c of h) { const v = parseInt(c, 16); if (v === 0) { n += 4; continue; } return n + Math.clz32(v) - 28; } return n; };
const headerOf = b => JSON.stringify([b.index, b.prev, b.time, b.bits, b.miner, b.txs, 0]).slice(0, -2); // everything but the nonce

if (!isMainThread) {
  // Worker: try nonces start, start+step, start+2*step ... and report progress.
  let job = null, hashes = 0;
  parentPort.on('message', m => { job = m; });
  const loop = () => {
    if (job) {
      const { prefix, bits, step, id } = job;
      for (let i = 0; i < 20000; i++) {
        const nonce = job.next; job.next += step; hashes++;
        const h = sha(prefix + nonce + ']');
        if (zeroBits(h) >= bits) { parentPort.postMessage({ found: { id, nonce, hash: h } }); job = null; break; }
      }
    }
    if (hashes) parentPort.postMessage({ hashes }); hashes = 0;
    job ? setImmediate(loop) : setTimeout(loop, 20);
  };
  loop();
} else {
  const [address, node = 'http://localhost:7001', t = os.cpus().length] = process.argv.slice(2);
  if (!address) { console.error('usage: node miner.mjs <yourAddress> [nodeUrl] [threads]'); process.exit(1); }
  process.stdout.on('error', () => process.exit(0));
  const threads = +t, workers = Array.from({ length: threads }, () => new Worker(new URL(import.meta.url)));
  const get = async p => (await fetch(node + p)).json();
  let total = 0, found = 0, job = 0, current = null, tipSeen = null;
  const start = Date.now();

  async function newJob() {
    const blocks = await get('/chain'), pending = await get('/pending');
    const prev = blocks.at(-1);
    const b = { index: prev.index + 1, prev: prev.hash, time: Math.max(Date.now(), prev.time + 1), bits: nextBits(blocks), miner: address, txs: pending, nonce: 0 };
    current = { id: ++job, blocks, b }; tipSeen = prev.hash;
    const prefix = headerOf(b);
    workers.forEach((w, i) => w.postMessage({ id: job, prefix, bits: b.bits, next: i, step: threads }));
  }
  for (const w of workers) w.on('message', async m => {
    if (m.hashes) total += m.hashes;
    if (m.found && current && m.found.id === current.id) {
      const { blocks, b } = current; current = null;
      b.nonce = m.found.nonce; b.hash = m.found.hash;
      const c = Object.assign(Object.create(Chain.prototype), { blocks: [...blocks, b], pending: [] });
      const r = await (await fetch(node + '/block', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c.blocks) })).json().catch(() => ({}));
      if (r.adopted) found++;
      console.log(`block ${b.index} ${r.adopted ? 'WON' : 'lost race'}, ${b.txs.length} tx, fees ${b.txs.reduce((s, t) => s + t.fee, 0)} ZAK, won ${found}`);
      newJob().catch(() => {});
    }
  });
  // If someone else extends the chain, drop the stale job and restart on the new tip.
  setInterval(async () => { try { const i = await get('/info'); if (i.tip !== tipSeen) newJob(); } catch {} }, 1000);
  setInterval(() => { const s = (Date.now() - start) / 1000; console.log(`${threads} threads, ${(total / s / 1000).toFixed(0)} kH/s, won ${found} blocks`); }, 5000);
  await newJob();
}
