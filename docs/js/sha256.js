// Small synchronous SHA-256 (FIPS 180-4) for ASCII/UTF-8 strings. Used by the ZAK Miner worker and the
// "How it works" demo so hashing can run in tight loops; results are cross-checked against crypto.subtle.
(function (root) {
  'use strict';
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  const W = new Uint32Array(64), H = new Uint32Array(8), HEX = [];
  for (let i = 0; i < 256; i++) HEX[i] = (i < 16 ? '0' : '') + i.toString(16);
  const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  let buf = new Uint8Array(128);

  function digestBytes(bytes, len) {
    const total = ((len + 9 + 63) >> 6) << 6;
    if (buf.length < total) buf = new Uint8Array(total * 2);
    buf.fill(0, 0, total); buf.set(bytes.subarray(0, len)); buf[len] = 0x80;
    const bits = len * 8; buf[total - 4] = bits >>> 24; buf[total - 3] = bits >>> 16; buf[total - 2] = bits >>> 8; buf[total - 1] = bits;
    if (len >= 0x20000000) { const hi = Math.floor(len / 0x20000000); buf[total - 8] = hi >>> 24; buf[total - 7] = hi >>> 16; buf[total - 6] = hi >>> 8; buf[total - 5] = hi; }
    H[0] = 0x6a09e667; H[1] = 0xbb67ae85; H[2] = 0x3c6ef372; H[3] = 0xa54ff53a; H[4] = 0x510e527f; H[5] = 0x9b05688c; H[6] = 0x1f83d9ab; H[7] = 0x5be0cd19;
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) { const j = off + i * 4; W[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3]; }
      for (let i = 16; i < 64; i++) {
        const a = W[i - 15], b = W[i - 2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return H;
  }
  function toHex(h) { let s = ''; for (let i = 0; i < 8; i++) { const v = h[i]; s += HEX[v >>> 24] + HEX[(v >>> 16) & 255] + HEX[(v >>> 8) & 255] + HEX[v & 255]; } return s; }
  function sha256(str) { const b = enc.encode(str); return toHex(digestBytes(b, b.length)); }
  // Leading zero bits of a digest state, without building the hex string (fast path for mining loops).
  function zeroBitsOf(h) { let n = 0; for (let i = 0; i < 8; i++) { if (h[i] === 0) { n += 32; continue; } return n + Math.clz32(h[i]); } return n; }
  root.ZakSHA = { sha256, digestBytes, toHex, zeroBitsOf, zeroBits: hex => { let n = 0; for (const c of hex) { const v = parseInt(c, 16); if (v === 0) { n += 4; continue; } return n + Math.clz32(v) - 28; } return n; } };
})(typeof self !== 'undefined' ? self : globalThis);
