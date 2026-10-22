// ZAK miner (opt-in, visibly limited, local-only telemetry).
//   node miner.mjs <yourAddress> [nodeUrl] [--threads N] [--max-cpu PCT] [--max-minutes M] [--i-understand]
// DISCLAIMER: ZAK has no cash value. Mining it earns no money and carries no promise of returns.
// Safety rules this file enforces (see MINER-SAFETY.md):
//   - off by default: refuses to start without --i-understand or a typed "yes" after reading what it does
//   - 1 thread by default, never more than the cores the OS reports; optional duty-cycle CPU cap and auto-stop
//   - talks only to the node URL you give it; collects and sends no other data; status is printed locally only
//   - installs nothing, starts nothing at boot, leaves no process behind on Ctrl+C / SIGTERM / parent death
// Uses the native SHA-NI miner in native/zakminer when it is built (see README), otherwise JS worker threads.
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';
import readline from 'readline';
import { spawn } from 'child_process';
import { Worker, isMainThread, parentPort } from 'worker_threads';
import { nextBits, headerHash, powHash, zeroBits, replay, selectTxs } from './zakchain.mjs';

if (!isMainThread) {
  // JS fallback worker: tries nonces next, next+step, ... using the same 40-byte proof-of-work input.
  // It hashes only while it has a job and is not paused; otherwise it idles on a 50 ms timer (near-zero CPU).
  let job = null, paused = false, hashes = 0;
  const buf = Buffer.alloc(40);
  parentPort.on('message', m => {
    if (m.type === 'job') { job = m; buf.write(m.hh, 0, 'hex'); }
    if (m.type === 'pause') paused = true;
    if (m.type === 'resume') paused = false;
  });
  const loop = () => {
    if (job && !paused) {
      for (let i = 0; i < 5000; i++) {
        const n = job.next; job.next += job.step; hashes++;
        buf.writeBigUInt64BE(BigInt(n), 32);
        const h = crypto.createHash('sha256').update(buf).digest('hex');
        if (zeroBits(h) >= job.bits) { parentPort.postMessage({ found: { id: job.id, nonce: n, hash: h } }); job = null; break; }
      }
    }
    if (hashes) parentPort.postMessage({ hashes }); hashes = 0;
    job && !paused ? setImmediate(loop) : setTimeout(loop, 50);
  };
  loop();
}

function parseArgs(argv) {
  const o = { pos: [], threads: undefined, maxCpu: 100, maxMinutes: 0, statusSeconds: 10, engine: 'auto', iUnderstand: false, allowBattery: false, maxTemp: 90 };
  const num = (k, v) => { const n = Number(v); if (v === undefined || !Number.isFinite(n)) throw new Error(`${k} needs a number`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], [k, inline] = a.startsWith('--') ? a.split(/=(.*)/s) : [a];
    const val = () => inline ?? argv[++i];
    switch (k) {
      case '--threads': o.threads = num(k, val()); break;
      case '--max-cpu': o.maxCpu = num(k, val()); break;
      case '--max-minutes': o.maxMinutes = num(k, val()); break;
      case '--status-seconds': o.statusSeconds = num(k, val()); break;
      case '--max-temp': o.maxTemp = num(k, val()); break;
      case '--engine': o.engine = val(); break;
      case '--i-understand': o.iUnderstand = true; break;
      case '--allow-battery': o.allowBattery = true; break;
      case '--help': case '-h': o.help = true; break;
      case '--version': o.version = true; break;
      default: if (k.startsWith('--')) throw new Error(`unknown option ${k}`); o.pos.push(a);
    }
  }
  return o;
}

const USAGE = `usage: node miner.mjs <yourAddress> [nodeUrl] [options]
  --i-understand       skip the interactive "yes" prompt (you have read what the miner does)
  --threads N          mining threads (default 1, capped at the number of CPU cores)
  --max-cpu PCT        duty-cycle cap: each mining thread hashes only PCT% of the time (1-100, default 100)
  --max-minutes M      stop automatically after M minutes (default: run until stopped)
  --status-seconds S   how often to print the local status line (default 10)
  --engine E           auto | native | js (default auto: native/zakminer if built, else JavaScript)
  --allow-battery      keep mining on battery power (default: pause while on battery)
  --max-temp C         pause while any thermal sensor reads above C degrees (default 90)
  --version            print version and SHA-256 of the miner files, then exit
Stop: Ctrl+C (or kill <pid>). Pause/resume: kill -USR1 <pid>. Uninstall: delete the folder.`;

const sha256File = f => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };

