# ZAK Chain

A tiny, readable proof-of-work blockchain written from scratch in plain Node.js. No dependencies.

- **Fixed supply:** exactly 1,000,000,000 ZAK, created in the genesis block. Nothing can ever mint more.
- **Signed transfers:** every transaction is signed with an Ed25519 key, with per-wallet nonces to stop replays.
- **Merkle root:** the header hash commits to a Merkle root of the transactions. Changing any transaction changes that root, the header hash, and the proof of work.
- **Proof of work:** SHA-256 over exactly 40 bytes — the 32-byte header hash plus an 8-byte big-endian nonce — with automatic difficulty adjustment toward a 10-second block time.
- **Miners earn fees:** each transfer carries a fee paid to the miner, so the supply never grows. A block packs the highest fees that can be included (up to 100), and a later nonce is never mined ahead of the one before it.
- **Mempool:** nodes keep at most 1,024 pending transactions, drop the cheapest tail when the pool is full, and recheck the pool after a reorg so spends that no longer pay are discarded.
- **Peer-to-peer:** nodes gossip transactions and new blocks. A peer is asked for blocks from the height we already have. When those blocks do not extend our tip, the node downloads that peer's full chain and adopts it only if it is valid and has more total work.
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
Browsers can read GET responses. POST is not offered to cross-origin pages.

## Wallet

```bash
node wallet.mjs new alice                        # prints your address
node wallet.mjs balance <address> http://localhost:7001
FEE=1 node wallet.mjs send alice <toAddress> 100 http://localhost:7001
ALLOW_MINE=1 PORT=7001 node node.mjs              # /mine is off unless this flag is set
curl -X POST 'http://127.0.0.1:7001/mine?miner=<address>'   # localhost only; fees go to <address>
```

## Node API

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/info` | Height, tip hash, pending count, validity, peers |
| GET | `/chain` | Full chain, used when a fork has to be resolved by total work |
| GET | `/blocks?from=` | Blocks from that height (inclusive) through the tip |
| GET | `/balance?address=` | Balance and nonce |
| GET | `/pending` | Transactions waiting to be mined |
| POST | `/tx` | Submit a signed transaction |
| POST | `/mine` | Mine pending transactions. Off unless `ALLOW_MINE=1`, and only from localhost. The search runs off the request thread. |
| POST | `/block` | Offer one new block, a connected suffix, or a full chain. Bodies over 256 KiB are refused. |

## Tests

```bash
node test.mjs          # chain rules
node test-miner.mjs    # miner consent, limits, clean shutdown (uses a private mock node)
```

## Status

Experimental and educational. ZAK has no monetary value and is not listed on any exchange. Not investment advice.

## Licence

MIT
