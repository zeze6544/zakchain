// Single-block SHA-256 compression using Intel SHA extensions (based on Intel's public reference design).
#include <immintrin.h>
#include <stdint.h>
static const uint32_t K256[64] = {
0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
__attribute__((target("sha,sse4.1")))
static void sha256_block_shani(uint32_t state[8], const uint8_t data[64]) {
  __m128i STATE0, STATE1, MSG, TMP, MSG0, MSG1, MSG2, MSG3, ABEF_SAVE, CDGH_SAVE;
  const __m128i MASK = _mm_set_epi64x(0x0c0d0e0f08090a0bULL, 0x0405060700010203ULL);
  TMP = _mm_loadu_si128((const __m128i*)&state[0]);
  STATE1 = _mm_loadu_si128((const __m128i*)&state[4]);
  TMP = _mm_shuffle_epi32(TMP, 0xB1); STATE1 = _mm_shuffle_epi32(STATE1, 0x1B);
  STATE0 = _mm_alignr_epi8(TMP, STATE1, 8); STATE1 = _mm_blend_epi16(STATE1, TMP, 0xF0);
  ABEF_SAVE = STATE0; CDGH_SAVE = STATE1;
  __m128i M[4];
  for (int i = 0; i < 4; i++) M[i] = _mm_shuffle_epi8(_mm_loadu_si128((const __m128i*)(data + 16*i)), MASK);
  MSG0 = M[0]; MSG1 = M[1]; MSG2 = M[2]; MSG3 = M[3];
  for (int r = 0; r < 16; r++) {
    __m128i W = r == 0 ? MSG0 : r == 1 ? MSG1 : r == 2 ? MSG2 : MSG3;
    if (r >= 4) {
      // schedule: W_r = sha256msg2(sha256msg1(W_{r-4}, W_{r-3}) + alignr(W_{r-1}, W_{r-2}, 4), W_{r-1})
      __m128i a = MSG0, b = MSG1, c = MSG2, d = MSG3;
      __m128i t = _mm_add_epi32(_mm_sha256msg1_epu32(a, b), _mm_alignr_epi8(d, c, 4));
      W = _mm_sha256msg2_epu32(t, d);
      MSG0 = MSG1; MSG1 = MSG2; MSG2 = MSG3; MSG3 = W;
    }
    MSG = _mm_add_epi32(W, _mm_loadu_si128((const __m128i*)&K256[4*r]));
    STATE1 = _mm_sha256rnds2_epu32(STATE1, STATE0, MSG);
    MSG = _mm_shuffle_epi32(MSG, 0x0E);
    STATE0 = _mm_sha256rnds2_epu32(STATE0, STATE1, MSG);
  }
  STATE0 = _mm_add_epi32(STATE0, ABEF_SAVE); STATE1 = _mm_add_epi32(STATE1, CDGH_SAVE);
  TMP = _mm_shuffle_epi32(STATE0, 0x1B); STATE1 = _mm_shuffle_epi32(STATE1, 0xB1);
  STATE0 = _mm_blend_epi16(TMP, STATE1, 0xF0); STATE1 = _mm_alignr_epi8(STATE1, TMP, 8);
  _mm_storeu_si128((__m128i*)&state[0], STATE0); _mm_storeu_si128((__m128i*)&state[4], STATE1);
}
