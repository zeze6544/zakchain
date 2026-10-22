// ZAK Miner hashing worker. Runs real SHA-256 off the main thread so the page never stalls.
// It only hashes after the page sends running: true (the player pressed Start), and never uses more than the
// chosen share of one CPU core. Input for nonce n is the string `ZAK Miner|<seed>|<n>`; anyone can re-check a find with sha256sum.
importScripts('sha256.js');
const { digestBytes, toHex, zeroBitsOf } = self.ZakSHA;
const enc = new TextEncoder();
let seed = '', nonce = 0, cap = 500, running = false, cpu = 0.25, win0 = performance.now(), busy = 0, budget = 0, last = performance.now(), logFrom = 3;
let acc = newAcc();
function newAcc() { return { hashes: 0, counts: {}, finds: [], best: null, sample: null, ms: 0 }; }

onmessage = ({ data: m }) => {
  if (m.type === 'config') { if (m.seed !== undefined) seed = m.seed; if (m.nonce !== undefined) nonce = m.nonce; if (m.cap) cap = m.cap; if (m.running !== undefined) running = m.running; if (m.logFrom) logFrom = m.logFrom; if (m.cpu) cpu = Math.min(1, Math.max(0.05, m.cpu)); last = performance.now(); }
  if (m.type === 'burst') budget += m.n;
};

function work() {
  const now = performance.now(), dt = Math.min(now - last, 1000); last = now;
  if (running) budget += cap * dt / 1000;
  budget = Math.min(budget, cap + 5e5);                 // never bank more than ~1 s of cap plus taps
  // CPU limit: in every 100 ms window, hash for at most cpu × 100 ms, then sleep.
  if (now - win0 >= 100) { win0 = now; busy = 0; }
  const allowed = Math.min(40, cpu * 100 - busy);
  if (allowed < 1) { setTimeout(work, Math.max(1, win0 + 100 - now)); return; }
  const t0 = performance.now(), prefix = `ZAK Miner|${seed}|`;
  let n = 0;
  while (budget >= 1 && performance.now() - t0 < allowed) {   // ≤40 ms slices keep the worker responsive to messages
    for (let k = 0; k < 256 && budget >= 1; k++, n++, budget--) {
      const b = enc.encode(prefix + nonce), h = digestBytes(b, b.length), bits = zeroBitsOf(h), z = bits >> 2;
      if (z >= 2) {
        acc.counts[z] = (acc.counts[z] || 0) + 1;
        const hex = toHex(h);
        if (z >= logFrom && acc.finds.length < 50) acc.finds.push({ nonce, hash: hex, z, bits });
        if (!acc.best || bits > acc.best.bits) acc.best = { nonce, hash: hex, z, bits };
      }
      nonce++;
    }
  }
  const spent = performance.now() - t0; busy += spent; acc.hashes += n; acc.ms += spent;
  if (n) { const b = enc.encode(prefix + (nonce - 1)); acc.sample = { nonce: nonce - 1, hash: toHex(digestBytes(b, b.length)) }; }
  setTimeout(work, budget >= 1 ? 0 : 20);
}
setInterval(() => { if (acc.hashes || acc.sample) { postMessage({ type: 'progress', nonce, ...acc }); acc = newAcc(); } }, 250);
work();
