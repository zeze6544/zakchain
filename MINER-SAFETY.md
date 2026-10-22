# ZAK miner safety

This page covers what the ZAK miner (`miner.mjs` + optional `native/zakminer`) does, how you consent to it,
which limits it obeys, how to remove it, and how to check what you are running.

> **ZAK has no cash value.** Mining earns no money and carries no promise of returns. It is a hobby project.

## 1. Purpose and scope

- **Why mining exists:** ZAK Chain is proof-of-work. Someone has to find blocks so transfers get confirmed and
  the chain grows. Miners earn only the fees in the blocks they win; no new coins are ever created.
- **Algorithm:** SHA-256 over 40 bytes (32-byte header hash + 8-byte big-endian nonce). A block is valid when
  the hash has at least `bits` leading zero bits. `bits` retargets every 10 blocks toward 10 s per block.
- **Engines:** native C (`native/zakminer`, uses CPU SHA extensions when present) or pure JavaScript worker
  threads. **There is no GPU miner.** GPU mining is out of scope.
- **What the miner talks to:** only the node URL you pass in (`GET /chain`, `GET /pending`, `GET /info`,
  `POST /block`). No analytics, no update checks, no other hosts.
- **Out of scope:** browser/website mining, background or bundled mining, mining on someone else's machine, mining
  pools, any "earnings" claims.

### Invariants (what must always hold, with the test that checks it)

| # | Invariant | Checked by (`node test-miner.mjs`) |
| --- | --- | --- |
| I1 | No hashing, no child process, no network request before consent | "refuses to start without --i-understand…" (mock node sees 0 requests, exit 2) |
| I2 | Anything other than `yes` (or `--i-understand`) means no start | "typing anything other than yes…" |
| I3 | Default 1 thread; never more threads than the OS reports cores | "default is 1 thread; --threads is capped…" |
| I4 | `--max-minutes` ends the run by itself | "--max-minutes stops the miner on its own" |
| I5 | Ctrl+C / SIGTERM leaves no child process, also while paused | "SIGTERM leaves no child processes…", "Ctrl+C (SIGINT)…" |
| I6 | If `miner.mjs` is killed hard, the native engine exits too (no orphan) | "if miner.mjs is SIGKILLed…" |
| I7 | `--max-cpu` keeps measured CPU near threads × PCT% of a core | "--max-cpu duty cycle…" (measured 48–50% for 2 × 25%) |
| I8 | Network only to the given node; no persistence/autostart code | "only talks to the node URL…" (static check) |
| I9 | `--version` hashes match the files on disk | "--version reports SHA-256…" |

## 2. Consent (off by default)

Nothing mines unless you start it yourself. On start the miner prints a plain-language notice: what it does,
that ZAK has no value, how much CPU it will use, auto-stop, which node it contacts, that it collects no data,
that nothing is installed, and how to stop or pause it. Then:

- in a terminal it asks you to type `yes`; anything else quits (exit code 2);
- in a non-interactive shell it **refuses** unless you pass `--i-understand` (exit code 2).

## 3. Limits and controls

| Control | Default | Notes |
| --- | --- | --- |
| `--threads N` | **1** | Capped at the number of CPU cores; values < 1 or non-integers are rejected |
| `--max-cpu PCT` | 100 | Duty cycle: each 1 s, threads hash PCT% of the time and are paused (SIGSTOP / worker pause) for the rest. Total ≈ threads × PCT% of one core |
| `--max-minutes M` | off | Clean stop after M minutes |
| Battery | pause | Pauses while on battery (Linux `/sys/class/power_supply`); `--allow-battery` overrides |
| Temperature | 90 °C | Pauses while any `/sys/class/thermal` sensor is above `--max-temp`, resumes 5 °C below |
| Pause/resume | | `kill -USR1 <pid>` toggles (pid is printed at start). Ctrl+Z also suspends everything |
| Stop | | Ctrl+C, `kill <pid>`, or SIGHUP (closing the terminal). Child engine is SIGKILLed and reaped first |

Battery and temperature readings are used only for these decisions. They are never stored or sent.

## 4. Telemetry (local only)

Every `--status-seconds` (default 10) the miner prints one line to **your terminal only**:

```
[status] up 0:00:12 | native | threads 2/8 | cpu cap 25% duty | cpu used 49% of 1 core (6% of machine) | 52.10 MH/s (avg 51.00) | blocks won 0 | mining (duty cycle)
```

"cpu used" is measured (`/proc/<pid>/stat` for the native engine, `process.cpuUsage()` for JS), not estimated.
Nothing is written to disk and nothing is sent to the node except the blocks you find.

## 5. Install and removal

- **Install:** `git clone` (or download) the folder. Optionally build the native engine (below). That's all.
- The miner installs **no service, no cron job, no login item, no autostart**, writes no config or data
  files, and does not detach from your terminal. It runs only while you run it.
- **Uninstall:** stop the miner (Ctrl+C), then delete the folder. To remove only the native engine:
  `rm native/zakminer native/zakminer.sha256`. Check nothing is left: `pgrep -af 'zakminer|miner.mjs'` prints nothing.
- **Version check:** `node miner.mjs --version` prints the package version and the SHA-256 of `miner.mjs` and
  `native/zakminer`.

## 6. Build provenance

```bash
sh native/build.sh                 # gcc -O3 -march=native ... ; prints and saves SHA-256 of sources + binary
(cd native && sha256sum -c zakminer.sha256)
node miner.mjs --version           # same hashes as above
```

- Read `native/zakminer.c` and `native/shani.h` before building (~100 lines). The binary never forks, opens no
  sockets, and exits if its parent dies (`PR_SET_PDEATHSIG` + `getppid()` watchdog).
- `-march=native` binaries differ between CPUs/compilers, so binary hashes only match on identical setups. The
  source hashes are the stable thing to compare.
- **Open item: signed release builds are not done yet.** There are no official binaries. Signing needs a
  human-held key (e.g. a maintainer's GPG or minisign/sigstore identity) and a human decision on the release
  process. Until then, build from source and verify the source hashes against the published repository.

## 7. Threat model (short)

| Risk | Mitigation | Status |
| --- | --- | --- |
| Miner started without the user knowing (bundling, scripts) | Consent gate, refuse in non-TTY without flag, visible banner and pid | Done |
| Runaway CPU / heat / battery | 1 thread default, core cap, duty cycle, temp/battery pause, auto-stop | Done (no GPU, no laptop power API beyond Linux sysfs) |
| Orphaned hashing process | SIGKILL + reap on stop; PDEATHSIG + getppid watchdog in C | Done (Linux; on macOS only the getppid watchdog applies) |
| Tampered binary | Build from source, SHA-256 checks, `--version` | Partial: no signatures yet |
| Data leakage | No network except chosen node; no data collection | Done (static test) |
| Rogue node | Miner only reads chain data and posts blocks; it never sends keys (it only needs an address) | Done |

## 8. Operator runbook

- Start (example): `node miner.mjs <address> http://localhost:7001 --threads 2 --max-cpu 50 --max-minutes 30`
- Watch: the `[status]` line. If "cpu used" is far above threads × cap, stop with Ctrl+C and report it.
- Stop / roll back: Ctrl+C. To roll back the miner code, restore the previous `miner.mjs` and `native/` from git.
- Safe stop condition: any unexpected process, network destination, or CPU above the cap → stop and delete the folder.
