const canvas = document.getElementById('gl');
const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: false });

if (!gl) {
  fail('WebGL2 is not available in this browser.');
} else {
  main().catch((err) => fail(String(err && err.message ? err.message : err)));
}

function fail(message) {
  const el = document.createElement('pre');
  el.id = 'error';
  el.textContent = message;
  document.body.appendChild(el);
  canvas.style.display = 'none';
}

function loadText(url) {
  return fetch(url).then((res) => {
    if (!res.ok) throw new Error('Failed to load ' + url + ' (HTTP ' + res.status + ')');
    return res.text();
  });
}

function compileShader(type, source, label) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(label + ' compile failed:\n' + log);
  }
  return shader;
}

function linkProgram(vertexSource, fragmentSource) {
  const vs = compileShader(gl.VERTEX_SHADER, vertexSource, 'vertex shader');
  const fs = compileShader(gl.FRAGMENT_SHADER, fragmentSource, 'fragment shader');
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error('program link failed:\n' + log);
  }
  return program;
}

function gridSize() {
  const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const requested = Number(new URLSearchParams(location.search).get('size'));
  let size = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 1024;
  if ((size & (size - 1)) !== 0) {
    size = 1 << Math.ceil(Math.log2(size));
  }
  if (size > maxSize) size = 1 << Math.floor(Math.log2(maxSize));
  return size;
}

function createSimTargets(size) {
  const textures = new Array(2);
  const fbos = new Array(2);
  for (let i = 0; i < 2; i++) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('framebuffer ' + i + ' is incomplete');
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    textures[i] = texture;
    fbos[i] = fbo;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return { textures: textures, fbos: fbos };
}

