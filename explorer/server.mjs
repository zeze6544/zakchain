// ZAK Chain explorer: serves index.html and proxies /api/* to a ZAK node.
import http from 'http'; import fs from 'fs';
const NODE = process.env.NODE || 'http://localhost:7001', PORT = process.env.PORT || 7100;
const html = new URL('./index.html', import.meta.url);
http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    try { const r = await fetch(NODE + req.url.slice(4)); res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text()); }
    catch { res.writeHead(502); res.end('{"error":"node offline"}'); }
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(fs.readFileSync(html));
}).listen(PORT, () => console.log('explorer on :' + PORT));
