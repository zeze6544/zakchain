// Safety tests for miner.mjs. Uses a private in-process mock node (real Chain rules, easy difficulty) on a random
// port, so it never touches the real nodes on 7001-7003. Run: node test-miner.mjs
import assert from 'assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { Chain, newWallet } from './zakchain.mjs';

const HAS_NATIVE = fs.existsSync(new URL('./native/zakminer', import.meta.url).pathname);
const cores = os.availableParallelism?.() ?? os.cpus().length;
const addr = newWallet().address;   // throwaway address
const genesisOwner = newWallet().address;
let chain = new Chain(genesisOwner, 1);   // reset per test that needs easy (16-bit) difficulty
let requests = 0;
const server = http.createServer(async (req, res) => {
  requests++;
  let raw = ''; for await (const c of req) raw += c;
  const p = new URL(req.url, 'http://x').pathname;
  const body = p === '/chain' ? chain.blocks : p === '/pending' ? [] : p === '/info' ? { tip: chain.blocks.at(-1).hash } :
    p === '/block' ? { adopted: chain.consider(JSON.parse(raw)) } : null;
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const NODE = `http://127.0.0.1:${server.address().port}`;

// Starts the miner; resolves helpers to wait for output and exit.
const spawned = [];
process.on('exit', () => spawned.forEach(p => { try { p.kill('SIGKILL'); } catch {} }));   // never leave miners behind on failure
function run(args, env = {}) {
  const p = spawn(process.execPath, ['miner.mjs', addr, NODE, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  spawned.push(p);
  p.stdin.end();   // not a TTY and no "yes": consent can only come from --i-understand
  let out = '';
  p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  const exited = new Promise(r => p.on('exit', (code, sig) => r({ code, sig })));
  const waitFor = (re, ms = 15000) => new Promise((res, rej) => {
    const t0 = Date.now(), iv = setInterval(() => {
      const m = out.match(re); if (m) { clearInterval(iv); res(m); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timeout waiting for ${re}\n--- output ---\n${out}`)); }
    }, 50);
  });
  return { p, exited, waitFor, out: () => out };
}
const childrenOf = pid => fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).filter(n => {
  try { return fs.readFileSync(`/proc/${n}/stat`, 'utf8').split(') ')[1].split(' ')[1] === String(pid); } catch { return false; }
}).map(Number);
const alive = pid => { try { process.kill(pid, 0); return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0] !== 'Z'; } catch { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, skipped = 0;
async function test(name, fn, skip) {
  if (skip) { skipped++; return console.log(`skip - ${name} (${skip})`); }
  try { await fn(); } catch (e) { console.log(`not ok - ${name}`); console.error(e); process.exit(1); }
  passed++; console.log('ok -', name);
}

await test('refuses to start without --i-understand (non-interactive), before any network call', async () => {
  const before = requests, m = run(['--threads', '1']);
  const { code } = await m.exited;
  assert.equal(code, 2);
  assert.match(m.out(), /Refusing to start: no consent/);
  assert.match(m.out(), /NO cash value/); assert.match(m.out(), /How to stop/);   // disclosure is shown first
  assert.doesNotMatch(m.out(), /\[status\]/);
  assert.equal(requests, before, 'miner contacted the node before consent');
});

await test('typing anything other than "yes" is a refusal too', async () => {
  const p = spawn(process.execPath, ['miner.mjs', addr, NODE], { stdio: ['pipe', 'pipe', 'pipe'] });
  p.stdin.end('no\n');
  const code = await new Promise(r => p.on('exit', r));
  assert.equal(code, 2);
});

await test('default is 1 thread; --threads is capped at available cores; bad values rejected', async () => {
  const d = run(['--i-understand', '--max-minutes', '0.02', '--engine', 'js']);
  await d.waitFor(/ZAK miner pid \d+: 1\/\d+ threads/); await d.exited;
  const c = run(['--i-understand', '--threads', String(cores + 50), '--max-minutes', '0.02', '--engine', 'js']);
  await c.waitFor(new RegExp(`capped to ${cores}`)); await c.waitFor(new RegExp(`: ${cores}/${cores} threads`));
  assert.equal((await c.exited).code, 0);
  for (const bad of ['0', '-3', '1.5', 'abc']) assert.equal((await run(['--i-understand', '--threads', bad]).exited).code, 1, `threads ${bad}`);
  assert.equal((await run(['--i-understand', '--max-cpu', '0']).exited).code, 1);
  assert.equal((await run(['--i-understand', '--max-cpu', '101']).exited).code, 1);
});

await test('--max-minutes stops the miner on its own', async () => {
  const t0 = Date.now(), m = run(['--i-understand', '--max-minutes', '0.05', '--status-seconds', '1']);   // 3 s
  const { code } = await m.exited, took = Date.now() - t0;
  assert.equal(code, 0); assert.match(m.out(), /Stopped \(max-minutes 0.05 reached\)/);
  assert.ok(took >= 3000 && took < 8000, `took ${took} ms`);
  assert.match(m.out(), /\[status\] up .* \| threads 1\/\d+ \| cpu cap .* \| cpu used .* MH\/s .* \| blocks won \d+/);
});

await test('JS engine finds and submits blocks to the given node; SIGTERM exits cleanly', async () => {
  chain = new Chain(genesisOwner, 1);
  const h0 = chain.blocks.length, m = run(['--i-understand', '--engine', 'js', '--threads', '2']);
  await m.waitFor(/block \d+ WON/, 20000);
  m.p.kill('SIGTERM');
  const { code } = await m.exited;
  assert.equal(code, 0); assert.match(m.out(), /Stopped \(SIGTERM\)/); assert.ok(chain.blocks.length > h0);
});

await test('SIGTERM leaves no child processes (native engine, including while duty-cycle paused)', async () => {
  for (const cap of ['100', '20']) {
    const m = run(['--i-understand', '--engine', 'native', '--threads', '2', '--max-cpu', cap, '--status-seconds', '1']);
    await m.waitFor(/\[status\]/);
    let kids = []; for (let i = 0; i < 40 && !kids.length; i++) { kids = childrenOf(m.p.pid); await sleep(50); }
    assert.ok(kids.length >= 1, 'expected a native zakminer child');
    if (cap === '20') await sleep(500);   // most likely inside the SIGSTOP part of the cycle
    m.p.kill('SIGTERM');
    assert.equal((await m.exited).code, 0);
    await sleep(200);
    for (const k of kids) assert.equal(alive(k), false, `child ${k} still alive (cap ${cap})`);
  }
}, HAS_NATIVE ? null : 'native/zakminer not built');

await test('Ctrl+C (SIGINT) also stops cleanly', async () => {
  const m = run(['--i-understand', '--status-seconds', '1']);
  await m.waitFor(/\[status\]/); const kids = childrenOf(m.p.pid);
  m.p.kill('SIGINT');
  assert.equal((await m.exited).code, 0); await sleep(200);
  for (const k of kids) assert.equal(alive(k), false);
});

await test('if miner.mjs is SIGKILLed, the native child exits by itself (no orphan)', async () => {
  const m = run(['--i-understand', '--engine', 'native', '--threads', '1', '--status-seconds', '1']);
  await m.waitFor(/\[status\]/);
  const kids = childrenOf(m.p.pid); assert.ok(kids.length >= 1);
  m.p.kill('SIGKILL'); await m.exited; await sleep(500);
  for (const k of kids) assert.equal(alive(k), false, `orphan ${k} survived`);
}, HAS_NATIVE ? null : 'native/zakminer not built');

await test('--max-cpu duty cycle keeps measured CPU near the cap', async () => {
  const m = run(['--i-understand', '--engine', 'native', '--threads', '2', '--max-cpu', '25', '--status-seconds', '2', '--max-minutes', '0.15']);
  await m.exited;
  const pcts = [...m.out().matchAll(/cpu used (\d+)% of 1 core/g)].map(x => +x[1]).slice(1);   // skip warm-up sample
  const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  console.log(`   2 threads x 25% cap -> measured ${pcts.join(', ')}% of one core (target 50)`);
  assert.ok(pcts.length >= 2 && avg > 25 && avg < 80, `avg ${avg}`);
}, HAS_NATIVE ? null : 'native/zakminer not built');

await test('SIGUSR1 pauses and resumes', async () => {
  const m = run(['--i-understand', '--engine', 'js', '--status-seconds', '1']);
  await m.waitFor(/\[status\]/); m.p.kill('SIGUSR1');
  await m.waitFor(/paused \(user\)/); m.p.kill('SIGUSR1'); await m.waitFor(/Resumed by user/);
  m.p.kill('SIGTERM'); assert.equal((await m.exited).code, 0);
});

await test('only talks to the node URL it was given; no other network APIs in the miner', () => {
  const src = fs.readFileSync(new URL('./miner.mjs', import.meta.url), 'utf8');
  const fetches = [...src.matchAll(/fetch\(([^,)]+)/g)].map(m => m[1].trim());
  assert.ok(fetches.length >= 2); for (const f of fetches) assert.match(f, /^node \+/, `fetch target ${f}`);
  assert.doesNotMatch(src, /from '(net|dgram|dns|https?|tls)'/);
  assert.doesNotMatch(src, /crontab|systemctl|launchctl|\.bashrc|\.profile|schtasks|XDG_CONFIG|setsid|detached: *true|unref\(\)/);
});

await test('--version reports SHA-256 values that match the files', async () => {
  const m = run(['--version']); await m.exited;
  const h = crypto.createHash('sha256').update(fs.readFileSync(new URL('./miner.mjs', import.meta.url))).digest('hex');
  assert.match(m.out(), new RegExp(`miner.mjs +sha256 ${h}`)); assert.match(m.out(), /UNSIGNED/);
});

server.close();
console.log(`all miner tests passed (${passed} passed, ${skipped} skipped)`);
