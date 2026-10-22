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

The miner is **off by default**. It shows what it will do and only starts after you type `yes` (or pass
`--i-understand`). It uses **1 thread** unless you ask for more, talks only to the node you name, prints its
status locally, installs nothing, and stops cleanly with Ctrl+C. Uninstall = delete the folder.
Full details: [MINER-SAFETY.md](MINER-SAFETY.md).

```bash
sh native/build.sh      # optional native engine (~50x faster, uses Intel/AMD SHA extensions); prints SHA-256
node miner.mjs <yourAddress> http://localhost:7001                                  # asks for "yes", 1 thread
node miner.mjs <yourAddress> http://localhost:7001 --threads 2 --max-cpu 50 --max-minutes 30 --i-understand
node miner.mjs --help   # all limits: --threads, --max-cpu, --max-minutes, --allow-battery, --max-temp, --engine
```

Pause/resume with `kill -USR1 <pid>` (the pid is printed at start). Without the native build the miner falls back
to JavaScript worker threads. Nodes save their chain to `data/` and resume after a restart.

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
node test.mjs          # chain rules
node test-miner.mjs    # miner consent, limits, clean shutdown (uses a private mock node)
```

## Status

Experimental and educational. ZAK has no monetary value and is not listed on any exchange. Not investment advice.

## Licence

MIT
