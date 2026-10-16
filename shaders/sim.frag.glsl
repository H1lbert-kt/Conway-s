#version 300 es
// Conway B3/S23. State encoding: R channel = alive (1.0) / dead (0.0), RGBA8.
// Toroidal grid: neighbors wrap with integer modulo.
precision highp float;
uniform sampler2D uState;
uniform int uSize;
uniform int uWrap; // always 1 (toroidal); no non-wrapping path yet
out vec4 outColor;

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
      n += texelFetch(uState, q, 0).r > 0.5 ? 1 : 0;
    }
  }
  bool self = texelFetch(uState, p, 0).r > 0.5;
  bool alive = (n == 3) || (self && n == 2);
  outColor = vec4(alive ? 1.0 : 0.0, 0.0, 0.0, 1.0);
}
