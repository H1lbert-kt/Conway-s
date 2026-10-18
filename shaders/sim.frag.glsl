#version 300 es
// Per-cell rules (stage 7) + mutation/lineage (stage 8). Byte layout:
//   R = (age << 1) | alive   — age = consecutive alive generations, saturates at 127
//   G = birth mask   (bit n = born with n neighbors);     n==8 lives in A bit0
//   B = survival mask (bit n = survives with n neighbors); n==8 lives in A bit1
//   A = bit0 born with 8, bit1 survives with 8, bits2-7 lineage id (0 = classic)
// Genome pack (24 bits, lineage included): G | B<<8 | A<<16.
// On birth the cell inherits the full pack of the hash(x,y,gen,seed)-th living
// neighbor in fixed scan order (dy,dx ascending); fallback = its own stored
// genome (births with no living neighbors). Conway masks everywhere make this
// bit-exact vs the old hardcoded B3/S23 expression (golden tests unchanged).
// Mutation (stage 8, uMutBp = ?mut= in basis points, 0 = off): the same hash
// decides via fixed-point h % 10000 < uMutBp; one of the 18 rule bits (domain
// 0..17) flips at bit (h/10000)%18 and, since XOR always changes the pack, the
// newborn gets a fresh lineage id 1+((h>>9)%63) in A bits2-7. Survivors and
// stamped cells never change id; all-id-0 worlds are bit-exact stage 7.
// Hash (mirrored bit-for-bit in tests/run.js hashCell):
//   h  = seed
//   h ^= x * 374761393;      h  = (h ^ (h >> 13)) * 1274126177
//   h ^= y * 2654435761;     h  = (h ^ (h >> 16)) * 2246822519
//   h ^= gen * 3266489917;   h  = (h ^ (h >> 15)) * 3266489917
//   h ^= h >> 16
// Toroidal grid: neighbors wrap with integer modulo.
precision highp float;
uniform sampler2D uState;
uniform int uSize;
uniform int uWrap; // always 1 (toroidal); no non-wrapping path yet
uniform int uGen;  // generation this step computes from (hash input)
uniform uint uSeed; // hash seed (?seed= wiring, stage 8)
uniform int uMutBp; // mutation in basis points (0..10000 from ?mut=); 0 = off
out vec4 outColor;

int byteOf(float f) { return int(f * 255.0 + 0.5); }

uint hashCell(uint x, uint y, uint g, uint s) {
  uint h = s;
  h ^= x * 374761393u;
  h = (h ^ (h >> 13)) * 1274126177u;
  h ^= y * 2654435761u;
  h = (h ^ (h >> 16)) * 2246822519u;
  h ^= g * 3266489917u;
  h = (h ^ (h >> 15)) * 3266489917u;
  h ^= h >> 16;
  return h;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int n = 0;
  int livingCount = 0;
  uint livingGenomes[8]; // at most 8 living neighbors in a 3x3 ring
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      ivec2 q = p + ivec2(dx, dy);
      if (uWrap == 1) {
        q = (q + uSize) % uSize;
      }
      vec4 t = texelFetch(uState, q, 0);
      if ((byteOf(t.r) & 1) == 1) {
        n++;
        uint tg = uint(byteOf(t.g));
        uint tb = uint(byteOf(t.b));
        uint ta = uint(byteOf(t.a));
        livingGenomes[livingCount] = tg | (tb << 8) | (ta << 16);
        livingCount++;
      }
    }
  }
  vec4 self = texelFetch(uState, p, 0);
  int r = byteOf(self.r);
  int g = byteOf(self.g);
  int b = byteOf(self.b);
  int a = byteOf(self.a);
  bool selfAlive = (r & 1) == 1;
  bool alive;
  if (n == 8) {
    alive = selfAlive ? ((a & 2) != 0) : ((a & 1) != 0);
  } else {
    alive = selfAlive ? (((b >> n) & 1) != 0) : (((g >> n) & 1) != 0);
  }
  int outR = 0;
  uint outG = uint(g);
  uint outB = uint(b);
  uint outA = uint(a);
  if (alive) {
    int age = r >> 1;
    if (age < 127) age += 1;
    outR = (age << 1) | 1;
    if (!selfAlive) {
      // Birth: inherit the full 24-bit pack of the hash-selected living
      // neighbor; with no living neighbors (only reachable with a B0-style
      // birth mask) keep the cell's own stored genome. Mutation (uMutBp > 0)
      // flips one rule bit and always assigns a fresh lineage id (XOR of one
      // bit always changes the pack).
      uint genome;
      uint h = 0u;
      if (livingCount > 0) {
        h = hashCell(uint(p.x), uint(p.y), uint(uGen), uSeed);
        genome = livingGenomes[h % uint(livingCount)];
      } else {
        genome = uint(g) | (uint(b) << 8) | (uint(a) << 16);
      }
      bool mutated = false;
      if (uMutBp > 0) {
        if (livingCount == 0) h = hashCell(uint(p.x), uint(p.y), uint(uGen), uSeed);
        if ((h % 10000u) < uint(uMutBp)) {
          uint bit = (h / 10000u) % 18u;
          genome ^= (1u << bit);
          uint lid = 1u + ((h >> 9) % 63u);
          outG = genome & 0xFFu;
          outB = (genome >> 8) & 0xFFu;
          outA = ((genome >> 16) & 0x03u) | (lid << 2);
          mutated = true;
        }
      }
      if (!mutated) {
        outG = genome & 0xFFu;
        outB = (genome >> 8) & 0xFFu;
        outA = (genome >> 16) & 0xFFu;
      }
    }
  }
  outColor = vec4(float(outR) / 255.0, float(outG) / 255.0, float(outB) / 255.0, float(outA) / 255.0);
}