function makePattern(w, h, coords) {
  const bits = new Uint8Array(w * h);
  for (let i = 0; i < coords.length; i++) {
    bits[coords[i][1] * w + coords[i][0]] = 1;
  }
  return { w: w, h: h, bits: bits };
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATTERNS = {
  glider: makePattern(3, 3, [[0, 0], [1, 0], [2, 0], [0, 1], [1, 2]]),
  blinker: makePattern(3, 1, [[0, 0], [1, 0], [2, 0]]),
  gun: makePattern(36, 9, [
    [24, 0],
    [22, 1], [24, 1],
    [12, 2], [13, 2], [20, 2], [21, 2], [34, 2], [35, 2],
    [11, 3], [15, 3], [20, 3], [21, 3], [34, 3], [35, 3],
    [0, 4], [1, 4], [10, 4], [16, 4], [20, 4], [21, 4],
    [0, 5], [1, 5], [10, 5], [14, 5], [16, 5], [17, 5], [22, 5], [24, 5],
    [10, 6], [16, 6], [24, 6],
    [11, 7], [15, 7],
    [12, 8], [13, 8],
  ]),
};

const MAX_BRUSH_SIDE = 65;
const MAX_STEPS_PER_FRAME = 8;
// Stage 10: initial cell energy (eco R channel) when ?energy=1. Mirrored in
// tests/run.js ENERGY_E0 and the ENERGY_B_MIN gate in sim.frag.glsl.
const ENERGY_E0 = 8;
// Genome presets: G = birth mask, B = survival mask (byte layout, stage 6+).
const GENOME_PRESETS = {
  conway: { birth: 0x08, surv: 0x0c }, // B3/S23
  highlife: { birth: 0x48, surv: 0x0c }, // B36/S23
};
const DEFAULT_GENOME = 'conway';

async function main() {
  const sources = await Promise.all([
    loadText('shaders/sim.vert.glsl'),
    loadText('shaders/sim.frag.glsl'),
    loadText('shaders/display.frag.glsl'),
    loadText('shaders/eco.frag.glsl'),
  ]);

  // Stage 10: parse the four URL flags FIRST — sim.frag is specialized at
  // compile time via injected #defines (uniform branches in the neighbor loop
  // cost ~40% in the software rasterizer even when never taken; measured).
  // Off flags preprocess their whole block away → default path compiles the
  // stage-8 shader.
  const searchParams = new URLSearchParams(location.search);
  const flagOn = (name) => {
    const v = searchParams.get(name);
    return v !== null && v !== '0';
  };
  const ecoFreq = flagOn('freq') ? 1 : 0;
  const ecoEnergy = flagOn('energy') ? 1 : 0;
  const ecoNiche = flagOn('niche') ? 1 : 0;
  const ecoAge = flagOn('age') ? 1 : 0;
  const ecoOn = (ecoEnergy || ecoNiche) ? 1 : 0;
  const simDefines = '#define FREQ ' + ecoFreq + '\n'
    + '#define ENERGY ' + ecoEnergy + '\n'
    + '#define NICHE ' + ecoNiche + '\n'
    + '#define AGE ' + ecoAge + '\n';

  // #version must stay first: splice the defines after it, not before.
  const specialize = (src) => {
    const nl = src.indexOf('\n');
    return src.slice(0, nl + 1) + simDefines + src.slice(nl + 1);
  };

  const simProgram = linkProgram(sources[0], specialize(sources[1]));
  const displayProgram = linkProgram(sources[0], sources[2]);
  const ecoProgram = linkProgram(sources[0], sources[3]);

  const simLoc = {
    uState: gl.getUniformLocation(simProgram, 'uState'),
    uEco: gl.getUniformLocation(simProgram, 'uEco'),
    uSize: gl.getUniformLocation(simProgram, 'uSize'),
    uWrap: gl.getUniformLocation(simProgram, 'uWrap'),
    uGen: gl.getUniformLocation(simProgram, 'uGen'),
    uSeed: gl.getUniformLocation(simProgram, 'uSeed'),
    uMutBp: gl.getUniformLocation(simProgram, 'uMutBp'),
  };
  const ecoLoc = {
    uMainOld: gl.getUniformLocation(ecoProgram, 'uMainOld'),
    uMainNew: gl.getUniformLocation(ecoProgram, 'uMainNew'),
    uEco: gl.getUniformLocation(ecoProgram, 'uEco'),
  };
  const displayLoc = {
    uState: gl.getUniformLocation(displayProgram, 'uState'),
    uViewSize: gl.getUniformLocation(displayProgram, 'uViewSize'),
    uOrigin: gl.getUniformLocation(displayProgram, 'uOrigin'),
    uCells: gl.getUniformLocation(displayProgram, 'uCells'),
    uGrid: gl.getUniformLocation(displayProgram, 'uGrid'),
  };

  let size = gridSize();
  let targets = createSimTargets(size);
  let textures = targets.textures;
  let fbos = targets.fbos;
  let read = 0;
  let write = 1;
  let ecoTargets = ecoOn ? createSimTargets(size) : null;
  let ecoTextures = ecoTargets ? ecoTargets.textures : null;
  let ecoFbos = ecoTargets ? ecoTargets.fbos : null;
  let ecoRead = 0;
  let ecoWrite = 1;
  let generation = 0;
  let activeGenome = GENOME_PRESETS[DEFAULT_GENOME];

  let camX = 0;
  let camY = 0;
  let cellsX = size;
  let userInteracted = 0;
  let isDragging = 0;
  let dragLastX = 0;
  let dragLastY = 0;
  let hoverX = 0;
  let hoverY = 0;

  let paintMode = 0;
  let painting = 0;
  let brushRadius = 2;
  let selectedPattern = 'brush';
  let selectedGenome = DEFAULT_GENOME;

  const patchBuf = new Uint8Array(MAX_BRUSH_SIDE * MAX_BRUSH_SIDE * 4);
  const packBuf = new Uint8Array(MAX_BRUSH_SIDE * MAX_BRUSH_SIDE * 4);
  let fullBuf = new Uint8Array(size * size * 4);
  let ecoBuf = ecoOn ? new Uint8Array(size * size * 4) : null;

  // Stage 8: living-lineage count. Frozen rule 4 — readPixels only OUTSIDE the
  // auto-stepping loop, and only from the paused 1 Hz HUD tick. Pause/step
  // handlers and frame() never read back: the first readPixels after a playing
  // session forces a deep software-GL queue to drain (measured ~49 s at 4096^2
  // vs ~110 ms steady-state), which would block input dispatch and freeze the
  // UI — deferring to the tick keeps handlers/frame input-responsive; the HUD
  // lineages value appears at most 1 s after pausing.
  // Buffers preallocated; no per-call allocation.
  let countBuf = new Uint8Array(size * size * 4);
  const lineageSeen = new Uint8Array(64);
  let lineageCount = 1;
  function countLineages() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[read]);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, countBuf);
    lineageSeen.fill(0);
    let c = 0;
    for (let i = 0; i < countBuf.length; i += 4) {
      if (countBuf[i] & 1) {
        const lid = (countBuf[i + 3] >> 2) & 63;
        if (!lineageSeen[lid]) {
          lineageSeen[lid] = 1;
          c++;
        }
      }
    }
    lineageCount = c;
  }

  function cellsY() {
    return cellsX * gl.drawingBufferHeight / gl.drawingBufferWidth;
  }

  function fitView() {
    cellsX = size;
    camX = 0;
    camY = size / 2 - cellsY() / 2;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (!userInteracted) fitView();
  }

  const spsParam = Number(new URLSearchParams(location.search).get('sps'));
  let stepsPerSecond = Number.isFinite(spsParam) && spsParam > 0 ? spsParam : 10;
  let auto = true;
  let lastTime = -1;
  let accumulator = 0;

  // Stage 8: ?mut= (0..1, default 0/off) as basis points for the shader's
  // fixed-point compare; ?seed= drives BOTH the initial fill (seededFill) and
  // the sim hash (uSeed) with the same mapping — full reproducibility from
  // ?seed= + ?mut=.
  const DEMO_SEED = 0x2F6E2B1;
  const mutParam = Number(searchParams.get('mut'));
  const mutBp = Number.isFinite(mutParam) && mutParam > 0
    ? Math.min(10000, Math.round(mutParam * 10000))
    : 0;
  const seedParam = searchParams.get('seed');
  const hashSeed = seedParam === null
    ? 0
    : (seedParam === 'demo' ? DEMO_SEED : Number(seedParam) >>> 0);

  // Stage 10: eco ping-pong upload into the live eco texture (read target).
  // Full-grid only; mirrors uploadPatch but targets the eco pair.
  function uploadEco(buf) {
    if (!ecoOn) return;
    gl.bindTexture(gl.TEXTURE_2D, ecoTextures[ecoRead]);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  }

  // Stage 10: ecoBuf[i] = alive ? E0 : 0 from a CPU-side alive bitmap (never
  // GPU readback — stage-8 lesson: readPixels mid-session drains the queue).
  function fillEcoBuf(aliveAt) {
    if (!ecoOn) return;
    const n = size * size;
    for (let i = 0; i < n; i++) {
      ecoBuf[i * 4] = aliveAt(i) ? ENERGY_E0 : 0;
      ecoBuf[i * 4 + 1] = 0;
      ecoBuf[i * 4 + 2] = 0;
      ecoBuf[i * 4 + 3] = 0;
    }
  }

  function stepOnce() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[write]);
    gl.viewport(0, 0, size, size);
    gl.useProgram(simProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textures[read]);
    gl.uniform1i(simLoc.uState, 0);
    if (ecoOn) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, ecoTextures[ecoRead]);
      gl.uniform1i(simLoc.uEco, 1);
    }
    gl.uniform1i(simLoc.uSize, size);
    gl.uniform1i(simLoc.uWrap, 1);
    gl.uniform1i(simLoc.uGen, generation);
    gl.uniform1ui(simLoc.uSeed, hashSeed);
    gl.uniform1i(simLoc.uMutBp, mutBp);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (ecoOn) {
      // Eco pass: diff main-read vs main-write (births/deaths the sim just
      // decided) + current eco-read -> eco-write; then swap eco ping-pong.
      gl.bindFramebuffer(gl.FRAMEBUFFER, ecoFbos[ecoWrite]);
      gl.viewport(0, 0, size, size);
      gl.useProgram(ecoProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, textures[read]);
      gl.uniform1i(ecoLoc.uMainOld, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, textures[write]);
      gl.uniform1i(ecoLoc.uMainNew, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, ecoTextures[ecoRead]);
      gl.uniform1i(ecoLoc.uEco, 2);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const er = ecoRead;
      ecoRead = ecoWrite;
      ecoWrite = er;
    }
    read = write;
    write ^= 1;
    generation++;
  }

  function display() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(displayProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textures[read]);
    gl.uniform1i(displayLoc.uState, 0);
    gl.uniform2f(displayLoc.uViewSize, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform2f(displayLoc.uOrigin, camX, camY);
    gl.uniform2f(displayLoc.uCells, cellsX, cellsY());
    gl.uniform1f(displayLoc.uGrid, size);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function uploadSeg(dstX, dstY, ow, oh, srcX0, srcY0, w, h, src) {
    for (let row = 0; row < oh; row++) {
      let po = row * ow * 4;
      let so = ((srcY0 + row) * w + srcX0) * 4;
      for (let col = 0; col < ow; col++) {
        packBuf[po] = src[so];
        packBuf[po + 1] = src[so + 1];
        packBuf[po + 2] = src[so + 2];
        packBuf[po + 3] = src[so + 3];
        po += 4;
        so += 4;
      }
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, dstX, dstY, ow, oh, gl.RGBA, gl.UNSIGNED_BYTE, packBuf);
  }

  // Torus-wrapped patch upload into the live state texture (read target).
  // Full-grid patches go direct; smaller ones may split into up to 4 uploads.
  function uploadPatch(x0, y0, w, h, src) {
    gl.bindTexture(gl.TEXTURE_2D, textures[read]);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (x0 === 0 && y0 === 0 && w === size && h === size) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, src);
      return;
    }
    const sx = ((x0 % size) + size) % size;
    const sy = ((y0 % size) + size) % size;
    const xEnd = sx + w;
    const yEnd = sy + h;
    const w1 = Math.min(size, xEnd) - sx;
    const h1 = Math.min(size, yEnd) - sy;
    if (w1 > 0 && h1 > 0) uploadSeg(sx, sy, w1, h1, 0, 0, w, h, src);
    if (xEnd > size && h1 > 0) uploadSeg(0, sy, xEnd - size, h1, w1, 0, w, h, src);
    if (yEnd > size && w1 > 0) uploadSeg(sx, 0, w1, yEnd - size, 0, h1, w, h, src);
    if (xEnd > size && yEnd > size) uploadSeg(0, 0, xEnd - size, yEnd - size, w1, h1, w, h, src);
  }

  function stampBrush(cx, cy, r) {
    const side = 2 * r + 1;
    const n = side * side;
    for (let i = 0; i < n; i++) {
      patchBuf[i * 4] = 1;
      patchBuf[i * 4 + 1] = activeGenome.birth;
      patchBuf[i * 4 + 2] = activeGenome.surv;
      patchBuf[i * 4 + 3] = 0;
    }
    uploadPatch(cx - r, cy - r, side, side, patchBuf);
  }

  function stampPattern(name, x0, y0) {
    const p = PATTERNS[name];
    if (!p) return;
    const n = p.w * p.h;
    for (let i = 0; i < n; i++) {
      patchBuf[i * 4] = p.bits[i] ? 1 : 0;
      patchBuf[i * 4 + 1] = activeGenome.birth;
      patchBuf[i * 4 + 2] = activeGenome.surv;
      patchBuf[i * 4 + 3] = 0;
    }
    uploadPatch(x0, y0, p.w, p.h, patchBuf);
  }

  function clearGrid() {
    const n = size * size;
    for (let i = 0; i < n; i++) {
      fullBuf[i * 4] = 0;
      fullBuf[i * 4 + 1] = activeGenome.birth;
      fullBuf[i * 4 + 2] = activeGenome.surv;
      fullBuf[i * 4 + 3] = 0;
    }
    uploadPatch(0, 0, size, size, fullBuf);
    fillEcoBuf(() => 0);
    uploadEco(ecoBuf);
  }

  function randomize() {
    const n = size * size;
    for (let i = 0; i < n; i++) {
      fullBuf[i * 4] = Math.random() < 0.5 ? 0 : 1;
      fullBuf[i * 4 + 1] = activeGenome.birth;
      fullBuf[i * 4 + 2] = activeGenome.surv;
      fullBuf[i * 4 + 3] = 0;
    }
    uploadPatch(0, 0, size, size, fullBuf);
    fillEcoBuf((i) => fullBuf[i * 4] & 1);
    uploadEco(ecoBuf);
  }

  function seededFill(seed) {
    const rnd = mulberry32(seed >>> 0);
    const n = size * size;
    for (let i = 0; i < n; i++) {
      fullBuf[i * 4] = rnd() < 0.5 ? 0 : 1;
      fullBuf[i * 4 + 1] = activeGenome.birth;
      fullBuf[i * 4 + 2] = activeGenome.surv;
      fullBuf[i * 4 + 3] = 0;
    }
    uploadPatch(0, 0, size, size, fullBuf);
    fillEcoBuf((i) => fullBuf[i * 4] & 1);
    uploadEco(ecoBuf);
  }

  function initSeed() {
    if (seedParam === null) return;
    seededFill(hashSeed);
  }

  function applyGridSize(newSize) {
    if (newSize === size) return;
    for (let i = 0; i < 2; i++) {
      gl.deleteFramebuffer(fbos[i]);
      gl.deleteTexture(textures[i]);
    }
    size = newSize;
    targets = createSimTargets(size);
    textures = targets.textures;
    fbos = targets.fbos;
    read = 0;
    write = 1;
    generation = 0;
    fullBuf = new Uint8Array(size * size * 4);
    countBuf = new Uint8Array(size * size * 4);
    lineageCount = 1;
    if (ecoOn) {
      for (let i = 0; i < 2; i++) {
        gl.deleteFramebuffer(ecoFbos[i]);
        gl.deleteTexture(ecoTextures[i]);
      }
      ecoTargets = createSimTargets(size);
      ecoTextures = ecoTargets.textures;
      ecoFbos = ecoTargets.fbos;
      ecoRead = 0;
      ecoWrite = 1;
      ecoBuf = new Uint8Array(size * size * 4);
    }
    window.__life.size = size;
    fitView();
  }

  function updateHover(e) {
    const ux = e.offsetX / canvas.clientWidth;
    const uy = 1 - e.offsetY / canvas.clientHeight;
    hoverX = Math.floor(camX + ux * cellsX);
    hoverY = Math.floor(camY + uy * cellsY());
  }

  function onWheel(e) {
    e.preventDefault();
    const ux = e.offsetX / canvas.clientWidth;
    const uy = 1 - e.offsetY / canvas.clientHeight;
    const cy = cellsY();
    const wx = camX + ux * cellsX;
    const wy = camY + uy * cy;
    let next = cellsX * Math.pow(1.0015, e.deltaY);
    const minCells = 4;
    const maxCells = size * 4;
    if (next < minCells) next = minCells;
    if (next > maxCells) next = maxCells;
    cellsX = next;
    camX = wx - ux * cellsX;
    camY = wy - uy * cellsY();
    userInteracted = 1;
  }

  function onMouseDown(e) {
    updateHover(e);
    if (paintMode) {
      if (selectedPattern === 'brush') {
        painting = 1;
        stampBrush(hoverX, hoverY, brushRadius);
      } else {
        stampPattern(selectedPattern, hoverX, hoverY);
      }
    } else {
      isDragging = 1;
      dragLastX = e.offsetX;
      dragLastY = e.offsetY;
      userInteracted = 1;
    }
  }

  function onMouseUp() {
    isDragging = 0;
    painting = 0;
  }

  function onMouseMove(e) {
    if (e.target !== canvas) return;
    if (paintMode) {
      if (painting) {
        updateHover(e);
        stampBrush(hoverX, hoverY, brushRadius);
      }
      return;
    }
    if (!isDragging) return;
    camX -= ((e.offsetX - dragLastX) / canvas.clientWidth) * cellsX;
    camY += ((e.offsetY - dragLastY) / canvas.clientHeight) * cellsY();
    dragLastX = e.offsetX;
    dragLastY = e.offsetY;
  }

  const btnPlay = document.getElementById('btn-play');
  const btnStep = document.getElementById('btn-step');
  const elSpeed = document.getElementById('speed');
  const elGrid = document.getElementById('grid-size');
  const btnClear = document.getElementById('btn-clear');
  const btnRandom = document.getElementById('btn-random');
  const btnPaint = document.getElementById('btn-paint');
  const elBrush = document.getElementById('brush-size');
  const elPattern = document.getElementById('pattern');
  const elGenome = document.getElementById('genome');

  function updatePlayLabel() {
    btnPlay.textContent = auto ? 'Pause' : 'Play';
  }

  function updatePaintLabel() {
    btnPaint.textContent = paintMode ? 'Paint: on' : 'Paint: off';
  }

  function setAuto(value) {
    auto = !!value;
    accumulator = 0;
    updatePlayLabel();
  }

  btnPlay.addEventListener('click', function () { setAuto(!auto); });
  btnStep.addEventListener('click', function () { stepOnce(); });
  elSpeed.addEventListener('input', function () { stepsPerSecond = elSpeed.valueAsNumber; });
  elGrid.addEventListener('change', function () { applyGridSize(Number(elGrid.value)); });
  btnClear.addEventListener('click', clearGrid);
  btnRandom.addEventListener('click', randomize);
  btnPaint.addEventListener('click', function () {
    paintMode ^= 1;
    painting = 0;
    updatePaintLabel();
  });
  elBrush.addEventListener('input', function () { brushRadius = Math.floor(elBrush.valueAsNumber / 2); });
  elPattern.addEventListener('change', function () { selectedPattern = elPattern.value; });
  elGenome.addEventListener('change', function () { setGenome(elGenome.value); });

  function setGenome(name) {
    const preset = GENOME_PRESETS[name];
    if (!preset) return false;
    selectedGenome = name;
    activeGenome = preset;
    return true;
  }

  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const maxAllowed = Math.min(4096, maxTextureSize);
  for (let i = 0; i < elGrid.options.length; i++) {
    if (Number(elGrid.options[i].value) > maxAllowed) elGrid.options[i].hidden = true;
  }

  const elHud = document.getElementById('hud');
  let hudFrames = 0;
  let hudLastGen = 0;
  let hudLastTime = -1;

  window.__life = {
    size: size,
    maxTextureSize: maxTextureSize,
    setAuto: setAuto,
    step: function (n) {
      for (let i = 0; i < n; i++) stepOnce();
    },
    seed: function (w, h, data) {
      // Test-seed API stays "RGBA bytes with R>127 = alive"; convert in place to
      // the active genome's byte layout (validation path, never inside frame()).
      const n = w * h;
      for (let i = 0; i < n; i++) {
        const alive = data[i * 4] > 127 ? 1 : 0;
        data[i * 4] = alive;
        data[i * 4 + 1] = activeGenome.birth;
        data[i * 4 + 2] = activeGenome.surv;
        data[i * 4 + 3] = 0;
      }
      gl.bindTexture(gl.TEXTURE_2D, textures[read]);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
      if (ecoOn) {
        // Eco re-init from the CPU-side alive bits (no GPU readback).
        const m = size * size;
        for (let i = 0; i < m; i++) {
          const alive = i < n ? (data[i * 4] & 1) : 0;
          ecoBuf[i * 4] = alive ? ENERGY_E0 : 0;
          ecoBuf[i * 4 + 1] = 0;
          ecoBuf[i * 4 + 2] = 0;
          ecoBuf[i * 4 + 3] = 0;
        }
        uploadEco(ecoBuf);
      }
    },
    read: function (x, y, w, h) {
      const buf = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[read]);
      gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      // Harness contract: channel 0 reads back as 0/255 alive (pre-layout format).
      for (let i = 0; i < w * h; i++) buf[i * 4] = (buf[i * 4] & 1) ? 255 : 0;
      return buf;
    },
    readRaw: function (x, y, w, h) {
      const buf = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[read]);
      gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return buf;
    },
    // Stage 10: full eco texture readback (R=cell energy, G=pool, B=niche).
    // Validation path only (like readRaw) — never inside the render loop.
    readEco: function () {
      if (!ecoOn) return null;
      const buf = new Uint8Array(size * size * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, ecoFbos[ecoRead]);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return buf;
    },
    view: function () {
      return [camX, camY, cellsX, cellsY()];
    },
    readScreen: function (x, y, w, h) {
      display();
      const buf = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return buf;
    },
    generation: function () {
      return generation;
    },
    stampBrush: stampBrush,
    stampPattern: stampPattern,
    clear: clearGrid,
    randomize: randomize,
    setGenome: setGenome,
  };

  window.addEventListener('resize', resize);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousemove', onMouseMove);

  updatePlayLabel();
  updatePaintLabel();
  fitView();
  resize();
  initSeed();

  function frame(now) {
    if (lastTime < 0) lastTime = now;
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    if (dt > 0) {
      if (dt > 0.25) dt = 0.25;
      if (auto) {
        accumulator += dt;
        const stepDuration = 1 / stepsPerSecond;
        let steps = 0;
        while (accumulator >= stepDuration && steps < MAX_STEPS_PER_FRAME) {
          stepOnce();
          accumulator -= stepDuration;
          steps++;
        }
        if (steps === MAX_STEPS_PER_FRAME && accumulator > stepDuration) {
          accumulator = 0;
        }
      } else {
        accumulator = 0;
      }
    }
    hudFrames++;
    if (hudLastTime < 0) hudLastTime = now;
    const hudDue = now - hudLastTime >= 1000;
    if (hudDue) {
      const hudDt = (now - hudLastTime) / 1000;
      const fps = Math.round(hudFrames / hudDt);
      const genRate = Math.round((generation - hudLastGen) / hudDt);
      if (!auto) countLineages();
      elHud.textContent = fps + ' fps | ' + genRate + ' gen/s | gen ' + generation
        + ' | lineages: ' + lineageCount;
      hudFrames = 0;
      hudLastGen = generation;
      hudLastTime = now;
    }
    display();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
