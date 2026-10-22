// ZAK miner: node miner.mjs <yourAddress> [nodeUrl] [threads]
// DISCLAIMER: ZAK has no cash value. Mining it earns no money and carries no promise of returns.
// Uses the native SHA-NI miner in native/zakminer when it is built (see README), otherwise falls back to
// pure JavaScript worker threads. Earns the fees in every block it wins.
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { Worker, isMainThread, parentPort } from 'worker_threads';
import { Chain, nextBits, headerHash, powHash, zeroBits } from './zakchain.mjs';

if (!isMainThread) {
  // JS fallback worker: tries nonces next, next+step, ... using the same 40-byte proof-of-work input.
  let job = null, hashes = 0;
  const buf = Buffer.alloc(40);
  parentPort.on('message', m => { job = m; if (m) buf.write(m.hh, 0, 'hex'); });
  const loop = () => {
    if (job) {
      for (let i = 0; i < 20000; i++) {
        const n = job.next; job.next += job.step; hashes++;
        buf.writeBigUInt64BE(BigInt(n), 32);
        const h = crypto.hash('sha256', buf, 'hex');
        if (zeroBits(h) >= job.bits) { parentPort.postMessage({ found: { id: job.id, nonce: n, hash: h } }); job = null; break; }
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
  const threads = +t;
  const nativeBin = new URL('./native/zakminer', import.meta.url).pathname;
  const native = fs.existsSync(nativeBin) && !process.env.ZAK_JS;
  const get = async p => (await fetch(node + p)).json();
  let total = 0, found = 0, jobId = 0, current = null, tipSeen = null, proc = null, workers = [];
  const start = Date.now();

  async function onFound(id, nonce, hash) {
    if (!current || current.id !== id) return;
    const { blocks, b } = current; current = null;
    b.nonce = Number(nonce); b.hash = hash;
    if (powHash(headerHash(b), b.nonce) !== hash) { console.log('miner bug: hash mismatch, skipping'); return newJob(); }
    const r = await (await fetch(node + '/block', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([...blocks, b]) })).json().catch(() => ({}));
    if (r.adopted) found++;
    console.log(`block ${b.index} ${r.adopted ? 'WON' : 'lost race'} at ${b.bits} bits, ${b.txs.length} tx, fees ${b.txs.reduce((s, t) => s + t.fee, 0)} ZAK, won ${found}`);
    newJob().catch(() => {});
  }

  async function newJob() {
    const blocks = await get('/chain'), pending = await get('/pending');
    const prev = blocks.at(-1);
    const b = { index: prev.index + 1, prev: prev.hash, time: Math.max(Date.now(), prev.time + 1), bits: nextBits(blocks), miner: address, txs: pending, nonce: 0 };
    const id = ++jobId, hh = headerHash(b);
    current = { id, blocks, b }; tipSeen = prev.hash;
    if (native) {
      if (proc) proc.kill();
      proc = spawn(nativeBin, [hh, String(b.bits), String(threads), String(crypto.randomInt(2 ** 40))]);
      let out = '';
      proc.stdout.on('data', d => {
        out += d; let i;
        while ((i = out.indexOf('\n')) >= 0) {
          const [kind, a, h] = out.slice(0, i).split(' '); out = out.slice(i + 1);
          if (kind === 'RATE') total += +a;
          if (kind === 'FOUND') onFound(id, a, h);
        }
      });
    } else {
      workers.forEach((w, i) => w.postMessage({ id, hh, bits: b.bits, next: i, step: threads }));
    }
  }

  if (!native) {
    workers = Array.from({ length: threads }, () => new Worker(new URL(import.meta.url)));
    for (const w of workers) w.on('message', m => { if (m.hashes) total += m.hashes; if (m.found) onFound(m.found.id, m.found.nonce, m.found.hash); });
  }
  console.log('NOTE: ZAK has no cash value. Mining earns no money and carries no promise of returns. This is an open-source hobby project.');
  console.log(`ZAK miner: ${threads} threads, ${native ? 'native SHA-NI engine' : 'JavaScript engine (build native/zakminer for ~50x more speed)'}`);
  process.on('exit', () => proc && proc.kill());
  process.on('SIGINT', () => process.exit(0)); process.on('SIGTERM', () => process.exit(0));
  // If someone else extends the chain, drop the stale job and restart on the new tip.
  setInterval(async () => { try { const i = await get('/info'); if (i.tip !== tipSeen) newJob(); } catch {} }, 1000);
  setInterval(() => { const s = (Date.now() - start) / 1000; console.log(`${(total / s / 1e6).toFixed(1)} MH/s, won ${found} blocks`); }, 5000);
  await newJob();
}
