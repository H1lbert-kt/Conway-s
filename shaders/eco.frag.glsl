#version 300 es
// Stage 10 eco pass: computes the next eco state by diffing main-read vs
// main-write (the births/deaths the sim pass already decided under the same
// flags — no rule duplication, so main and eco cannot diverge), then applies:
//   R = cell energy (meaningful while alive)   G = location pool (ambient)
//   B = niche field (death scar, monotone)
// Birth at p: child takes pool>>1 into R, the rest stays in the pool.
// Death at p: cell energy returns to the pool (R -> G), niche B +1 (cap 255).
// (Design note vs the original +1/-1 plan: deaths and births at one location
// strictly alternate — a cell must be born to die again — so -1 on birth kept
// B in {0,1} forever and NICH_T=8 was unreachable, leaving the S234 bonus
// inert. Death-only writes make B a cumulative mortality map that actually
// reaches richness; probe on the seed=7 soup: maxB=16 and bonus cells from
// gen ~30. Constants stay adjustable; recorded on issue #10.)
// R+G per texel is invariant under both events (init <= 255, pool splits and
// merges never exceed it) => exact global energy conservation, no saturation.
// Drawn only when ?energy=1 || ?niche=1 (eco textures exist only then).
precision highp float;
uniform sampler2D uMainOld;
uniform sampler2D uMainNew;
uniform sampler2D uEco;
out vec4 outEco;

int byteOf(float f) { return int(f * 255.0 + 0.5); }

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int oldAlive = byteOf(texelFetch(uMainOld, p, 0).r) & 1;
  int newAlive = byteOf(texelFetch(uMainNew, p, 0).r) & 1;
  vec4 eco = texelFetch(uEco, p, 0);
  int r = byteOf(eco.r);
  int g = byteOf(eco.g);
  int b = byteOf(eco.b);
  bool born = oldAlive == 0 && newAlive == 1;
  bool died = oldAlive == 1 && newAlive == 0;
  if (born) {
    int part = g >> 1;
    r = part;
    g = g - part;
  } else if (died) {
    g = g + r;
    r = 0;
    b = b < 255 ? b + 1 : b;
  }
  outEco = vec4(float(r) / 255.0, float(g) / 255.0, float(b) / 255.0, 0.0);
}
