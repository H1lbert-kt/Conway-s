#version 300 es
// Per-cell rules (stage 7) + mutation/lineage (stage 8) + ecology flags
// (stage 10: freq/energy/niche/age). The four FREQ/ENERGY/NICHE/AGE macros
// are injected by main.js from the URL flags BEFORE compile (values 0/1), so
// every stage-10 block is preprocessed away when its flag is off — the
// default Conway path compiles byte-for-byte the stage-8 shader (uniform
// branches in the neighbor loop cost ~40% under SwiftShader even when never
// taken; measured, then specialized).
// Byte layout:
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
// Stage 10 mechanisms (mirrored in tests/run.js cpuStepEco — keep identical):
//   FREQ  1: living neighbors with popcount18(self^n) <= FREQ_SIM_DIST count
//            as similar; a survivor with >= FREQ_PENALTY_T similar neighbors
//            dies (frequency-dependent selection / RPS with mutation).
//   AGE   1: a hash-selected donor younger than AGE_Y_MIN vetoes the birth;
//            a survivor with age >= AGE_DEATH_START dies when
//            h % 10000 < min(10000, (age-AGE_DEATH_START+1)*AGE_DEATH_STEP_BP).
//   NICHE 1: a survivor with exactly 4 neighbors survives (S23 -> S234) when
//            any living neighbor sits on niche-rich terrain (eco B >= NICH_T).
//   ENERGY 1: a birth at p is vetoed when the location pool (eco G) < ENERGY_B_MIN.
// Birth vetoes leave the cell dead with its ORIGINAL stored genome.
// Stage 14 presets (EXP macro 0..4, injected like FREQ/... from ?exp=;
// names mirrored in main.js EXP_PRESETS; CPU mirrors in tests/run.js
// cpuStepGenomeMut(state,size,gen,seed,mutBp,exp)):
//   EXP 1 border: no shader branch — the split-rule layout + stimuli are
//        stamped by main.js (left Conway / right HighLife B6).
//   EXP 2 virus:  a dead cell within popcount18 rule distance VIRUS_DIST of
//        an adjacent living virus (lineage 63) gets its stored pack rewritten
//        to the virus pack (contagion; heavy masks land at distance 10 and
//        are immune). Mutated newborn lids stop at 62 (63 = virus).
//   EXP 3 physics: births with n <= theta >> 5 are vetoed, where theta =
//        round(255*sum/(count*18)) comes from the pre-step GPU-only
//        reduction (uPhysSum/uPhysCount, 1x1 RGBA8 little-endian; no
//        readback — rule 4). Determinism/bounds tested directly.
//   EXP 4 replication: a birth is vetoed unless the hash-selected donor's
//        full pack occurs at least REPLICATION_MIN times among the living
//        neighbors (unqualified births need an existing copy).
// Hash (mirrored bit-for-bit in tests/run.js hashCell):
//   h  = seed
//   h ^= x * 374761393;      h  = (h ^ (h >> 13)) * 1274126177
//   h ^= y * 2654435761;     h  = (h ^ (h >> 16)) * 2246822519
//   h ^= gen * 3266489917;   h  = (h ^ (h >> 15)) * 3266489917
//   h ^= h >> 16
// Toroidal grid: neighbors wrap with integer modulo.
precision highp float;
uniform sampler2D uState;
uniform sampler2D uEco; // eco texture (bound only when ENERGY||NICHE)
uniform int uSize;
uniform int uWrap; // always 1 (toroidal); no non-wrapping path yet
uniform int uGen;  // generation this step computes from (hash input)
uniform uint uSeed; // hash seed (?seed= wiring, stage 8)
uniform int uMutBp; // mutation in basis points (0..10000 from ?mut=); 0 = off
#if EXP == 3
uniform sampler2D uPhysSum;   // 1x1: sum of living rule popcounts (RGBA8 LE)
uniform sampler2D uPhysCount; // 1x1: living cell count (RGBA8 LE)
#endif
out vec4 outColor;

