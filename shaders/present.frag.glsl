#version 300 es
// Debug present pass: nearest-sample the live sim texture, stretch to canvas.
// No camera/pan/zoom here (Stage 3).
precision mediump float;
uniform sampler2D uState;
uniform vec2 uViewSize;
out vec4 outColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uViewSize;
  float alive = texture(uState, uv).r;
  outColor = mix(vec4(0.043, 0.043, 0.063, 1.0), vec4(0.92, 0.94, 1.0, 1.0), alive);
}
