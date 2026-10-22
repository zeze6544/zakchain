// CLI: node wallet.mjs new <name> | send <name> <toAddress> <amount> [nodeUrl] | balance <address> [nodeUrl]
import fs from 'fs';
import { newWallet, signTx } from './zakchain.mjs';
const [cmd, a, b, c, d] = process.argv.slice(2);
fs.mkdirSync('wallets', { recursive: true, mode: 0o700 });
const load = n => JSON.parse(fs.readFileSync(`wallets/${n}.json`));
if (cmd === 'new') { const w = newWallet(); fs.writeFileSync(`wallets/${a}.json`, JSON.stringify(w), { mode: 0o600 }); console.log(w.address); }
if (cmd === 'balance') console.log(await (await fetch(`${b || 'http://localhost:7001'}/balance?address=${a}`)).json());
if (cmd === 'send') {
  const w = load(a), node = d || 'http://localhost:7001';
  const { nonce } = await (await fetch(`${node}/balance?address=${w.address}`)).json();
  const pending = (await (await fetch(`${node}/info`)).json()).pending;
  const r = await fetch(`${node}/tx`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signTx(w, b, +c, nonce + 1, +(process.env.FEE || 1))) });
  console.log(await r.json());
}
