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
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    textures[i] = texture;
    fbos[i] = fbo;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return { textures: textures, fbos: fbos };
}

const MAX_STEPS_PER_FRAME = 8;

async function main() {
  const sources = await Promise.all([
    loadText('shaders/sim.vert.glsl'),
    loadText('shaders/sim.frag.glsl'),
    loadText('shaders/display.frag.glsl'),
  ]);
  const simProgram = linkProgram(sources[0], sources[1]);
  const displayProgram = linkProgram(sources[0], sources[2]);

  const simLoc = {
    uState: gl.getUniformLocation(simProgram, 'uState'),
    uSize: gl.getUniformLocation(simProgram, 'uSize'),
    uWrap: gl.getUniformLocation(simProgram, 'uWrap'),
  };
  const displayLoc = {
    uState: gl.getUniformLocation(displayProgram, 'uState'),
    uViewSize: gl.getUniformLocation(displayProgram, 'uViewSize'),
    uOrigin: gl.getUniformLocation(displayProgram, 'uOrigin'),
    uCells: gl.getUniformLocation(displayProgram, 'uCells'),
    uGrid: gl.getUniformLocation(displayProgram, 'uGrid'),
  };

  const size = gridSize();
  const targets = createSimTargets(size);
  const textures = targets.textures;
  const fbos = targets.fbos;
  let read = 0;
  let write = 1;

  let camX = 0;
  let camY = 0;
  let cellsX = size;
  let userInteracted = 0;
  let isDragging = 0;
  let dragLastX = 0;
  let dragLastY = 0;

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
  const stepsPerSecond = Number.isFinite(spsParam) && spsParam > 0 ? spsParam : 10;
  let auto = true;
  let lastTime = -1;
  let accumulator = 0;

  function stepOnce() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[write]);
    gl.viewport(0, 0, size, size);
    gl.useProgram(simProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textures[read]);
    gl.uniform1i(simLoc.uState, 0);
    gl.uniform1i(simLoc.uSize, size);
    gl.uniform1i(simLoc.uWrap, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    read = write;
    write ^= 1;
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
    isDragging = 1;
    dragLastX = e.offsetX;
    dragLastY = e.offsetY;
    userInteracted = 1;
  }

  function onMouseUp() {
    isDragging = 0;
  }

  function onMouseMove(e) {
    if (!isDragging) return;
    camX -= ((e.offsetX - dragLastX) / canvas.clientWidth) * cellsX;
    camY += ((e.offsetY - dragLastY) / canvas.clientHeight) * cellsY();
    dragLastX = e.offsetX;
    dragLastY = e.offsetY;
  }

  window.__life = {
    size: size,
    setAuto: function (value) {
      auto = !!value;
      accumulator = 0;
    },
    step: function (n) {
      for (let i = 0; i < n; i++) stepOnce();
    },
    seed: function (w, h, data) {
      gl.bindTexture(gl.TEXTURE_2D, textures[read]);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    },
    read: function (x, y, w, h) {
      const buf = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[read]);
      gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
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
  };

  window.addEventListener('resize', resize);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousemove', onMouseMove);

  fitView();
  resize();

  function frame(now) {
    if (lastTime < 0) lastTime = now;
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    if (dt > 0) {
      if (dt > 0.25) dt = 0.25;
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
    }
    display();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
