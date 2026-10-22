# ZAK Chain: a blockchain you can read in ten minutes

## Why
Most blockchains are hundreds of thousands of lines. ZAK Chain is about 200, so anyone can read exactly how a coin, a block and consensus work, then run a node themselves.

## Ledger
All 1,000,000,000 ZAK are assigned in block 0. Balances are computed by replaying every block from genesis. A transfer is valid only if both addresses are the 88-character hex form of an Ed25519 SPKI public key, it is signed by the sender's key, the amount is a positive whole number, the sender can afford the amount plus its fee, and its nonce is exactly one more than the sender's last. No new ZAK is ever created: miners are paid the fees from the transfers they include, so the supply stays at exactly 1,000,000,000 forever.

## Blocks
Each block holds an index, the previous block's hash, a timestamp, its transactions and a nonce. The header hash is the hash of the index, the previous hash, the timestamp, the difficulty, the miner address, and a Merkle root of the transactions. Each leaf is the hash of one transaction. An odd node is paired with a copy of itself, so a block with one transfer still has a root, and an empty block hashes an empty list. The proof of work hashes just 40 bytes, that 32-byte header hash followed by an 8-byte big-endian nonce, so miners spend their time hashing rather than serialising JSON, and the native miner keeps a fixed-size input. Miners vary the nonce until that SHA-256 hash has at least the required number of leading zero bits. Every 10 blocks the network compares how long they took with the 10-second target and adjusts the difficulty by the base-2 log of how far off they were, up to 4 bits (16 times) per step, so block times stay steady as miners come and go. Because every block commits to the previous hash and to the Merkle root, changing any old transaction invalidates that block and every block after it.

A block holds at most 100 transactions. Among the spends whose nonce is the next one for that sender, the highest fee is included first. A high fee on a later nonce waits until the nonce in front of it is included.

## Mempool
A node keeps at most 1,024 pending transactions. When a new transaction would overflow the pool, the cheapest tail is dropped: the highest nonce of the sender who is offering the lowest fee at the end of their queue, so a sender is never left with a gap. After a reorg the whole pool is checked again against the new balances and nonces. A transaction that no longer signs, pays, or follows the sender's next nonce is discarded. One that still does is kept.

## Consensus
Nodes forward new transactions to their peers. When a node mines or adopts blocks, it broadcasts only the blocks it did not have before, not the whole chain. Peers that already have the parent append the suffix. Every five seconds a node also asks each peer with more total work for blocks from its own height. If that slice extends the local tip, it is applied directly. If it does not link, the node downloads that peer's full chain. A chain replaces the local one only when it shares the same genesis, passes full validation, and carries more total proof of work. Counting work instead of blocks stops an attacker from winning with a longer chain of easy blocks. A block that arrives without its parent starts the same full comparison, so a heavier fork is still found.

## Known limits
A deep fork still transfers the whole chain, and like every proof-of-work chain this one cannot stop a miner with more hash power than everyone else combined. Peer discovery is manual for now. Chains mined before the Merkle-root header commitment are rejected, because their header hashes no longer match.
