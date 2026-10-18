#version 300 es
// Display pass: camera view of the sim texture (RGBA8 normalized byte layout,
// alive = bit0 of R — see sim.frag.glsl). NEAREST + REPEAT keeps cells crisp and
// the torus seamless; the sim samples with texelFetch, so wrap only affects this pass.
// Stage 8: alive cells are colored by lineage id (A bits2-7). Id 0 keeps the
// exact classic Conway color; ids 1..63 map to HSL with a golden-angle hue step
// (fixed S/L), decoded in-shader (no LUT, no per-frame allocation).
precision highp float;
uniform sampler2D uState;
uniform vec2 uViewSize;
uniform vec2 uOrigin; // world texels at the view's bottom-left
uniform vec2 uCells;  // cells across the view (x and y)
uniform float uGrid;  // grid size in texels
out vec4 outColor;

vec3 hsl2rgb(float h, float s, float l) {
  float c = (1.0 - abs(2.0 * l - 1.0)) * s;
  float hp = h / 60.0;
  float x = c * (1.0 - abs(mod(hp, 2.0) - 1.0));
  vec3 rgb;
  if (hp < 1.0) rgb = vec3(c, x, 0.0);
  else if (hp < 2.0) rgb = vec3(x, c, 0.0);
  else if (hp < 3.0) rgb = vec3(0.0, c, x);
  else if (hp < 4.0) rgb = vec3(0.0, x, c);
  else if (hp < 5.0) rgb = vec3(x, 0.0, c);
  else rgb = vec3(c, 0.0, x);
  float m = l - c * 0.5;
  return rgb + m;
}

void main() {
  vec2 world = uOrigin + (gl_FragCoord.xy / uViewSize) * uCells;
  vec4 tex = texture(uState, world / uGrid);
  float alive = float(int(tex.r * 255.0 + 0.5) & 1);
  int lid = (int(tex.a * 255.0 + 0.5) >> 2) & 63;
  vec3 aliveColor = vec3(0.92, 0.94, 1.0);
  if (lid != 0) {
    aliveColor = hsl2rgb(fract(float(lid) * 0.6180339887) * 360.0, 0.65, 0.55);
  }
  outColor = mix(vec4(0.043, 0.043, 0.063, 1.0), vec4(aliveColor, 1.0), alive);
}
