// ZAK Chain node: HTTP API + peer gossip + longest-valid-chain consensus.
import http from 'http';
import fs from 'fs';
import { Chain } from './zakchain.mjs';

const PORT = +process.env.PORT || 7001;
const PEERS = (process.env.PEERS || '').split(',').filter(Boolean);
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

const tryAdopt = blocks => chain.consider(blocks);
async function sync() {
  for (const p of PEERS) { try { tryAdopt(await (await fetch(p + '/chain')).json()); } catch {} }
}

const routes = {
  'GET /chain': () => chain.blocks,
  'GET /pending': () => chain.pending,
  'GET /info': () => ({ port: PORT, height: chain.blocks.length - 1, tip: chain.blocks.at(-1).hash, pending: chain.pending.length, valid: chain.valid(), bits: chain.blocks.at(-1).bits, work: chain.state().work, peers: PEERS }),
  'GET /balance': q => ({ address: q.get('address'), balance: chain.state().bal[q.get('address')] || 0, nonce: chain.state().nonce[q.get('address')] || 0 }),
  'POST /tx': (q, body) => {
    if (chain.pending.some(t => t.sig === body.sig) || chain.blocks.some(b => b.txs.some(t => t.sig === body.sig))) return { ok: true, dup: true };
    chain.submit(body); broadcast('/tx', body); return { ok: true };
  },
  'POST /mine': (q) => { const b = chain.mine(q.get('miner') || process.env.MINER || genesis.address); broadcast('/block', chain.blocks); return b; },
  'POST /block': async (q, body) => { const adopted = tryAdopt(body); if (adopted) broadcast('/block', chain.blocks); return { adopted }; },
};

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let raw = ''; for await (const c of req) raw += c;
  const fn = routes[`${req.method} ${u.pathname}`];
  res.setHeader('content-type', 'application/json');
  if (!fn) { res.statusCode = 404; return res.end('{"error":"not found"}'); }
  try { res.end(JSON.stringify(await fn(u.searchParams, raw ? JSON.parse(raw) : null))); }
  catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: e.message })); }
}).listen(PORT, () => { console.log('ZAK node on', PORT, 'peers', PEERS); sync(); setInterval(sync, 5000); });
