// ZAK Miner: idle game on real SHA-256 proof of work. Hashing runs in js/miner-worker.js; this file is the game.
// Game ZAK is a number in localStorage. It is not real ZAK and has no value.
(() => {
  'use strict';
  const $ = id => document.getElementById(id), KEY = 'zakgame2', BASE_CAP = 500, MAX_AWAY = 8 * 3600e3;
  const UP = {
    oc: { name: 'Overclock', desc: '+500 H/s cap', base: 15, g: 1.45, cap: 500 },
    gpu: { name: 'GPU', desc: '+5,000 H/s cap', base: 250, g: 1.5, cap: 5000 },
    farm: { name: 'Mining farm', desc: '+50,000 H/s cap', base: 6000, g: 1.55, cap: 50000 },
    dc: { name: 'Data centre', desc: '+500,000 H/s cap', base: 150000, g: 1.6, cap: 500000 },
    pool: { name: 'Pool bonus', desc: '+20% game ZAK per find', base: 500, g: 2.6 },
  };
  const ACH = [
    ['find', 'First find', 'A hash with 2 zeros', S => bestZ(S) >= 2], ['z3', 'Three zeros', '1 in 4,096', S => bestZ(S) >= 3],
    ['z4', 'Four zeros', '1 in 65,536', S => bestZ(S) >= 4], ['z5', 'Five zeros', '1 in 1 million', S => bestZ(S) >= 5],
    ['z6', 'Six zeros', '1 in 16.8 million', S => bestZ(S) >= 6], ['z7', 'Seven zeros', '1 in 268 million', S => bestZ(S) >= 7],
    ['z8', 'Eight zeros', '1 in 4.3 billion', S => bestZ(S) >= 8], ['h4', '10K hashes', 'Hash 10,000 times', S => S.hashes >= 1e4],
    ['h6', '1M hashes', 'Hash a million times', S => S.hashes >= 1e6], ['h8', '100M hashes', 'Hash 100 million times', S => S.hashes >= 1e8],
    ['h9', '1B hashes', 'Hash a billion times', S => S.hashes >= 1e9], ['u1', 'Upgraded', 'Buy an upgrade', S => upCount(S) >= 1],
    ['u25', 'Serious rig', 'Own 25 upgrades', S => upCount(S) >= 25], ['k', '1K game ZAK', 'Earn 1,000 in total', S => S.lifeZak >= 1e3],
    ['m', '1M game ZAK', 'Earn a million in total', S => S.lifeZak >= 1e6], ['tap', 'Hands on', 'Tap the rig 100 times', S => S.taps >= 100],
    ['f1', 'Hard fork', 'Fork once', S => S.forks >= 1], ['f5', 'Serial forker', 'Fork five times', S => S.forks >= 5],
  ];
  const bestZ = S => S.best ? S.best.z : 0, upCount = S => Object.keys(UP).reduce((s, k) => s + S.up[k], 0);
  const hex8 = () => [...crypto.getRandomValues(new Uint8Array(4))].map(x => x.toString(16).padStart(2, '0')).join('');
  const fresh = () => ({ v: 2, seed: hex8(), nonce: 0, zak: 0, runZak: 0, lifeZak: 0, hashes: 0, runHashes: 0, up: { oc: 0, gpu: 0, farm: 0, dc: 0, pool: 0 },
    forks: 0, forkPts: 0, best: null, top: [], counts: {}, ach: {}, playMs: 0, bestRate: 0, lastRate: 0, taps: 0, created: Date.now(), saved: Date.now(), sound: false, bg: false, paused: true, cpu: 0.25, wasMining: false });

  function load() {
    try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.v === 2) return { ...fresh(), ...s, up: { ...fresh().up, ...s.up } }; } catch {}
    const S = fresh();
    try { // migrate the first version of the game ({zak, hashes, gpu, farm, best})
      const o = JSON.parse(localStorage.getItem('zakgame'));
      if (o) { S.zak = S.runZak = S.lifeZak = +o.zak || 0; S.hashes = S.runHashes = +o.hashes || 0; S.up.oc = +o.gpu || 0; S.up.gpu = +o.farm || 0; S.migrated = true; }
    } catch {}
    return S;
  }
  let S = load();
  S.paused = true;   // mining is always off when the page opens; the player must press Start
  const save = () => { S.saved = Date.now(); S.wasMining = running(); try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} };

  // ---- formatting
  const SUF = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi'];
  const big = n => { n = Math.floor(n); if (n < 1e6) return n.toLocaleString(); const e = Math.min(Math.floor(Math.log10(n) / 3), SUF.length - 1); return (n / 10 ** (e * 3)).toFixed(2) + SUF[e]; };
  const rateFmt = r => r >= 1e6 ? (r / 1e6).toFixed(2) + ' MH/s' : r >= 1e4 ? (r / 1e3).toFixed(1) + ' kH/s' : Math.round(r).toLocaleString() + ' H/s';
  const dur = ms => { const s = ms / 1000; return s < 60 ? Math.round(s) + 's' : s < 3600 ? Math.round(s / 60) + ' min' : s < 86400 ? (s / 3600).toFixed(1) + ' h' : (s / 86400).toFixed(1) + ' days'; };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const showHash = h => { const z = /^0*/.exec(h)[0]; return `<span class="z">${z}</span>${h.slice(z.length)}`; };
  const input = (seed, nonce) => `ZAK Miner|${seed}|${nonce}`;

  // ---- economy
  const cap = () => BASE_CAP + ['oc', 'gpu', 'farm', 'dc'].reduce((s, k) => s + S.up[k] * UP[k].cap, 0);
  const mult = () => (1 + 0.2 * S.up.pool) * (1 + 0.1 * S.forkPts);
  const cost = k => Math.ceil(UP[k].base * UP[k].g ** S.up[k]);
  const reward = z => 16 ** (z - 2) * mult();
  const forkGain = () => Math.floor(Math.sqrt(S.runZak / 1e6));
  // Expected game ZAK per hash counting finds with 2-6 zeros: each zero level contributes (15/16)/256.
  const expectedPerHash = () => 5 * (15 / 16) / 256 * mult();
  const logFrom = r => Math.max(3, Math.ceil(Math.log(Math.max(r, 1)) / Math.log(16)));
  const earn = n => { S.zak += n; S.runZak += n; S.lifeZak += n; };

  // ---- worker
  let worker = null, rate = 0, hist = [], lastGain = [], hidden = false, hiddenAt = 0;
  const running = () => !S.paused && !(hidden && !S.bg);
  const configure = () => worker && worker.postMessage({ type: 'config', cap: cap(), running: running(), cpu: S.cpu, logFrom: logFrom(Math.min(cap(), rate || cap())) });
  try {
    worker = new Worker('js/miner-worker.js');
    worker.onmessage = ({ data: m }) => onProgress(m);
    worker.onerror = () => { $('tick').textContent = 'The hashing worker failed to start in this browser.'; };
    worker.postMessage({ type: 'config', seed: S.seed, nonce: S.nonce }); configure();
  } catch { $('tick').textContent = 'This browser cannot run Web Workers, so ZAK Miner cannot hash here.'; }

  function onProgress(m) {
    S.hashes += m.hashes; S.runHashes += m.hashes; S.nonce = m.nonce;
    let gain = 0;
    for (const z in m.counts) { S.counts[z] = (S.counts[z] || 0) + m.counts[z]; gain += m.counts[z] * reward(+z); }
    earn(gain); lastGain.push([performance.now(), gain]);
    hist.push([performance.now(), m.hashes]);
    if (m.sample) { $('tick').innerHTML = showHash(m.sample.hash); $('tickin').textContent = input(S.seed, m.sample.nonce); }
    const found = [...m.finds]; if (m.best && !found.some(f => f.nonce === m.best.nonce)) found.push(m.best);
    for (const f of found) {
      f.seed = S.seed; f.t = Date.now();
      if (!S.best || f.bits > S.best.bits) { S.best = f; if (f.z >= 3) toast(`New best hash: ${f.z} zeros (${f.bits} bits)`); }
      if (S.top.length < 10 || f.bits > S.top.at(-1).bits) { S.top.push(f); S.top.sort((a, b) => b.bits - a.bits); S.top = S.top.slice(0, 10); }
    }
    for (const f of m.finds) logFind(f);
  }
  async function logFind(f) {
    const el = document.createElement('div'), r = reward(f.z);
    el.innerHTML = `+${big(r)} · ${f.z} zeros · ${showHash(f.hash.slice(0, 24))}… · nonce ${f.nonce.toLocaleString()} <span class="v">checking…</span>`;
    const log = $('log'); log.querySelector('.empty')?.remove(); log.prepend(el); while (log.children.length > 60) log.lastChild.remove();
    pop('+' + big(r)); if (S.sound) beep(f.z);
    try { // independent check with the browser's own SHA-256
      const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input(f.seed, f.nonce)));
      const h = [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
      el.querySelector('.v').outerHTML = h === f.hash ? '<span class="ok" title="Re-hashed with crypto.subtle">✓ verified</span>' : '<span style="color:#f87171">✗ mismatch</span>';
    } catch { el.querySelector('.v').remove(); }
  }

  // ---- effects
  function pop(text) { const p = document.createElement('span'); p.className = 'pop'; p.textContent = text; $('rig').append(p); setTimeout(() => p.remove(), 1000); }
  let ac = null;
  function beep(z) {
    try {
      ac ||= new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
      o.frequency.value = 320 + z * 110; o.type = 'triangle'; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.08, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.2);
    } catch {}
  }
  function toast(msg) { const d = document.createElement('div'); d.textContent = msg; $('toasts').append(d); setTimeout(() => d.remove(), 4000); }

  // ---- controls
  $('rig').addEventListener('click', () => {
    if (!worker) return;
    if (S.paused) { toast('Mining is off. Press "Start mining" to let this page use your CPU.'); return; } S.taps++; const n = Math.round(500 + cap() * 0.05);
    worker.postMessage({ type: 'burst', n }); $('rig').classList.add('hot'); setTimeout(() => $('rig').classList.remove('hot'), 150); pop(`${big(n)} hashes`);
  });
  $('pause').addEventListener('click', () => { S.paused = !S.paused; if (!S.paused) $('tick').textContent = 'starting…'; configure(); render(); save(); });
  const cpuSel = $('cpu'); cpuSel.value = String(S.cpu); if (cpuSel.value !== String(S.cpu)) { S.cpu = 0.25; cpuSel.value = '0.25'; }
  cpuSel.addEventListener('change', () => { S.cpu = +cpuSel.value; configure(); render(); save(); });
  $('sound').checked = S.sound; $('sound').addEventListener('change', e => { S.sound = e.target.checked; if (S.sound) beep(3); });
  $('bg').checked = S.bg; $('bg').addEventListener('change', e => { S.bg = e.target.checked; });

  const shop = $('shop');
  for (const k in UP) shop.insertAdjacentHTML('beforeend', `<div class="item"><div><b>${UP[k].name} <small style="display:inline" id="own-${k}"></small></b><small>${UP[k].desc}</small></div><button class="btn" id="buy-${k}" data-k="${k}"></button></div>`);
  shop.addEventListener('click', e => { const k = e.target.closest('button')?.dataset.k; if (!k || S.zak < cost(k)) return; S.zak -= cost(k); S.up[k]++; configure(); render(); save(); });

  $('fork').addEventListener('click', () => {
    const g = forkGain(); if (g < 1) return;
    if (!confirm(`Hard fork: reset your game ZAK and upgrades to gain ${g} fork point${g > 1 ? 's' : ''} (+${g * 10}% game ZAK per find, permanently). Your hash count, bests and achievements stay.`)) return;
    S.forkPts += g; S.forks++; S.zak = 0; S.runZak = 0; S.runHashes = 0; for (const k in UP) S.up[k] = 0; configure(); save(); render(); toast(`Forked! ${S.forkPts} fork points.`);
  });

  // ---- offline / away progress (estimated, nothing is hashed while away)
  function applyAway(ms, why) {
    if (ms < 60e3 || !S.lastRate) return;
    const t = Math.min(ms, MAX_AWAY), est = 0.5 * S.lastRate * (t / 1000) * expectedPerHash();
    if (est < 1) return; earn(est);
    const a = $('away'); a.hidden = false;
    a.innerHTML = `<b>Welcome back.</b> You were ${why} for ${dur(ms)}. Estimated earnings: <b>+${big(est)} game ZAK</b>. <small>No hashes were computed while you were away; this is an estimate at half your last hash rate, capped at 8 hours.</small>`;
  }
  if (S.wasMining) applyAway(Date.now() - S.saved, 'away');
  document.addEventListener('visibilitychange', () => {
    hidden = document.hidden; configure();
    if (hidden) { hiddenAt = Date.now(); save(); } else if (!S.bg && hiddenAt && !S.paused) { applyAway(Date.now() - hiddenAt, 'on another tab'); hiddenAt = 0; }
  });
  addEventListener('pagehide', save);

  // ---- save management
  const msg = t => { $('savemsg').textContent = t; };
  $('exp').addEventListener('click', async () => {
    const code = btoa(unescape(encodeURIComponent(JSON.stringify(S))));
    try { await navigator.clipboard.writeText(code); msg('Save copied to the clipboard. Keep it somewhere safe.'); } catch { prompt('Copy your save:', code); }
  });
  $('imp').addEventListener('click', () => {
    const code = prompt('Paste a ZAK Miner save:'); if (!code) return;
    try { const s = JSON.parse(decodeURIComponent(escape(atob(code.trim())))); if (s.v !== 2) throw 0; S = { ...fresh(), ...s, up: { ...fresh().up, ...s.up } }; worker?.postMessage({ type: 'config', seed: S.seed, nonce: S.nonce }); configure(); save(); render(); msg('Save imported.'); }
    catch { msg("That doesn't look like a ZAK Miner save."); }
  });
  $('reset').addEventListener('click', () => {
    if (!confirm('Delete your ZAK Miner progress in this browser? This cannot be undone.')) return;
    S = fresh(); worker?.postMessage({ type: 'config', seed: S.seed, nonce: 0 }); configure(); save(); $('log').innerHTML = ''; render(); msg('Progress reset.');
  });

  // ---- share card
  function drawCard() {
    const c = $('card'), x = c.getContext('2d'), W = c.width, H = c.height;
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#0b0f1a'); g.addColorStop(1, '#1b2337'); x.fillStyle = g; x.fillRect(0, 0, W, H);
    x.fillStyle = '#151b2b'; x.beginPath(); x.roundRect(60, 60, 96, 96, 20); x.fill();
    x.strokeStyle = '#f5b301'; x.lineWidth = 11; x.lineCap = x.lineJoin = 'round'; x.beginPath(); x.moveTo(84, 84); x.lineTo(132, 84); x.lineTo(84, 132); x.lineTo(132, 132); x.stroke();
    x.fillStyle = '#e6e9f0'; x.font = '800 60px system-ui,sans-serif'; x.fillText('ZAK Miner', 184, 128);
    x.fillStyle = '#8f98ad'; x.font = '28px system-ui,sans-serif'; x.fillText('Real SHA-256 proof of work, in a browser', 184, 170);
    const stats = [['Hashes', big(S.hashes)], ['Best hash', S.best ? `${S.best.z} zeros` : '–'], ['Game ZAK earned', big(S.lifeZak)], ['Achievements', `${Object.keys(S.ach).length}/${ACH.length}`]];
    stats.forEach(([k, v], i) => { const X = 60 + i * 275; x.fillStyle = '#8f98ad'; x.font = '24px system-ui,sans-serif'; x.fillText(k, X, 290); x.fillStyle = '#e6e9f0'; x.font = '800 50px system-ui,sans-serif'; x.fillText(v, X, 350); });
    if (S.best) {
      x.font = '24px ui-monospace,Menlo,monospace'; const z = /^0*/.exec(S.best.hash)[0], rest = S.best.hash.slice(z.length, 44 - z.length) + '…';
      x.fillStyle = '#f5b301'; x.fillText(z, 60, 440); x.fillStyle = '#e6e9f0'; x.fillText(rest, 60 + x.measureText(z).width, 440);
      x.fillStyle = '#8f98ad'; x.font = '20px ui-monospace,Menlo,monospace'; x.fillText(`sha256("${input(S.best.seed, S.best.nonce)}")`, 60, 476);
    }
    x.fillStyle = '#8f98ad'; x.font = '22px system-ui,sans-serif'; x.fillText('Game ZAK is not real ZAK and has no value. The hashing is real.', 60, 570);
  }
  const shareText = () => `I've done ${big(S.hashes)} real SHA-256 hashes in ZAK Miner${S.best ? `, best hash ${S.best.z} zeros` : ''} ⛏️ (game ZAK has no value; the proof of work is real)`;
  const pageUrl = () => location.href.split('#')[0];
  const cardBlob = () => new Promise(r => { drawCard(); $('card').toBlob(r, 'image/png'); });
  $('share').addEventListener('click', async () => {
    try {
      const blob = await cardBlob(), file = new File([blob], 'zak-miner.png', { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) return await navigator.share({ files: [file], text: shareText(), url: pageUrl() });
      if (navigator.share) return await navigator.share({ text: shareText(), url: pageUrl() });
    } catch (e) { if (e?.name === 'AbortError') return; }
    copyText();
  });
  async function copyText() { try { await navigator.clipboard.writeText(shareText() + ' ' + pageUrl()); toast('Copied to the clipboard'); } catch { prompt('Copy this:', shareText() + ' ' + pageUrl()); } }
  $('copy').addEventListener('click', copyText);
  $('dl').addEventListener('click', async () => { const a = document.createElement('a'); a.href = URL.createObjectURL(await cardBlob()); a.download = 'zak-miner.png'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); });

  // ---- render
  function render() {
    const now = performance.now(); hist = hist.filter(h => now - h[0] < 3000); lastGain = lastGain.filter(h => now - h[0] < 10000);
    const span = hist.length > 1 ? (now - hist[0][0]) / 1000 : 0; rate = span > 0.5 ? hist.slice(1).reduce((s, h) => s + h[1], 0) / span : 0;
    if (running() && rate > 0) { S.lastRate = rate; S.bestRate = Math.max(S.bestRate, rate); }
    $('zak').textContent = big(S.zak);
    $('zps').textContent = `≈ ${big(rate * expectedPerHash())} / s expected · ×${mult().toFixed(2)} reward`;
    $('hr').textContent = S.paused ? 'off' : running() ? rateFmt(rate) : 'paused (tab hidden)';
    $('capnote').textContent = `cap ${rateFmt(cap())} · CPU limit ${Math.round(S.cpu * 100)}% of 1 core` + (running() && rate > 0 && rate < cap() * 0.85 ? ' · CPU-limited' : '');
    $('hc').textContent = big(S.hashes); $('hcrun').textContent = S.forks ? `${big(S.runHashes)} since last fork` : `nonce ${S.nonce.toLocaleString()}`;
    $('best').textContent = S.best ? `${S.best.z} zeros` : '–'; $('bestbits').textContent = S.best ? `${S.best.bits} zero bits` : 'no find yet';
    $('pause').textContent = S.paused ? (S.hashes ? 'Resume mining' : 'Start mining') : 'Pause mining';
    $('pause').className = S.paused ? 'btn' : 'btn ghost'; $('pause').setAttribute('aria-pressed', String(!S.paused));
    $('offnote').hidden = !S.paused;
    for (const k in UP) { const b = $('buy-' + k), c = cost(k); b.textContent = `${big(c)} ZAK`; b.disabled = S.zak < c; b.setAttribute('aria-label', `Buy ${UP[k].name} for ${big(c)} game ZAK`); $('own-' + k).textContent = S.up[k] ? `×${S.up[k]}` : ''; }
    const fg = forkGain();
    $('forktxt').innerHTML = `Reset game ZAK and upgrades for permanent fork points (+10% game ZAK per find each). You have <b>${S.forkPts}</b>. ` + (fg >= 1 ? `Forking now gives <b>${fg}</b>.` : `Earn ${big(1e6 - S.runZak)} more game ZAK this run to unlock.`);
    $('fork').disabled = fg < 1;
    $('findnote').textContent = `listing ${logFrom(Math.min(cap(), rate || cap()))}+ zeros; smaller finds still pay`;
    $('pb').innerHTML = [
      ['Best hash', S.best ? `${S.best.z} zeros · ${S.best.bits} bits<br><small class="mono">${showHash(S.best.hash.slice(0, 20))}…</small>` : '–'],
      ['Hashes, all time', S.hashes.toLocaleString()], ['Fastest rate seen', rateFmt(S.bestRate)], ['Game ZAK earned, all time', big(S.lifeZak)],
      ['Finds by zeros', Object.keys(S.counts).sort((a, b) => a - b).map(z => `${z}: ${S.counts[z].toLocaleString()}`).join(' · ') || '–'],
      ['Top 10 bits', S.top.map(f => f.bits).join(', ') || '–'], ['Time played', dur(S.playMs)], ['Hard forks', S.forks], ['Rig taps', S.taps.toLocaleString()],
    ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('') +
      (S.best ? `<tr><td colspan="2" style="text-align:left"><small>Check your best hash in a terminal:</small><br><code class="mono" style="font-size:12px;word-break:break-all">printf '%s' '${esc(input(S.best.seed, S.best.nonce))}' | sha256sum</code></td></tr>` : '');
  }
  function renderAch() {
    let fresh = false;
    for (const [id, name, , test] of ACH) if (!S.ach[id] && test(S)) { S.ach[id] = Date.now(); toast(`🏆 ${name}`); fresh = true; if (S.sound) beep(6); }
    $('ach').innerHTML = ACH.map(([id, name, desc]) => `<div class="${S.ach[id] ? 'got' : ''}" title="${esc(desc)}"><b>${S.ach[id] ? '🏆' : '🔒'} ${name}</b>${desc}</div>`).join('');
    $('achc').textContent = `${Object.keys(S.ach).length} / ${ACH.length}`;
    return fresh;
  }
  let lastTick = performance.now();
  setInterval(() => { const n = performance.now(); if (running()) S.playMs += n - lastTick; lastTick = n; render(); }, 250);
  setInterval(() => { renderAch(); configure(); save(); }, 2000);
  setInterval(drawCard, 5000);
  if (S.migrated) { delete S.migrated; toast('Your progress from the old version of ZAK Miner was carried over.'); }
  render(); renderAch(); drawCard();
})();