// Stage-10 constants (mirrored: main.js ENERGY_E0 + tests/run.js ECO).
#if FREQ == 1
const int FREQ_SIM_DIST = 4;
const int FREQ_PENALTY_T = 4;
#endif
#if ENERGY == 1
const int ENERGY_B_MIN = 4;
#endif
#if NICHE == 1
const int NICH_T = 48;
#endif
#if AGE == 1
// Stage 13 (issue #14): elder culling only at the age cap — the stage-10 ramp
// (start 96, 200bp) starved sparse worlds past ~1800 gens (probe evidence:
// attrition without enough births to replace). Age saturates at 127, so this
// is a flat 0.1%/gen death chance for max-age cells: the lifecycle keeps
// injecting vacancies/churn but can no longer drain a settled world (offline
// CPU-ref scan, validated bit-exact vs GPU to gen 1000: equilibrium ~62-71
// cells sustained at 3000-4000 gens, vs 1114 frozen cells all-off).
// AGE_Y_MIN donor veto unchanged.
const int AGE_Y_MIN = 1;
const int AGE_DEATH_START = 127;
const int AGE_DEATH_STEP_BP = 10;
#endif
// Stage 14 (issue #15) constants, mirrored in tests/run.js.
#if EXP == 2
// Rule distance below which an adjacent living virus (lineage 63) rewrites a
// dead cell's stored pack: conway-vs-conway = 0 (susceptible), heavy masks
// (g=0xF8, b=0xFC) land at 10 (immune); gap cells at 3 (rewritable, B0 gap).
const int VIRUS_DIST = 6;
#endif
#if EXP == 4
// A birth needs a hash-selected donor with at least this many identical full
// packs among the living neighbors (the count includes the donor itself).
const int REPLICATION_MIN = 2;
#endif

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

#if FREQ == 1 || EXP == 2
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
#endif

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 self = texelFetch(uState, p, 0);
  int r = byteOf(self.r);
  int g = byteOf(self.g);
  int b = byteOf(self.b);
  int a = byteOf(self.a);
  bool selfAlive = (r & 1) == 1;
#if FREQ == 1
  uint selfPack18 = uint(g) | (uint(b) << 8) | ((uint(a) & 3u) << 16);
#endif
#if EXP == 3
  // Stage 14 (?exp=physics): global rule-mass theta, decoded from the
  // pre-step reduction (RGBA8 little-endian): sum = popcount18 of living
  // rules, count = living cells. theta = round(255*sum/(count*18)) in
  // [0,255] (sum <= count*18 structurally); count == 0 -> 0.
  vec4 ps = texelFetch(uPhysSum, ivec2(0), 0);
  vec4 pcC = texelFetch(uPhysCount, ivec2(0), 0);
  uint physSum = uint(byteOf(ps.r)) | (uint(byteOf(ps.g)) << 8)
    | (uint(byteOf(ps.b)) << 16) | (uint(byteOf(ps.a)) << 24);
  uint physCnt = uint(byteOf(pcC.r)) | (uint(byteOf(pcC.g)) << 8)
    | (uint(byteOf(pcC.b)) << 16) | (uint(byteOf(pcC.a)) << 24);
  int thetaB = physCnt > 0u
    ? int((float(physSum) * 255.0) / (float(physCnt) * 18.0) + 0.5)
    : 0;
#endif
  int n = 0;
  int livingCount = 0;
  uint livingGenomes[8]; // at most 8 living neighbors in a 3x3 ring
#if AGE == 1
  uint livingAges[8];
#endif
#if FREQ == 1
  int similarCount = 0;
#endif
#if NICHE == 1
  bool nicheRich = false;
#endif
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
#if AGE == 1
        livingAges[livingCount] = uint(byteOf(t.r) >> 1);
#endif
        livingCount++;
#if FREQ == 1
        uint pack18 = tg | (tb << 8) | ((ta & 3u) << 16);
        if (popcount18(selfPack18 ^ pack18) <= FREQ_SIM_DIST) similarCount++;
#endif
#if NICHE == 1
        if (byteOf(texelFetch(uEco, q, 0).b) >= NICH_T) nicheRich = true;
#endif
      }
    }
  }
  bool alive;
  if (n == 8) {
    alive = selfAlive ? ((a & 2) != 0) : ((a & 1) != 0);
  } else {
    alive = selfAlive ? (((b >> n) & 1) != 0) : (((g >> n) & 1) != 0);
  }
#if NICHE == 1
  // Niche bonus: survival gains n==4 on rich terrain (S23 -> S234).
  if (selfAlive && !alive && n == 4 && nicheRich) alive = true;
