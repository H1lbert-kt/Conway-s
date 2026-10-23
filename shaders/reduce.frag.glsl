#version 300 es
// Stage 14 (?exp=physics): reduction chain for the global rule-mass
// parameter (issue #15). GPU-only — nothing ever reads back (rule 4);
// sim.frag samples the two 1x1 results as uPhysSum/uPhysCount.
// Blocks are powers of two (grid sizes are powers of two, midW = min(size,128)),
// so the three passes below are exact in uint32:
//   mode 0: src = state texture, out (midW x midW) = count16 | sum16
//           count16 = living cells in the block, sum16 = sum of popcount18
//           over the living cells' 18 rule bits (max 32^2 * 18 < 65536).
//   mode 1: src = mid, out (1x1) = sum32  (RGBA8 little-endian).
//   mode 2: src = mid, out (1x1) = count32 (RGBA8 little-endian).
// All bytes travel as float/255 through RGBA8, decoded with byteOf() —
// round-trips exactly (v/255 stored in 8 bits returns v).
precision highp float;
uniform sampler2D uSrc;
uniform int uSrcSize; // side of the src texture (state: size, mid: midW)
uniform int uBlock;   // src cells per output pixel (A: blockW, B: midW)
uniform int uMode;    // 0 state->mid, 1 mid->sum1x1, 2 mid->count1x1
out vec4 out4;

int byteOf(float f) { return int(f * 255.0 + 0.5); }

// popcount over 18 bits (GLSL ES 3.00 has no bitCount): nibble LUT.
int popcount18(uint v) {
  const int lut[16] = int[16](0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4);
  int c = 0;
  for (int i = 0; i < 5; i++) {
    c += lut[v & 15u];
    v >>= 4;
  }
  return c;
}

void main() {
  ivec2 o = ivec2(gl_FragCoord.xy);
  ivec2 base = o * uBlock;
  uint cnt = 0u;
  uint sum = 0u;
  for (int dy = 0; dy < uBlock; dy++) {
    for (int dx = 0; dx < uBlock; dx++) {
      ivec2 q = base + ivec2(dx, dy);
      if (q.x >= uSrcSize || q.y >= uSrcSize) continue;
      vec4 s = texelFetch(uSrc, q, 0);
      if (uMode == 0) {
        if ((byteOf(s.r) & 1) == 1) {
          cnt += 1u;
          uint rule = uint(byteOf(s.g)) | (uint(byteOf(s.b)) << 8)
            | ((uint(byteOf(s.a)) & 3u) << 16);
          sum += uint(popcount18(rule));
        }
      } else {
        cnt += uint(byteOf(s.r)) | (uint(byteOf(s.g)) << 8);
        sum += uint(byteOf(s.b)) | (uint(byteOf(s.a)) << 8);
      }
    }
  }
  uint v0;
  uint v1;
  uint v2;
  uint v3;
  if (uMode == 0) {
    v0 = cnt & 255u; v1 = (cnt >> 8) & 255u;
    v2 = sum & 255u; v3 = (sum >> 8) & 255u;
  } else if (uMode == 1) {
    v0 = sum & 255u; v1 = (sum >> 8) & 255u;
    v2 = (sum >> 16) & 255u; v3 = (sum >> 24) & 255u;
  } else {
    v0 = cnt & 255u; v1 = (cnt >> 8) & 255u;
    v2 = (cnt >> 16) & 255u; v3 = (cnt >> 24) & 255u;
  }
  out4 = vec4(float(v0) / 255.0, float(v1) / 255.0,
              float(v2) / 255.0, float(v3) / 255.0);
}