function disclosure(c) {
  return `
================ ZAK miner: read before starting ================
What it does : repeatedly computes SHA-256 hashes (proof of work) to try to win
               ZAK Chain blocks for address ${c.address.slice(0, 16)}...
Value        : ZAK has NO cash value. Mining earns no money and no returns.
CPU use      : ${c.threads} thread(s) of ${c.cores} cores, each busy ${c.maxCpu}% of the time
               (about ${Math.round(c.threads * c.maxCpu / c.cores)}% of this machine). Expect heat, fan noise, battery drain.
Auto-stop    : ${c.maxMinutes ? `after ${c.maxMinutes} minute(s)` : 'none (runs until you stop it)'}
Network      : talks ONLY to ${c.node} (reads the chain, submits found blocks).
Data         : collects nothing about you or this machine; status lines are printed here only.
Install      : nothing installed, no service, no autostart. Uninstall = delete this folder.
How to stop  : Ctrl+C, or kill ${process.pid}. Pause/resume: kill -USR1 ${process.pid}
=================================================================`;
}

async function confirm(c) {
  console.log(disclosure(c));
  if (c.iUnderstand) { console.log('Consent given with --i-understand.'); return true; }
  if (!process.stdin.isTTY) {
    console.error('Refusing to start: no consent. Re-run with --i-understand after reading the above (non-interactive shell).');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise(r => rl.question('Type "yes" to start mining, anything else to quit: ', r));
  rl.close();
  if (ans.trim().toLowerCase() === 'yes') return true;
  console.error('Not started.');
  return false;
}

// Local-only environment checks (read from /sys on Linux; nothing is stored or sent anywhere).
function onBattery() {
  try {
    const dir = '/sys/class/power_supply', ps = fs.readdirSync(dir).map(n => ({ type: fs.readFileSync(`${dir}/${n}/type`, 'utf8').trim(), n }));
    const mains = ps.filter(p => p.type === 'Mains'), bats = ps.filter(p => p.type === 'Battery');
    if (!bats.length) return false;
    if (mains.length) return !mains.some(p => fs.readFileSync(`${dir}/${p.n}/online`, 'utf8').trim() === '1');
    return bats.some(p => fs.readFileSync(`${dir}/${p.n}/status`, 'utf8').trim() === 'Discharging');
  } catch { return false; }
}
function maxTempC() {
  try {
    const dir = '/sys/class/thermal';
    const t = fs.readdirSync(dir).filter(n => n.startsWith('thermal_zone')).map(n => +fs.readFileSync(`${dir}/${n}/temp`, 'utf8') / 1000).filter(Number.isFinite);
    return t.length ? Math.max(...t) : null;
  } catch { return null; }
}
const CLK_TCK = 100;   // Linux USER_HZ; used only to turn /proc/<pid>/stat ticks into seconds
function procCpuSeconds(pid) {
  try { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return (+f[11] + +f[12]) / CLK_TCK; } catch { return null; }
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`error: ${e.message}\n${USAGE}`); process.exit(1); }
  const nativeBin = new URL('./native/zakminer', import.meta.url).pathname;
  if (o.help) { console.log(USAGE); return; }
  if (o.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url)));
    console.log(`zakchain miner ${pkg.version}`);
    console.log(`miner.mjs        sha256 ${sha256File(new URL(import.meta.url).pathname)}`);
    console.log(`native/zakminer  sha256 ${sha256File(nativeBin) ?? '(not built)'}`);
    console.log('Build status: UNSIGNED local/source build. Verify by building from source (see MINER-SAFETY.md).');
    return;
  }
  const [address, node = 'http://localhost:7001', legacyThreads] = o.pos;
  const fail = m => { console.error(`error: ${m}\n${USAGE}`); process.exit(1); };
  if (!address) fail('missing <yourAddress>');
  if (!/^[0-9a-f]{16,}$/i.test(address)) fail('address must be a hex ZAK address (node wallet.mjs new <name>)');
  try { const u = new URL(node); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { fail(`bad node URL ${node}`); }
  const cores = os.availableParallelism?.() ?? os.cpus().length;
  let threads = o.threads ?? (legacyThreads !== undefined ? Number(legacyThreads) : 1);
  if (!Number.isInteger(threads) || threads < 1) fail('threads must be a whole number >= 1');
  if (threads > cores) { console.log(`NOTE: --threads ${threads} capped to ${cores} (CPU cores available).`); threads = cores; }
  if (!(o.maxCpu >= 1 && o.maxCpu <= 100)) fail('--max-cpu must be between 1 and 100');
  if (!(o.maxMinutes >= 0)) fail('--max-minutes must be >= 0');
  if (!(o.statusSeconds >= 1)) fail('--status-seconds must be >= 1');
  if (!['auto', 'native', 'js'].includes(o.engine)) fail('--engine must be auto, native or js');
  if (o.engine === 'native' && !fs.existsSync(nativeBin)) fail('native engine not built (sh native/build.sh)');
  const native = o.engine === 'native' || (o.engine === 'auto' && fs.existsSync(nativeBin) && !process.env.ZAK_JS);
  const cfg = { address, node, threads, cores, maxCpu: o.maxCpu, maxMinutes: o.maxMinutes, iUnderstand: o.iUnderstand };

  process.stdout.on('error', () => process.exit(0));
  if (!(await confirm(cfg))) process.exit(2);
  // ---- consent given: nothing above this line hashes, spawns, or touches the network ----

  const get = async p => (await fetch(node + p, { signal: AbortSignal.timeout(10_000) })).json();
  let total = 0, found = 0, jobId = 0, current = null, tipSeen = null, proc = null, workers = [], stopping = false;
  let childCpu = 0, childPid = null, childLast = 0;
  const start = Date.now(), timers = [], pauses = new Set();
  const engineName = native ? 'native' : 'js';
  const capText = o.maxCpu < 100 ? `${o.maxCpu}% duty` : 'none (100%)';

  const sampleChild = () => { if (!childPid) return; const s = procCpuSeconds(childPid); if (s !== null) { childCpu += Math.max(0, s - childLast); childLast = s; } };
  const running = () => pauses.size === 0;
  function applyPause() {
    if (native && proc && proc.exitCode === null) proc.kill(running() ? 'SIGCONT' : 'SIGSTOP');
    for (const w of workers) w.postMessage({ type: running() ? 'resume' : 'pause' });
  }
  const setPause = (reason, on) => { const was = running(); on ? pauses.add(reason) : pauses.delete(reason); if (was !== running()) applyPause(); };

  async function killChild() {
    const p = proc; proc = null;
    if (!p || p.exitCode !== null || p.signalCode) return;
    sampleChild(); childPid = null;
    const gone = new Promise(r => p.once('exit', r));
    p.kill('SIGKILL');   // SIGKILL also ends a SIGSTOP-paused process; zakminer has no state to flush
    await gone;
  }

  async function shutdown(why, code = 0) {
    if (stopping) return; stopping = true;
    timers.forEach(t => clearInterval(t));
    await killChild();
    await Promise.all(workers.map(w => w.terminate()));
    console.log(`Stopped (${why}). Uptime ${fmt(Date.now() - start)}, blocks won ${found}. No background process left running.`);
    process.exit(code);
  }

  async function onFound(id, nonce, hash) {
    if (!current || current.id !== id || stopping) return;
    const { blocks, b } = current; current = null;
    b.nonce = Number(nonce); b.hash = hash;
    if (powHash(headerHash(b), b.nonce) !== hash) { console.log('miner bug: hash mismatch, skipping'); return newJob().catch(() => {}); }
    const send = body => fetch(node + '/block', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) }).then(r => r.json()).catch(() => ({}));
    // The node appends a block that extends its tip. If this block was built on a fork the node
    // no longer has, send the whole chain so total work can still win.
    let r = await send(b);
    if (!r.adopted) r = await send([...blocks, b]);
    if (r.adopted) found++;
    console.log(`block ${b.index} ${r.adopted ? 'WON' : 'lost race'} at ${b.bits} bits, ${b.txs.length} tx, fees ${b.txs.reduce((s, t) => s + t.fee, 0)} ZAK, won ${found}`);
    newJob().catch(() => {});
  }

  async function newJob() {
    if (stopping) return;
    const blocks = await get('/chain'), pending = await get('/pending');
    if (stopping) return;
    const prev = blocks.at(-1);
    let txs = [];
    try { txs = selectTxs(pending, replay(blocks)); } catch { txs = []; }
    const b = { index: prev.index + 1, prev: prev.hash, time: Math.max(Date.now(), prev.time + 1), bits: nextBits(blocks), miner: address, txs, nonce: 0 };
    const id = ++jobId, hh = headerHash(b);
    current = { id, blocks, b }; tipSeen = prev.hash;
    if (native) {
      await killChild();
      if (stopping) return;
      const p = proc = spawn(nativeBin, [hh, String(b.bits), String(threads), String(crypto.randomInt(2 ** 40))], { stdio: ['ignore', 'pipe', 'inherit'] });
      childPid = p.pid; childLast = 0;
      if (!running()) p.kill('SIGSTOP');
      let out = '';
      p.stdout.on('data', d => {
        out += d; let i;
        while ((i = out.indexOf('\n')) >= 0) {
          const [kind, a, h] = out.slice(0, i).split(' '); out = out.slice(i + 1);
          if (kind === 'RATE') total += +a;
          if (kind === 'FOUND') onFound(id, a, h);
        }
      });
    } else {
      workers.forEach((w, i) => w.postMessage({ type: 'job', id, hh, bits: b.bits, next: i, step: threads }));
    }
  }

  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => shutdown(s));
  process.on('SIGUSR1', () => { const on = !pauses.has('user'); setPause('user', on); console.log(on ? 'Paused by user (kill -USR1 again to resume).' : 'Resumed by user.'); });
  process.on('exit', () => { try { proc?.kill('SIGKILL'); } catch {} });

  if (!native) {
    workers = Array.from({ length: threads }, () => new Worker(new URL(import.meta.url)));
    for (const w of workers) w.on('message', m => { if (m.hashes) total += m.hashes; if (m.found) onFound(m.found.id, m.found.nonce, m.found.hash); });
  }
  console.log('NOTE: ZAK has no cash value. Mining earns no money and carries no promise of returns. This is an open-source hobby project.');
  console.log(`ZAK miner pid ${process.pid}: ${threads}/${cores} threads, cpu cap ${capText}, ${native ? 'native SHA-NI engine' : 'JavaScript engine'}, node ${node}${o.maxMinutes ? `, auto-stop after ${o.maxMinutes} min` : ''}`);

  if (o.maxMinutes) timers.push(setTimeout(() => shutdown(`max-minutes ${o.maxMinutes} reached`), o.maxMinutes * 60_000));
  // Duty cycle: within each 1 s period, hash for maxCpu% of it and stop (SIGSTOP / worker pause) for the rest.
  if (o.maxCpu < 100) {
    const PERIOD = 1000, on = PERIOD * o.maxCpu / 100;
    const cycle = () => { if (stopping) return; setPause('duty', false); timers.push(setTimeout(() => { if (!stopping) setPause('duty', true); }, on)); };
    cycle(); timers.push(setInterval(cycle, PERIOD));
  }
  const envCheck = () => {
    const bat = !o.allowBattery && onBattery();
    if (bat !== pauses.has('battery')) { setPause('battery', bat); console.log(bat ? 'Paused: running on battery (use --allow-battery to override).' : 'Resumed: on mains power.'); }
    const t = maxTempC();
    if (t !== null && t > o.maxTemp && !pauses.has('thermal')) { setPause('thermal', true); console.log(`Paused: temperature ${t.toFixed(0)}C > ${o.maxTemp}C.`); }
    if (pauses.has('thermal') && (t === null || t < o.maxTemp - 5)) { setPause('thermal', false); console.log('Resumed: temperature back to normal.'); }
  };
  envCheck(); timers.push(setInterval(envCheck, 5000));

  // Local status line. Only printed to this terminal; never sent anywhere.
  let lastT = Date.now(), lastHashes = 0, lastCpu = native ? 0 : cpuSecondsSelf();
  timers.push(setInterval(() => {
    const now = Date.now(), dt = (now - lastT) / 1000;
    let cpuNow; if (native) { sampleChild(); cpuNow = childCpu; } else cpuNow = cpuSecondsSelf();
    const cpuPct = (cpuNow - lastCpu) / dt * 100;
    const rate = (total - lastHashes) / dt;
    lastT = now; lastHashes = total; lastCpu = cpuNow;
    const state = running() ? 'mining' : [...pauses].filter(p => p !== 'duty').length ? `paused (${[...pauses].join(',')})` : 'mining (duty cycle)';
    console.log(`[status] up ${fmt(now - start)} | ${engineName} | threads ${threads}/${cores} | cpu cap ${capText} | cpu used ${cpuPct.toFixed(0)}% of 1 core (${(cpuPct / cores).toFixed(0)}% of machine) | ${(rate / 1e6).toFixed(2)} MH/s (avg ${(total / ((now - start) / 1000) / 1e6).toFixed(2)}) | blocks won ${found} | ${state}`);
  }, o.statusSeconds * 1000));

  // If someone else extends the chain, drop the stale job and restart on the new tip.
  timers.push(setInterval(async () => { if (stopping) return; try { const i = await get('/info'); if (i.tip !== tipSeen) await newJob(); } catch {} }, 1000));
  try { await newJob(); } catch (e) { console.log(`Cannot reach node ${node} (${e.cause?.code ?? e.message}); retrying every second. Ctrl+C to quit.`); }
}

function cpuSecondsSelf() { const u = process.cpuUsage(); return (u.user + u.system) / 1e6; }
function fmt(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }

if (isMainThread) await main();   // last, so every const above is initialised before main() runs