#endif
#if FREQ == 1
  // Frequency penalty: similar neighbors kill survivors (RPS pressure).
  if (alive && selfAlive && similarCount >= FREQ_PENALTY_T) alive = false;
#endif
#if AGE == 1
  // Natural death: chance grows with age (hash-driven, fixed-point).
  if (alive && selfAlive) {
    int age = r >> 1;
    if (age >= AGE_DEATH_START) {
      uint h = hashCell(uint(p.x), uint(p.y), uint(uGen), uSeed);
      uint thr = uint(min(10000, (age - AGE_DEATH_START + 1) * AGE_DEATH_STEP_BP));
      if ((h % 10000u) < thr) alive = false;
    }
  }
#endif
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
      // birth mask) keep the cell's own stored genome. Ecology vetoes (young
      // donor, empty pool) leave the cell dead with its original genome.
      uint genome;
      uint h = 0u;
#if AGE == 1
      int donorAge = 0;
#endif
      if (livingCount > 0) {
        h = hashCell(uint(p.x), uint(p.y), uint(uGen), uSeed);
        uint idx = h % uint(livingCount);
        genome = livingGenomes[idx];
#if AGE == 1
        donorAge = int(livingAges[idx]);
#endif
      } else {
        genome = uint(g) | (uint(b) << 8) | (uint(a) << 16);
      }
      bool veto = false;
#if AGE == 1
      if (livingCount > 0 && donorAge < AGE_Y_MIN) veto = true;
#endif
#if ENERGY == 1
      int pool = byteOf(texelFetch(uEco, p, 0).g);
      if (pool < ENERGY_B_MIN) veto = true;
#endif
#if EXP == 3
      // Physics: thresholded birth gate (theta from the pre-step reduction).
      if (n <= (thetaB >> 5)) veto = true;
#endif
#if EXP == 4
      // Replication: unqualified births — the selected donor must already
      // have at least REPLICATION_MIN identical copies (full pack) among the
      // living neighbors; livingCount == 0 vetoes too (copies = 0).
      int copies = 0;
      for (int i = 0; i < livingCount; i++) {
        if (livingGenomes[i] == genome) copies++;
      }
      if (copies < REPLICATION_MIN) veto = true;
#endif
      if (veto) {
        alive = false;
        outR = 0;
      } else {
        // Mutation (uMutBp > 0) flips one rule bit and always assigns a
        // fresh lineage id (XOR of one bit always changes the pack).
        bool mutated = false;
        if (uMutBp > 0) {
          if (livingCount == 0) h = hashCell(uint(p.x), uint(p.y), uint(uGen), uSeed);
          if ((h % 10000u) < uint(uMutBp)) {
            uint bit = (h / 10000u) % 18u;
            genome ^= (1u << bit);
#if EXP == 2
            // Lineage 63 stays reserved for the virus (mutated lids stop at
            // 62 under ?exp=virus so lid63 remains an unambiguous marker).
            uint lid = 1u + ((h >> 9) % 62u);
#else
            uint lid = 1u + ((h >> 9) % 63u);
#endif
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
  }
#if EXP == 2
  // Stage 14 (?exp=virus): contagion — a post-rule DEAD cell within
  // popcount18 rule distance VIRUS_DIST of the first (scan order) adjacent
  // living virus (lineage 63) has its stored pack rewritten to the virus
  // pack; distant stored rules (heavy masks, distance 10) are immune.
  // Living cells are untouched — newborns inherit virus packs through the
  // normal donor path.
  if (!alive) {
    for (int i = 0; i < livingCount; i++) {
      uint lp = livingGenomes[i];
      if (((lp >> 18) & 63u) == 63u) {
        uint vr = lp & 0x3FFFFu;
        uint mr = uint(g) | (uint(b) << 8) | ((uint(a) & 3u) << 16);
        if (popcount18(vr ^ mr) < VIRUS_DIST) {
          outG = lp & 0xFFu;
          outB = (lp >> 8) & 0xFFu;
          outA = ((lp >> 16) & 0x03u) | (63u << 2);
          break;
        }
      }
    }
  }
#endif
  outColor = vec4(float(outR) / 255.0, float(outG) / 255.0, float(outB) / 255.0, float(outA) / 255.0);
}
