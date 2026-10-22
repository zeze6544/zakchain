// ZAK native miner: zakminer <headerHashHex> <bits> <threads> <startNonce>
// Hashes sha256(header32 || nonce_be64) on every thread until one has >= bits leading zero bits.
// Prints "FOUND <nonce> <hashHex>" or periodic "RATE <hashes>" lines on stdout.
// Safety: this binary is only ever started by miner.mjs. It never forks, installs nothing, opens no network
// sockets, and exits by itself if its parent dies (PR_SET_PDEATHSIG on Linux plus a getppid() watchdog), so a
// crashed or killed miner.mjs cannot leave an orphaned hashing process behind.
#include <openssl/sha.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#ifdef __linux__
#include <sys/prctl.h>
#endif
#include "shani.h"
static const uint32_t IV[8]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
static int use_shani;

static unsigned char header[32];
static int bits, threads;
static uint64_t start;
static atomic_int done;
static atomic_ullong total;

static int lz(const unsigned char *h) {
  int n = 0;
  for (int i = 0; i < 32; i++) { if (h[i] == 0) { n += 8; continue; } return n + __builtin_clz(h[i]) - 24; }
  return n;
}
static void *work(void *arg) {
  long id = (long)arg;
  unsigned char msg[64] = {0}, out[32];
  memcpy(msg, header, 32);
  msg[40] = 0x80; msg[62] = 0x01; msg[63] = 0x40;   // SHA-256 padding for a 40-byte (320-bit) message
  uint64_t local = 0;
  for (uint64_t n = start + id; !atomic_load_explicit(&done, memory_order_relaxed); n += threads) {
    for (int i = 0; i < 8; i++) msg[32 + i] = (unsigned char)(n >> (56 - 8 * i));
    if (use_shani) {
      uint32_t st[8]; memcpy(st, IV, 32); sha256_block_shani(st, msg);
      for (int i = 0; i < 8; i++) { out[4*i] = st[i] >> 24; out[4*i+1] = st[i] >> 16; out[4*i+2] = st[i] >> 8; out[4*i+3] = st[i]; }
    } else SHA256(msg, 40, out);
    if (++local == 65536) { atomic_fetch_add(&total, local); local = 0; }
    if (lz(out) >= bits && !atomic_exchange(&done, 1)) {
      printf("FOUND %llu ", (unsigned long long)n);
      for (int i = 0; i < 32; i++) printf("%02x", out[i]);
      printf("\n"); fflush(stdout);
    }
  }
  atomic_fetch_add(&total, local);
  return NULL;
}
int main(int argc, char **argv) {
  if (argc < 5 || strlen(argv[1]) != 64) { fprintf(stderr, "usage: zakminer <headerHashHex> <bits> <threads> <startNonce>\n"); return 1; }
  for (int i = 0; i < 32; i++) sscanf(argv[1] + 2 * i, "%2hhx", &header[i]);
  bits = atoi(argv[2]); threads = atoi(argv[3]); start = strtoull(argv[4], NULL, 10);
  pid_t parent = getppid();
#ifdef __linux__
  prctl(PR_SET_PDEATHSIG, SIGKILL);
  if (getppid() != parent) return 1;   // parent already gone before prctl took effect
#endif
  __builtin_cpu_init(); use_shani = getenv("ZAK_NO_SHANI") ? 0 : 1;
  { unsigned a,b,c,d; __asm__("cpuid":"=a"(a),"=b"(b),"=c"(c),"=d"(d):"a"(7),"c"(0)); if (!(b & (1u<<29))) use_shani = 0; }
  pthread_t t[256]; if (threads < 1 || threads > 256) threads = 1;
  for (long i = 0; i < threads; i++) pthread_create(&t[i], NULL, work, (void *)i);
  while (!atomic_load(&done)) {
    for (int i = 0; i < 10 && !atomic_load(&done); i++) { usleep(100000); if (getppid() != parent) _exit(0); }
    printf("RATE %llu\n", (unsigned long long)atomic_exchange(&total, 0)); fflush(stdout); }
  for (int i = 0; i < threads; i++) pthread_join(t[i], NULL);
  return 0;
}
