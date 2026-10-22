// ZAK Chain explorer: serves the static explorer page and proxies read-only /api/* calls to a ZAK node.
// Usage: NODE=http://localhost:7001 PORT=7100 node server.mjs
import http from 'http'; import fs from 'fs';
const NODE = process.env.NODE || 'http://localhost:7001', PORT = +process.env.PORT || 7100;
const ALLOWED = new Set(['/info', '/chain', '/pending', '/balance']);   // read-only node endpoints only
const FILES = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'] };
const SECURITY = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'" };
const send = (res, code, type, body, extra = {}) => { res.writeHead(code, { 'content-type': type, ...SECURITY, ...extra }); res.end(body); };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    const path = u.pathname.slice(4);
    if (req.method !== 'GET' || !ALLOWED.has(path)) return send(res, 404, 'application/json', '{"error":"not available through the explorer"}');
    try {
      const r = await fetch(NODE + path + u.search, { signal: AbortSignal.timeout(5000) });
      send(res, r.status, 'application/json', await r.text(), { 'cache-control': 'no-store' });
    } catch { send(res, 502, 'application/json', '{"error":"node offline"}'); }
    return;
  }
  const f = FILES[u.pathname];
  if (!f || req.method !== 'GET') return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  send(res, 200, f[1], fs.readFileSync(new URL('./' + f[0], import.meta.url)), { 'cache-control': 'no-cache' });
}).listen(PORT, () => console.log(`explorer on :${PORT}, reading from ${NODE}`));
