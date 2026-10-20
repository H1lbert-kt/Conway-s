#version 300 es
// Stage 10 eco pass: computes the next eco state by diffing main-read vs
// main-write (the births/deaths the sim pass already decided under the same
// flags — no rule duplication, so main and eco cannot diverge), then applies:
//   R = cell energy (meaningful while alive)   G = location pool (ambient)
//   B = niche field (death scar, monotone)
// Event (per texel, on its own pre-event values):
//   Birth at p: child takes pool>>1 into R, the rest stays in the pool.
//   Death at p: cell energy returns to the pool (R -> G), niche B +1 (cap 255).
// Spatial circulation (owner-approved decision on issue #10 — the original
// local-only model could not give the birth gate teeth: pool of a dead texel
// was invariant 8, so `pool >= B_MIN` never fired; a threshold below 8 was
// equally inert. Two-threshold flow, evaluated on PRE-event values so both
// endpoints compute identical amounts — exact conservation, integer-safe):
//   GIVER (gPre >= GIVE_T and this texel did NOT experience a birth): give 1
//     to each neighbor with gPre < RCV_T (out <= 8 <= gPre, no underflow;
//     the born exclusion keeps the giver's post-event pool >= gPre).
//   RECEIVER (gPre < RCV_T): take 1 from each neighbor with gPre >= GIVE_T
//     that did not birth (in <= 8; post-event pools stay far below 255).
// The idle band [RCV_T, GIVE_T) holds pools that are neither drained nor
// starved — the sim's `pool >= ENERGY_B_MIN` gate (B_MIN = RCV_T) opens
// exactly where circulation has topped a location up, and closes only in
// unfed pockets: density-dependent birth limitation (crowding drains the
// ambient around it) while churn keeps re-enriching sites via fresh deaths
// (R merge -> GIVE_T). Virgin space starts at E0 (ambient init) and is
// refilled by flow instead of being sterile forever.
// (Design note vs the original +1/-1 niche plan: deaths and births at one
// location strictly alternate — a cell must be born to die again — so -1 on
// birth kept B in {0,1} forever and NICH_T=8 was unreachable, leaving the
// S234 bonus inert. Death-only writes make B a cumulative mortality map that
// actually reaches richness. Constants stay adjustable; recorded on #10.)
// R+G per texel moves only between cells and pools, and flow moves G between
// texels without creating any => exact global energy conservation.
// Drawn only when ?energy=1 || ?niche=1 (eco textures exist only then).
precision highp float;
uniform sampler2D uMainOld;
uniform sampler2D uMainNew;
uniform sampler2D uEco;
uniform int uSize;
uniform int uWrap;
out vec4 outEco;

const int GIVE_T = 8;  // giver threshold (mirrored: tests/run.js ECO)
const int RCV_T = 4;   // receiver threshold (mirrored: ECO; B_MIN = RCV_T)

int byteOf(float f) { return int(f * 255.0 + 0.5); }

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int oldAlive = byteOf(texelFetch(uMainOld, p, 0).r) & 1;
  int newAlive = byteOf(texelFetch(uMainNew, p, 0).r) & 1;
  vec4 eco = texelFetch(uEco, p, 0);
  int r = byteOf(eco.r);
  int gPre = byteOf(eco.g);
  int b = byteOf(eco.b);
  bool born = oldAlive == 0 && newAlive == 1;
  bool died = oldAlive == 1 && newAlive == 0;
  // Event on this texel's own pre-event pool.
  int g = gPre;
  if (born) {
    int part = g >> 1;
    r = part;
    g = g - part;
  } else if (died) {
    g = g + r;
    r = 0;
    b = b < 255 ? b + 1 : b;
  }
  // Flow on pre-event values of self and neighbors (see header).
  int flow = 0;
  if (!born && gPre >= GIVE_T) {
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0) continue;
        ivec2 q = p + ivec2(dx, dy);
        if (uWrap == 1) q = (q + uSize) % uSize;
        if (byteOf(texelFetch(uEco, q, 0).g) < RCV_T) flow -= 1;
      }
    }
  } else if (gPre < RCV_T) {
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0) continue;
        ivec2 q = p + ivec2(dx, dy);
        if (uWrap == 1) q = (q + uSize) % uSize;
        if (byteOf(texelFetch(uEco, q, 0).g) >= GIVE_T) {
          int qOld = byteOf(texelFetch(uMainOld, q, 0).r) & 1;
          int qNew = byteOf(texelFetch(uMainNew, q, 0).r) & 1;
          if (!(qOld == 0 && qNew == 1)) flow += 1;
        }
      }
    }
  }
  g = g + flow;
  outEco = vec4(float(r) / 255.0, float(g) / 255.0, float(b) / 255.0, 0.0);
}
