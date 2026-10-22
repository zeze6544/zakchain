// ZAK Chain node: HTTP API + peer gossip + most-work valid-chain consensus.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { Worker } from 'worker_threads';
import { Chain } from './zakchain.mjs';

export const MAX_BODY = 256 * 1024;   // one request. A full chain larger than this is pulled with GET /chain.
const PORT = +process.env.PORT || 7001;
const PEERS = (process.env.PEERS || '').split(',').filter(Boolean);

export function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
// /mine stays off unless ALLOW_MINE=1, and even then only a loopback client may call it.
export function mineGuard(flag, addr) {
  if (flag !== '1') return { status: 403, error: 'mining disabled' };
  if (!isLoopback(addr)) return { status: 403, error: 'localhost only' };
  return null;
}

function findNonceInWorker(hh, bits) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./mine-worker.mjs', import.meta.url), { workerData: { hh, bits } });
    const fail = e => reject(e instanceof Error ? e : new Error(String(e)));
    w.once('message', m => (m?.error ? fail(new Error(m.error)) : resolve(m)));
    w.once('error', fail);
  });
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const genesis = JSON.parse(fs.readFileSync(new URL('./genesis.json', import.meta.url)));
  const chain = new Chain(genesis.address, genesis.time);
  // Persist the chain so a restarted node picks up where it left off (validated on load).
  const DATA = new URL(`./data/chain-${PORT}.json`, import.meta.url).pathname;
  fs.mkdirSync(new URL('./data/', import.meta.url).pathname, { recursive: true });
  if (fs.existsSync(DATA)) { try { chain.consider(JSON.parse(fs.readFileSync(DATA))); } catch {} }
  let savedTip = chain.blocks.at(-1).hash;
  setInterval(() => { const tip = chain.blocks.at(-1).hash; if (tip !== savedTip) { fs.writeFileSync(DATA + '.tmp', JSON.stringify(chain.blocks)); fs.renameSync(DATA + '.tmp', DATA); savedTip = tip; } }, 2000);

  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  const broadcast = (path, body) => PEERS.forEach(p => post(p + path, body));

  // Gossip only blocks this node did not already have. Peers that cannot link them
  // download the full chain and keep whichever valid chain has more proof of work.
  function announce(before) {
    const novel = chain.blocks.filter(b => !before.has(b.hash));
    if (novel.length === 1) broadcast('/block', novel[0]);
    else if (novel.length) broadcast('/block', novel);
  }

  // Ask for the suffix from our height. When it does not extend our tip, resolve the fork by total work.
  async function sync() {
    for (const p of PEERS) {
      try {
        const info = await (await fetch(p + '/info', { signal: AbortSignal.timeout(3000) })).json();
        if (!(info.work > chain.state().work) || info.tip === chain.blocks.at(-1).hash) continue;
        const before = new Set(chain.blocks.map(b => b.hash));
        const from = chain.blocks.length - 1;
        const part = await (await fetch(p + '/blocks?from=' + from, { signal: AbortSignal.timeout(10000) })).json();
        const extended = Array.isArray(part) && part.length > 1 && part[0]?.hash === chain.blocks.at(-1).hash;
        const adopted = extended
          ? chain.offer(part.slice(1))
          : chain.consider(await (await fetch(p + '/chain', { signal: AbortSignal.timeout(10000) })).json());
        if (adopted) announce(before);
      } catch {}
    }
  }

  const routes = {
    'GET /chain': () => chain.blocks,
    'GET /blocks': q => chain.blocksFrom(q.get('from') ?? 0),
    'GET /pending': () => chain.pending,
    'GET /info': () => ({ port: PORT, height: chain.blocks.length - 1, tip: chain.blocks.at(-1).hash, pending: chain.pending.length, valid: chain.valid(), bits: chain.blocks.at(-1).bits, work: chain.state().work, peers: PEERS }),
    'GET /balance': q => ({ address: q.get('address'), balance: chain.state().bal[q.get('address')] || 0, nonce: chain.state().nonce[q.get('address')] || 0 }),
    'POST /tx': (q, body) => {
      if (chain.pending.some(t => t.sig === body.sig) || chain.blocks.some(b => b.txs.some(t => t.sig === body.sig))) return { ok: true, dup: true };
      chain.submit(body); broadcast('/tx', body); return { ok: true };
    },
    'POST /mine': async (q, _body, req) => {
      const denied = mineGuard(process.env.ALLOW_MINE, req.socket.remoteAddress);
      if (denied) { const e = new Error(denied.error); e.status = denied.status; throw e; }
      const prep = chain.prepareMine(q.get('miner') || process.env.MINER || genesis.address);
      const found = await findNonceInWorker(prep.hh, prep.block.bits);
      prep.block.nonce = Number(found.nonce);
      prep.block.hash = found.hash;
      const before = new Set(chain.blocks.map(b => b.hash));
      const b = chain.finishMine(prep.block, prep.tip);
      if (!b) return { adopted: false, error: 'stale chain' };
      announce(before);
      return b;
    },
    'POST /block': (q, body) => {
      const before = new Set(chain.blocks.map(b => b.hash));
      const adopted = chain.offer(body);
      if (adopted) announce(before);
      // A block we cannot link may be the tip of a heavier fork. Sync compares total work.
      // Do not await: the sender may be blocked on this response, and sync fetches that peer.
      else if (!chain.links(body)) sync();
      return { adopted };
    },
  };

  http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    // Browsers may read GET responses. POST is not offered, so a page cannot script /mine.
    if (req.method === 'GET' || req.method === 'OPTIONS') res.setHeader('access-control-allow-origin', '*');
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
      return res.end();
    }
    let raw = '';
    for await (const c of req) {
      raw += c;
      if (raw.length > MAX_BODY) { res.statusCode = 413; res.end('{"error":"too large"}'); req.destroy(); return; }
    }
    const fn = routes[`${req.method} ${u.pathname}`];
    if (!fn) { res.statusCode = 404; return res.end('{"error":"not found"}'); }
    try { res.end(JSON.stringify(await fn(u.searchParams, raw ? JSON.parse(raw) : null, req))); }
    catch (e) { res.statusCode = e.status || 400; res.end(JSON.stringify({ error: e.message })); }
  }).listen(PORT, () => { console.log('ZAK node on', PORT, 'peers', PEERS, 'mine', process.env.ALLOW_MINE === '1' ? 'localhost' : 'off'); sync(); setInterval(sync, 5000); });
}
