# ZAK Chain: a blockchain you can read in ten minutes

## Why
Most blockchains are hundreds of thousands of lines. ZAK Chain is about 200, so anyone can read exactly how a coin, a block and consensus work, then run a node themselves.

## Ledger
All 1,000,000,000 ZAK are assigned in block 0. Balances are computed by replaying every block from genesis. A transfer is valid only if it is signed by the sender's Ed25519 key, the amount is a positive whole number, the sender can afford the amount plus its fee, and its nonce is exactly one more than the sender's last. No new ZAK is ever created: miners are paid the fees from the transfers they include, so the supply stays at exactly 1,000,000,000 forever.

## Blocks
Each block holds an index, the previous block's hash, a timestamp, its transactions and a nonce. The proof of work hashes just 40 bytes, the 32-byte hash of the block header followed by an 8-byte nonce, so miners spend their time hashing rather than serialising JSON, and native or hardware miners are easy to write. Miners vary the nonce until that SHA-256 hash has at least the required number of leading zero bits. Every 10 blocks the network compares how long they took with the 10-second target and adjusts the difficulty by the base-2 log of how far off they were, up to 4 bits (16 times) per step, so block times stay steady as miners come and go. Because every block commits to the previous hash, changing any old transaction invalidates every block after it.

## Consensus
Nodes forward new transactions and blocks to their peers and poll them every five seconds. A node switches to a peer's chain only if it shares the same genesis, passes full validation, and carries more total proof of work. Counting work instead of blocks stops an attacker from winning with a longer chain of easy blocks.

## Known limits
Nodes send the whole chain when syncing, which will not scale far, and like every proof-of-work chain it cannot stop a miner with more hash power than everyone else combined. Peer discovery is manual for now.
