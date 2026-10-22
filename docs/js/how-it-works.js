// Interactive "How it works" demos. All hashing is real SHA-256 (js/sha256.js), cross-checked with crypto.subtle.
(() => {
  'use strict';
  const $ = id => document.getElementById(id), { sha256, zeroBits } = self.ZakSHA;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const showHash = h => { const z = /^0*/.exec(h)[0]; return `<span class="z">${z}</span>${h.slice(z.length)}`; };
  const fmt = n => n.toLocaleString();

  // 1. Hashing
  async function hashDemo() {
    const s = $('h-in').value, h = sha256(s); $('h-out').innerHTML = showHash(h);
    try {
      const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
      const ref = [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
      $('h-check').innerHTML = ref === h ? '<span class="ok">✓</span> Matches your browser\'s built-in crypto.subtle SHA-256. Check it yourself: <code>printf \'%s\' \'' + esc(s.replace(/'/g, "'\\''")) + '\' | sha256sum</code>' : '<span class="bad">Mismatch with crypto.subtle</span>';
    } catch { $('h-check').textContent = ''; }
  }
  $('h-in').addEventListener('input', hashDemo); hashDemo();

  // 2. Mining
  let mining = null;
  const bitsEl = $('m-bits'), upd = () => { $('m-bitsv').textContent = bitsEl.value; $('m-exp').textContent = fmt(2 ** +bitsEl.value); };
  bitsEl.addEventListener('input', upd); upd();
  $('m-go').addEventListener('click', () => {
    if (mining) { mining.stop = true; return; }
    const data = $('m-data').value, bits = +bitsEl.value, t0 = performance.now(); let nonce = 0;
    mining = { stop: false }; const job = mining; $('m-go').textContent = 'Stop';
    const step = () => {
      const end = performance.now() + 30;
      while (performance.now() < end) {
        for (let k = 0; k < 500; k++, nonce++) {
          const h = sha256(data + nonce);
          if (zeroBits(h) >= bits) {
            const ms = performance.now() - t0;
            $('m-input').textContent = `"${data}${nonce}"`; $('m-out').innerHTML = showHash(h);
            $('m-stat').innerHTML = `<span class="ok">Found it.</span> Nonce ${fmt(nonce)} after ${fmt(nonce + 1)} tries in ${(ms / 1000).toFixed(2)} s (${fmt(Math.round((nonce + 1) / ms * 1000))} hashes/s). ${zeroBits(h)} leading zero bits.`;
            mining = null; $('m-go').textContent = 'Mine'; return;
          }
        }
      }
      if (job.stop) { $('m-stat').textContent = `Stopped after ${fmt(nonce)} tries.`; mining = null; $('m-go').textContent = 'Mine'; return; }
      $('m-input').textContent = `"${data}${nonce}"`; $('m-out').innerHTML = showHash(sha256(data + nonce));
      $('m-stat').textContent = `Trying… ${fmt(nonce)} hashes so far`; setTimeout(step, 0);
    };
    step();
  });

  // 3. Chain
  const BITS = 12, N = 4, chain = [];
  const hashBlock = b => sha256(JSON.stringify([b.index, b.prev, b.data, b.nonce]));
  const mineBlock = b => { b.nonce = 0; while (zeroBits(hashBlock(b)) < BITS) b.nonce++; };
  ['Genesis: 1,000,000,000 ZAK to the founder', 'Founder pays Alice 50', 'Alice pays Bob 10', 'Bob pays Carol 3'].forEach((data, i) => {
    const b = { index: i, prev: i ? hashBlock(chain[i - 1]) : '0'.repeat(64), data, nonce: 0 }; mineBlock(b); chain.push(b);
  });
  function drawChain(focus) {
    let broken = false;
    $('blocks').innerHTML = chain.map((b, i) => {
      const h = hashBlock(b), linkOk = i === 0 || b.prev === hashBlock(chain[i - 1]), workOk = zeroBits(h) >= BITS;
      const own = !linkOk || !workOk, inherited = broken && !own; broken = broken || own;
      return `<div class="blk${broken ? ' broken' : ''}"><h3>Block #${i} <span>${own ? '<span class="bad">✗ invalid</span>' : inherited ? '<span class="bad" title="Its own hash is fine, but it builds on a broken block">✗ on a broken chain</span>' : '<span class="ok">✓ valid</span>'}</span></h3>
      <label for="d${i}">Data</label><textarea id="d${i}" data-i="${i}" rows="2">${esc(b.data)}</textarea>
      <label>Previous hash ${linkOk ? '' : '<span class="bad">(doesn\'t match block #' + (i - 1) + ')</span>'}</label><div class="hash">${showHash(b.prev)}</div>
      <label>Nonce</label><div class="hash">${fmt(b.nonce)}</div>
      <label>Hash ${workOk ? '' : '<span class="bad">(not enough zeros)</span>'}</label><div class="hash">${showHash(h)}</div>
      ${own ? `<button class="btn ghost" data-remine="${i}" style="font-size:13px;padding:6px 12px">Re-mine #${i}</button>` : ''}</div>`;
    }).join('');
    if (focus) { const el = $('d' + focus.i); el.focus(); el.setSelectionRange(focus.pos, focus.pos); }
  }
  $('blocks').addEventListener('input', e => { const i = +e.target.dataset.i; if (isNaN(i)) return; chain[i].data = e.target.value; drawChain({ i, pos: e.target.selectionStart }); });
  $('blocks').addEventListener('click', e => {
    const i = e.target.dataset.remine; if (i === undefined) return;
    const b = chain[+i]; if (+i > 0) b.prev = hashBlock(chain[+i - 1]); mineBlock(b); drawChain();
  });
  drawChain();

  // 4. Replay / double-spend toy ledger
  let L;
  const reset = () => { L = { bal: { Alice: 50, Bob: 0, Miner: 0 }, nonce: { Alice: 0, Bob: 0 }, last: null }; $('rlog').innerHTML = ''; drawL(); };
  const drawL = () => { $('r-a').textContent = L.bal.Alice + ' ZAK'; $('r-an').textContent = L.nonce.Alice; $('r-b').textContent = L.bal.Bob + ' ZAK'; $('r-m').textContent = L.bal.Miner + ' ZAK'; };
  function submit(t) {
    let why = '';
    if (t.signedBy !== t.from) why = `signature check failed: signed by ${t.signedBy}, not ${t.from}`;
    else if (t.nonce !== L.nonce[t.from] + 1) why = `bad nonce: expected ${L.nonce[t.from] + 1}, got ${t.nonce} (replay?)`;
    else if (L.bal[t.from] < t.amount + t.fee) why = `overspend: ${t.from} has ${L.bal[t.from]} ZAK, needs ${t.amount + t.fee}`;
    const line = `${t.from} → ${t.to} ${t.amount} ZAK, fee ${t.fee}, nonce ${t.nonce}, signed by ${t.signedBy}`;
    if (why) $('rlog').insertAdjacentHTML('afterbegin', `<div><span class="bad">✗ rejected</span> ${esc(line)}<br><span class="muted">${esc(why)}</span></div>`);
    else {
      L.bal[t.from] -= t.amount + t.fee; L.bal[t.to] += t.amount; L.bal.Miner += t.fee; L.nonce[t.from] = t.nonce; L.last = t;
      $('rlog').insertAdjacentHTML('afterbegin', `<div><span class="ok">✓ accepted</span> ${esc(line)}</div>`);
    }
    drawL();
  }
  $('r-send').onclick = () => submit({ from: 'Alice', to: 'Bob', amount: 10, fee: 1, nonce: L.nonce.Alice + 1, signedBy: 'Alice' });
  $('r-replay').onclick = () => L.last ? submit({ ...L.last }) : $('rlog').insertAdjacentHTML('afterbegin', '<div class="muted">Send a transfer first, then replay it.</div>');
  $('r-over').onclick = () => submit({ from: 'Alice', to: 'Bob', amount: 1000, fee: 1, nonce: L.nonce.Alice + 1, signedBy: 'Alice' });
  $('r-forge').onclick = () => submit({ from: 'Alice', to: 'Bob', amount: 20, fee: 1, nonce: L.nonce.Alice + 1, signedBy: 'Bob' });
  $('r-reset').onclick = reset; reset();
})();
