# ZAK Chain

A tiny, readable proof-of-work blockchain written from scratch in plain Node.js. No dependencies.

- **Fixed supply:** exactly 1,000,000,000 ZAK, created in the genesis block. Nothing can ever mint more.
- **Signed transfers:** every transaction is signed with an Ed25519 key, with per-wallet nonces to stop replays.
- **Proof of work:** SHA-256 blocks with automatic difficulty adjustment toward a 10-second block time.
- **Miners earn fees:** each transfer carries a fee paid to the miner, so the supply never grows.
- **Peer-to-peer:** nodes gossip transactions and blocks, and adopt the valid chain with the most total work.
- **Tamper-evident:** edit any old block and every honest node rejects the chain.

## Run a node

Requires Node.js 20+.

```bash
git clone <repo-url> zakchain && cd zakchain
PORT=7001 PEERS=http://<peer-host>:7001 node node.mjs
```

## Mine

> **ZAK has no cash value.** Mining it earns no money, and nobody promises any returns. It is an open-source hobby project.

```bash
# optional native engine (~50x faster, uses Intel/AMD SHA extensions when present)
gcc -O3 -march=native -pthread -o native/zakminer native/zakminer.c -lcrypto
node miner.mjs <yourAddress> http://localhost:7001        # all CPU cores, live MH/s
```

Without the native build the miner falls back to JavaScript worker threads. Nodes save their chain to `data/` and resume after a restart.

## Wallet

```bash
node wallet.mjs new alice                        # prints your address
node wallet.mjs balance <address> http://localhost:7001
FEE=1 node wallet.mjs send alice <toAddress> 100 http://localhost:7001
curl -X POST 'http://localhost:7001/mine?miner=<address>'   # mine pending transfers, fees go to <address>
```

## Node API

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/info` | Height, tip hash, pending count, validity, peers |
| GET | `/chain` | Full chain |
| GET | `/balance?address=` | Balance and nonce |
| POST | `/tx` | Submit a signed transaction |
| POST | `/mine` | Mine pending transactions |
| POST | `/block` | Offer a chain from a peer |

## Tests

```bash
node test.mjs
```

## Status

Experimental and educational. ZAK has no monetary value and is not listed on any exchange. Not investment advice.

## Licence

MIT
