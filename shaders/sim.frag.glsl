#version 300 es
// Conway B3/S23. State = RGBA8 (normalized) carrying this byte layout:
//   R = (age << 1) | alive   — age = consecutive alive generations, saturates at 127
//   G = birth mask   (bit n = born with n neighbors);     Conway B3  => 0b00001000
//   B = survival mask (bit n = survives with n neighbors); Conway S23 => 0b00001100
//   A = bit0 born with 8, bit1 survives with 8, bits2-7 lineage id
// Bytes travel as normalized floats (v/255); decode with int(v*255+0.5) — exact for
// all 256 byte values in highp. RGBA8UI rendering is unavailable on the reference
// software-GL stack (no EXT_color_buffer_integer); this encoding is lossless and
// portable across all WebGL2 implementations (issue #6 plan-adjustment comment).
// Stage 6 stores the masks but does NOT consume them: the rule below is still the
// exact Conway expression on bit0, isolating the storage migration (stage 7 consumes).
// Toroidal grid: neighbors wrap with integer modulo.
precision highp float;
uniform sampler2D uState;
uniform int uSize;
uniform int uWrap; // always 1 (toroidal); no non-wrapping path yet
out vec4 outColor;

int byteOf(float f) { return int(f * 255.0 + 0.5); }

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int n = 0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      ivec2 q = p + ivec2(dx, dy);
      if (uWrap == 1) {
        q = (q + uSize) % uSize;
      }
      n += byteOf(texelFetch(uState, q, 0).r) & 1;
    }
  }
  vec4 self = texelFetch(uState, p, 0);
  int r = byteOf(self.r);
  bool selfAlive = (r & 1) == 1;
  bool alive = (n == 3) || (selfAlive && n == 2);
  int outR = 0;
  if (alive) {
    int age = r >> 1;
    if (age < 127) age += 1;
    outR = (age << 1) | 1;
  }
  outColor = vec4(float(outR) / 255.0, self.g, self.b, self.a);
}
