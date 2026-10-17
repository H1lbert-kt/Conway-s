#version 300 es
// Display pass: camera view of the sim texture (RGBA8 normalized byte layout,
// alive = bit0 of R — see sim.frag.glsl). NEAREST + REPEAT keeps cells crisp and
// the torus seamless; the sim samples with texelFetch, so wrap only affects this pass.
precision highp float;
uniform sampler2D uState;
uniform vec2 uViewSize;
uniform vec2 uOrigin; // world texels at the view's bottom-left
uniform vec2 uCells;  // cells across the view (x and y)
uniform float uGrid;  // grid size in texels
out vec4 outColor;

void main() {
  vec2 world = uOrigin + (gl_FragCoord.xy / uViewSize) * uCells;
  float alive = float(int(texture(uState, world / uGrid).r * 255.0 + 0.5) & 1);
  outColor = mix(vec4(0.043, 0.043, 0.063, 1.0), vec4(0.92, 0.94, 1.0, 1.0), alive);
}
