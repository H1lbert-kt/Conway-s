#!/usr/bin/env node
// Validation suite for Conway's Game of Life (B3/S23, WebGL2).
// Stages covered: 1 (scaffold/context) and 2 (GPU simulation core).
// Run: pnpm test   (requires Node 18+ and a Chromium binary; see findChromium).
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const { chromium } = require('playwright-core');

const SIZE = 64;
const ROOT = path.join(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.glsl': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

function findChromium() {
  const candidates = [
    process.env.CHROMIUM_BIN,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* not installed */ }
  throw new Error('No Chromium found. Set CHROMIUM_BIN or install one.');
}

function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// CPU reference (independent implementation, GL coordinates: y up).
function cpuStep(grid, size) {
  const next = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          n += grid[((y + dy + size) % size) * size + ((x + dx + size) % size)];
        }
      }
      const self = grid[y * size + x];
      next[y * size + x] = (n === 3 || (self && n === 2)) ? 1 : 0;
    }
  }
  return next;
}

// Stage 7: 32-bit cell hash, bit-for-bit mirror of hashCell() in sim.frag.glsl.
// GLSL uint multiply wraps mod 2^32 == Math.imul low bits; >> on uint == >>>.
function hashCell(x, y, g, s) {
  let h = s >>> 0;
  h = (h ^ Math.imul(x >>> 0, 374761393)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ Math.imul(y >>> 0, 2654435761)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822519) >>> 0;
  h = (h ^ Math.imul(g >>> 0, 3266489917)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 3266489917) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h >>> 0;
}

// Stage 7: CPU reference over the full RGBA byte layout (masks + hash inheritance).
// state: Uint8Array size*size*4; gen = generation this step computes from; seed = hash seed.
function cpuStepGenome(state, size, gen, seed) {
  const next = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0;
      const living = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const qx = (x + dx + size) % size;
          const qy = (y + dy + size) % size;
          const i = (qy * size + qx) * 4;
          if (state[i] & 1) {
            n++;
            living.push((state[i + 1] | (state[i + 2] << 8) | ((state[i + 3] & 3) << 16)) >>> 0);
          }
        }
      }
      const si = (y * size + x) * 4;
      const r = state[si];
      const g = state[si + 1];
      const b = state[si + 2];
      const a = state[si + 3];
      const selfAlive = (r & 1) === 1;
      let alive;
      if (n === 8) {
        alive = selfAlive ? ((a & 2) !== 0) : ((a & 1) !== 0);
      } else {
        alive = selfAlive ? (((b >> n) & 1) !== 0) : (((g >> n) & 1) !== 0);
      }
      let outR = 0;
      let outG = g;
      let outB = b;
      let outA = a;
      if (alive) {
        let age = r >> 1;
        if (age < 127) age += 1;
        outR = (age << 1) | 1;
        if (!selfAlive) {
          let genome;
          if (living.length > 0) {
            genome = living[hashCell(x, y, gen, seed) % living.length];
          } else {
            genome = (g | (b << 8) | ((a & 3) << 16)) >>> 0;
          }
          outG = genome & 0xFF;
          outB = (genome >> 8) & 0xFF;
          outA = (a & 0xFC) | ((genome >> 16) & 3);
        }
      }
      next[si] = outR;
      next[si + 1] = outG;
      next[si + 2] = outB;
      next[si + 3] = outA;
    }
  }
  return next;
}

// Stage 8: CPU reference with mutation + full 24-bit lineage inheritance
// (mirror of sim.frag; mutBp = ?mut= in basis points, 0 = stage-7 behavior).
function cpuStepGenomeMut(state, size, gen, seed, mutBp) {
  const next = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0;
      const living = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const qx = (x + dx + size) % size;
          const qy = (y + dy + size) % size;
          const i = (qy * size + qx) * 4;
          if (state[i] & 1) {
            n++;
            living.push((state[i + 1] | (state[i + 2] << 8) | (state[i + 3] << 16)) >>> 0);
          }
        }
      }
      const si = (y * size + x) * 4;
      const r = state[si];
      const g = state[si + 1];
      const b = state[si + 2];
      const a = state[si + 3];
      const selfAlive = (r & 1) === 1;
      let alive;
      if (n === 8) {
        alive = selfAlive ? ((a & 2) !== 0) : ((a & 1) !== 0);
      } else {
        alive = selfAlive ? (((b >> n) & 1) !== 0) : (((g >> n) & 1) !== 0);
      }
      let outR = 0;
      let outG = g;
      let outB = b;
      let outA = a;
      if (alive) {
        let age = r >> 1;
        if (age < 127) age += 1;
        outR = (age << 1) | 1;
        if (!selfAlive) {
          const h = hashCell(x, y, gen, seed);
          let genome = living.length > 0
            ? living[h % living.length]
            : (g | (b << 8) | (a << 16)) >>> 0;
          if (mutBp > 0 && (h % 10000) < mutBp) {
            const bit = Math.floor(h / 10000) % 18;
            genome = (genome ^ (1 << bit)) >>> 0;
            const lid = 1 + ((h >>> 9) % 63);
            outG = genome & 0xFF;
            outB = (genome >>> 8) & 0xFF;
            outA = ((genome >>> 16) & 0x03) | (lid << 2);
          } else {
            outG = genome & 0xFF;
            outB = (genome >>> 8) & 0xFF;
            outA = (genome >>> 16) & 0xFF;
          }
        }
      }
      next[si] = outR;
      next[si + 1] = outG;
      next[si + 2] = outB;
      next[si + 3] = outA;
    }
  }
  return next;
}

function toRgba(grid) {
  const buf = new Uint8Array(grid.length * 4);
  for (let i = 0; i < grid.length; i++) {
    if (grid[i]) buf[i * 4] = 255;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

function gpuGrid(page) {
  return page.evaluate(() => {
    const L = window.__life;
    const buf = L.read(0, 0, L.size, L.size);
    const g = new Uint8Array(L.size * L.size);
    for (let i = 0; i < g.length; i++) g[i] = buf[i * 4] > 127 ? 1 : 0;
    return Array.from(g);
  }).then((a) => Uint8Array.from(a));
}

async function seedGrid(page, cells) {
  const grid = new Uint8Array(SIZE * SIZE);
  for (const [x, y] of cells) grid[y * SIZE + x] = 1;
  await page.evaluate((rgba) => {
    window.__life.seed(window.__life.size, window.__life.size, new Uint8Array(rgba));
  }, Array.from(toRgba(grid)));
  return grid;
}

function countDiff(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/index.html`;
  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
  });

  const console_ = [];
  const pageErrors = [];
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  page.on('console', (m) => console_.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.addInitScript(() => {
    window.__counters = { textures: 0, framebuffers: 0, readPixels: 0, drawArrays: 0 };
    const W2 = WebGL2RenderingContext.prototype;
    for (const [name, key] of [['createTexture', 'textures'], ['createFramebuffer', 'framebuffers']]) {
      const orig = W2[name];
      W2[name] = function () { window.__counters[key]++; return orig.apply(this, arguments); };
    }
    const origRead = W2.readPixels;
    W2.readPixels = function () { window.__counters.readPixels++; return origRead.apply(this, arguments); };
    const origDraw = W2.drawArrays;
    W2.drawArrays = function () { window.__counters.drawArrays++; return origDraw.apply(this, arguments); };
  });

  // ---- Stage 1 ----
  await page.goto(`${base}?size=${SIZE}&sps=0.0001`);
  await page.waitForFunction(() => !!window.__life || !!document.getElementById('error'));
  const errEl = await page.evaluate(() => document.getElementById('error')?.textContent ?? null);
  record('stage1: webgl2 context + shaders load', !errEl && pageErrors.length === 0 && !console_.some((c) => c.startsWith('[error]')), errEl || console_.filter((c) => c.startsWith('[error]')).join('; ') || undefined);
  await page.evaluate(() => window.__life.setAuto(false));

  const box = await page.evaluate(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { w: r.width, h: r.height, iw: innerWidth, ih: innerHeight };
  });
  record('stage1: canvas covers viewport', box.w === box.iw && box.h === box.ih, JSON.stringify(box));

  await page.setViewportSize({ width: 800, height: 600 });
  await page.waitForTimeout(300);
  const box2 = await page.evaluate(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { w: r.width, h: r.height, iw: innerWidth, ih: innerHeight };
  });
  record('stage1: canvas follows resize', box2.w === box2.iw && box2.h === box2.ih, JSON.stringify(box2));

  const countersA = await page.evaluate(() => window.__counters);
  await page.waitForTimeout(500);
  const countersB = await page.evaluate(() => window.__counters);
  record('stage1: sim targets allocated once', countersB.textures === 2 && countersB.framebuffers === 2, JSON.stringify(countersB));
  record('stage1: render loop advances', countersB.drawArrays > countersA.drawArrays, `${countersA.drawArrays} -> ${countersB.drawArrays}`);

  // ---- Stage 2 ----
  const L = await page.evaluate(() => ({ size: window.__life.size }));
  record('stage2: grid size honored', L.size === SIZE, `size=${L.size}`);

  await page.evaluate(() => window.__life.step(5));
  const empty = await gpuGrid(page);
  record('stage2: empty grid stays empty', empty.every((v) => v === 0));

  await seedGrid(page, [[32, 32]]);
  await page.evaluate(() => window.__life.step(1));
  const single = await gpuGrid(page);
  record('stage2: single cell dies', single.every((v) => v === 0));

  const blockCells = [[10, 10], [11, 10], [10, 11], [11, 11]];
  await seedGrid(page, blockCells);
  await page.evaluate(() => window.__life.step(10));
  const block = await gpuGrid(page);
  const blockWant = new Uint8Array(SIZE * SIZE);
  for (const [x, y] of blockCells) blockWant[y * SIZE + x] = 1;
  record('stage2: block still-life stable', countDiff(block, blockWant) === 0);

  await seedGrid(page, [[20, 30], [21, 30], [22, 30]]);
  await page.evaluate(() => window.__life.step(1));
  const blinkerV = await gpuGrid(page);
  const vWant = new Uint8Array(SIZE * SIZE);
  for (const [x, y] of [[21, 29], [21, 30], [21, 31]]) vWant[y * SIZE + x] = 1;
  record('stage2: blinker -> vertical', countDiff(blinkerV, vWant) === 0);
  await page.evaluate(() => window.__life.step(1));
  const blinkerH = await gpuGrid(page);
  const hWant = new Uint8Array(SIZE * SIZE);
  for (const [x, y] of [[20, 30], [21, 30], [22, 30]]) hWant[y * SIZE + x] = 1;
  record('stage2: blinker period 2', countDiff(blinkerH, hWant) === 0);

  // glider vs CPU reference (interior)
  const GLIDER = [[1, 2], [2, 1], [0, 0], [1, 0], [2, 0]];
  {
    let ref = new Uint8Array(SIZE * SIZE);
    for (const [x, y] of GLIDER) ref[(10 + y) * SIZE + (10 + x)] = 1;
    await seedGrid(page, GLIDER.map(([x, y]) => [10 + x, 10 + y]));
    const checkpoints = [1, 2, 4, 8, 20];
    let worst = 0;
    for (let g = 1; g <= 20; g++) {
      ref = cpuStep(ref, SIZE);
      await page.evaluate(() => window.__life.step(1));
      if (checkpoints.includes(g)) {
        const got = await gpuGrid(page);
        worst = Math.max(worst, countDiff(ref, got));
      }
    }
    record('stage2: glider matches CPU reference (interior)', worst === 0, `max mismatches=${worst}`);
  }

  // glider vs CPU reference (crossing the wrap edge)
  {
    let ref = new Uint8Array(SIZE * SIZE);
    for (const [x, y] of GLIDER) ref[((SIZE - 2 + y) % SIZE) * SIZE + ((SIZE - 2 + x) % SIZE)] = 1;
    await seedGrid(page, GLIDER.map(([x, y]) => [(SIZE - 2 + x) % SIZE, (SIZE - 2 + y) % SIZE]));
    const checkpoints = [1, 4, 8, 16, 40];
    let worst = 0;
    for (let g = 1; g <= 40; g++) {
      ref = cpuStep(ref, SIZE);
      await page.evaluate(() => window.__life.step(1));
      if (checkpoints.includes(g)) {
        const got = await gpuGrid(page);
        worst = Math.max(worst, countDiff(ref, got));
      }
    }
    record('stage2: glider wraps toroidally (matches CPU)', worst === 0, `max mismatches=${worst}`);
  }

  // glider translates (+1,+1) every 4 generations
  {
    const CELLS = [[1, 2], [0, 1], [0, 0], [1, 0], [2, 0]];
    const ref = await seedGrid(page, CELLS.map(([x, y]) => [10 + x, 10 + y]));
    await page.evaluate(() => window.__life.step(4));
    const after = await gpuGrid(page);
    let ok = true;
    for (let y = 0; y < SIZE && ok; y++) {
      for (let x = 0; x < SIZE && ok; x++) {
        if (after[y * SIZE + x] !== ref[((y + 1) % SIZE) * SIZE + ((x + 1) % SIZE)]) ok = false;
      }
    }
    record('stage2: glider moves (+1,+1) per 4 generations', ok);
  }

  // ---- Stage 3: display + camera ----
  {
    const ALIVE = [235, 240, 255];
    const DEAD = [11, 11, 16];
    const near = (got, want) => Math.abs(got[0] - want[0]) <= 8 && Math.abs(got[1] - want[1]) <= 8 && Math.abs(got[2] - want[2]) <= 8;

    const screenAt = (p, wx, wy) => p.evaluate(([wx, wy]) => {
      const L = window.__life;
      const c = document.querySelector('canvas');
      const v = L.view();
      const px = Math.floor((wx - v[0]) / v[2] * c.width);
      const py = Math.floor((wy - v[1]) / v[3] * c.height);
      const b = L.readScreen(px, py, 1, 1);
      return [b[0], b[1], b[2]];
    }, [wx, wy]);

    await seedGrid(page, [[10, 10], [11, 10], [10, 11], [11, 11]]);
    const alivePx = await screenAt(page, 10.5, 10.5);
    const deadPx = await screenAt(page, 30.5, 30.5);
    record('stage3: grid visible, cells distinguishable', near(alivePx, ALIVE) && near(deadPx, DEAD), `alive=${alivePx} dead=${deadPx}`);

    // zoom-to-cursor: the world point under the cursor must not move
    await page.mouse.move(200, 150);
    const worldUnder = () => page.evaluate(() => {
      const L = window.__life;
      const c = document.querySelector('canvas');
      const v = L.view();
      const ux = 200 / c.clientWidth;
      const uy = 1 - 150 / c.clientHeight;
      return { wx: v[0] + ux * v[2], wy: v[1] + uy * v[3], cellsX: v[2] };
    });
    const before = await worldUnder();
    await page.mouse.wheel(0, -240);
    const after = await worldUnder();
    record(
      'stage3: zoom-to-cursor keeps world point fixed',
      Math.abs(after.wx - before.wx) < 1e-6 && Math.abs(after.wy - before.wy) < 1e-6 && after.cellsX < before.cellsX,
      `cellsX ${before.cellsX.toFixed(2)} -> ${after.cellsX.toFixed(2)}`,
    );

    // zoom grows the on-screen width of a seeded column
    const bar = [];
    for (let y = 0; y < SIZE; y++) bar.push([32, y]);
    await seedGrid(page, bar);
    const runLength = () => page.evaluate(() => {
      const L = window.__life;
      const c = document.querySelector('canvas');
      const b = L.readScreen(0, Math.floor(c.height / 2), c.width, 1);
      let min = -1;
      let max = -1;
      for (let i = 0; i < c.width; i++) {
        if (b[i * 4] > 128) {
          if (min < 0) min = i;
          max = i;
        }
      }
      return max >= 0 ? max - min + 1 : 0;
    });
    const runBefore = await runLength();
    await page.mouse.wheel(0, -240);
    const runAfter = await runLength();
    record('stage3: zoom-in widens cells on screen', runAfter > runBefore, `${runBefore}px -> ${runAfter}px`);

    // pan: drag (400,300) -> (450,320) must move the origin by the expected delta
    const v0 = await page.evaluate(() => window.__life.view());
    const dims = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      return [c.clientWidth, c.clientHeight];
    });
    await page.mouse.move(400, 300);
    await page.mouse.down();
    await page.mouse.move(450, 320);
    await page.mouse.up();
    const v1 = await page.evaluate(() => window.__life.view());
    const expX = v0[0] - (50 / dims[0]) * v0[2];
    const expY = v0[1] + (20 / dims[1]) * v0[3];
    record(
      'stage3: drag pan moves camera by expected delta',
      Math.abs(v1[0] - expX) < 1e-4 && Math.abs(v1[1] - expY) < 1e-4,
      `origin (${v0[0].toFixed(2)},${v0[1].toFixed(2)}) -> (${v1[0].toFixed(2)},${v1[1].toFixed(2)})`,
    );

    // resize after interaction keeps the camera
    const camBefore = await page.evaluate(() => window.__life.view());
    await page.setViewportSize({ width: 900, height: 500 });
    await page.waitForTimeout(200);
    const camAfter = await page.evaluate(() => window.__life.view());
    record('stage3: resize keeps camera after interaction', [0, 1, 2].every((i) => Math.abs(camBefore[i] - camAfter[i]) < 1e-9));

    // resize while untouched refits the view
    const page4 = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
    await page4.goto(`${base}?size=${SIZE}&sps=0.0001`);
    await page4.waitForFunction(() => !!window.__life);
    await page4.setViewportSize({ width: 640, height: 480 });
    await page4.waitForTimeout(200);
    const vRefit = await page4.evaluate(() => window.__life.view());
    const refitOk = Math.abs(vRefit[2] - SIZE) < 1e-6 && Math.abs(vRefit[0]) < 1e-6 && Math.abs(vRefit[1] - (SIZE / 2 - vRefit[3] / 2)) < 1e-6;
    record('stage3: resize refits while untouched', refitOk, JSON.stringify(vRefit.map((n) => +n.toFixed(3))));
    await page4.close();

    // 4096 display-only smoke: FPS must stay in the same class as a tiny grid.
    // Absolute FPS under software GL (SwiftShader) is environment-dependent and
    // is measured properly in Stage 5; here we assert 4096 does not tank vs 64.
    const measureFps = async (size) => {
      const p = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
      await p.addInitScript(() => {
        window.__counters = { drawArrays: 0 };
        const origDraw = WebGL2RenderingContext.prototype.drawArrays;
        WebGL2RenderingContext.prototype.drawArrays = function () { window.__counters.drawArrays++; return origDraw.apply(this, arguments); };
      });
      await p.goto(`${base}?size=${size}&sps=0.0001`);
      await p.waitForFunction(() => !!window.__life);
      await p.waitForTimeout(400);
      const d0 = await p.evaluate(() => window.__counters.drawArrays);
      await p.waitForTimeout(2000);
      const d1 = await p.evaluate(() => window.__counters.drawArrays);
      await p.close();
      return (d1 - d0) / 2;
    };
    const fpsBase = await measureFps(64);
    const fps4k = await measureFps(4096);
    record(
      'stage3: 4096 display FPS in same class as small grid',
      fps4k >= fpsBase * 0.6,
      `fps@64=${fpsBase.toFixed(1)} fps@4096=${fps4k.toFixed(1)}`,
    );
  }

  // ---- Stage 4: interaction, patterns, controls ----
  {
    await page.evaluate(() => {
      window.__uploads = { texSubImage2D: 0, texImage2D: 0, deleteTexture: 0 };
      const P = WebGL2RenderingContext.prototype;
      for (const [name, key] of [['texSubImage2D', 'texSubImage2D'], ['texImage2D', 'texImage2D'], ['deleteTexture', 'deleteTexture']]) {
        const orig = P[name];
        P[name] = function () { window.__uploads[key]++; return orig.apply(this, arguments); };
      }
    });
    const uploads = () => page.evaluate(() => window.__uploads);
    const gen = () => page.evaluate(() => window.__life.generation());
    const expectedTexel = (mx, my) => page.evaluate(([x, y]) => {
      const c = document.querySelector('canvas');
      const v = window.__life.view();
      return [Math.floor(v[0] + (x / c.clientWidth) * v[2]), Math.floor(v[1] + (1 - y / c.clientHeight) * v[3])];
    }, [mx, my]);
    const wrapIdx = (x, y) => (((y % SIZE) + SIZE) % SIZE) * SIZE + (((x % SIZE) + SIZE) % SIZE);

    // clear: single GPU upload, empty grid
    await page.click('#btn-clear');
    const upClear = await uploads();
    const gridClear = await gpuGrid(page);
    record('stage4: clear = 1 GPU upload, grid empty',
      upClear.texSubImage2D === 1 && upClear.texImage2D === 0 && gridClear.every((v) => v === 0),
      JSON.stringify(upClear));

    // randomize: single GPU upload, mixed state
    await page.click('#btn-random');
    const upRand = await uploads();
    const gridRand = await gpuGrid(page);
    let alive0 = 0;
    for (let i = 0; i < gridRand.length; i++) alive0 += gridRand[i];
    const ratio = alive0 / gridRand.length;
    record('stage4: randomize = 1 GPU upload, mixed state',
      upRand.texSubImage2D === 2 && upRand.texImage2D === 0 && ratio > 0.3 && ratio < 0.7,
      `uploads=${upRand.texSubImage2D} ratio=${ratio.toFixed(2)}`);

    // step button (paused): generation +1, exact CPU match
    const beforeStep = await gpuGrid(page);
    const refStep = cpuStep(beforeStep, SIZE);
    const g0 = await gen();
    await page.click('#btn-step');
    const g1 = await gen();
    const afterStep = await gpuGrid(page);
    record('stage4: step button = 1 exact generation',
      g1 === g0 + 1 && countDiff(refStep, afterStep) === 0, `gen ${g0} -> ${g1}`);

    // speed slider + play/pause drive stepping
    await page.evaluate(() => {
      const s = document.getElementById('speed');
      s.value = '40';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const draws0 = await page.evaluate(() => window.__counters.drawArrays);
    const gA = await gen();
    await page.click('#btn-play');
    await page.waitForTimeout(800);
    const gB = await gen();
    await page.click('#btn-play');
    const draws1 = await page.evaluate(() => window.__counters.drawArrays);
    const playLabel = await page.textContent('#btn-play');
    record('stage4: speed slider + play/pause drive stepping',
      gB - gA >= 5 && draws1 > draws0 && playLabel === 'Play',
      `${gB - gA} gens/0.8s, label=${playLabel}`);

    // paint via DOM at current camera (position A)
    await page.click('#btn-clear');
    await page.click('#btn-paint');
    const posA = [320, 240];
    const texA = await expectedTexel(posA[0], posA[1]);
    await page.mouse.move(posA[0], posA[1]);
    await page.mouse.down();
    await page.mouse.up();
    const gridA = await gpuGrid(page);
    let okA = true;
    for (let dy = -2; dy <= 2 && okA; dy++) {
      for (let dx = -2; dx <= 2 && okA; dx++) {
        if (gridA[wrapIdx(texA[0] + dx, texA[1] + dy)] !== 1) okA = false;
      }
    }
    okA = okA && gridA[wrapIdx(texA[0] + 3, texA[1])] === 0 && gridA[wrapIdx(texA[0], texA[1] + 3)] === 0;
    record('stage4: drag paints at camera position (DOM)', okA, `texel=(${texA[0]},${texA[1]})`);

    // change camera (pan + zoom), paint at position B, cell A stays
    await page.click('#btn-paint');
    await page.mouse.move(500, 350);
    await page.mouse.wheel(0, -200);
    await page.mouse.down();
    await page.mouse.move(560, 380);
    await page.mouse.up();
    await page.click('#btn-paint');
    const posB = [640, 300];
    const texB = await expectedTexel(posB[0], posB[1]);
    await page.mouse.move(posB[0], posB[1]);
    await page.mouse.down();
    await page.mouse.up();
    const gridB = await gpuGrid(page);
    let okB = true;
    for (let dy = -2; dy <= 2 && okB; dy++) {
      for (let dx = -2; dx <= 2 && okB; dx++) {
        if (gridB[wrapIdx(texB[0] + dx, texB[1] + dy)] !== 1) okB = false;
      }
    }
    okB = okB && gridB[wrapIdx(texA[0], texA[1])] === 1;
    record('stage4: paint follows new zoom/pan, earlier paint intact', okB, `texelB=(${texB[0]},${texB[1]})`);

    // brush across the torus seam
    await page.click('#btn-paint');
    await page.evaluate(() => {
      window.__life.clear();
      window.__life.stampBrush(window.__life.size - 1, 10, 2);
    });
    const seam = await gpuGrid(page);
    let seamOk = true;
    for (let dy = -2; dy <= 2 && seamOk; dy++) {
      for (let dx = -2; dx <= 2 && seamOk; dx++) {
        if (seam[wrapIdx(SIZE - 1 + dx, 10 + dy)] !== 1) seamOk = false;
      }
    }
    seamOk = seamOk && seam[10 * SIZE + SIZE - 4] === 0 && seam[10 * SIZE + 3] === 0;
    record('stage4: brush wraps across torus seam', seamOk);

    // brush across both seams at a corner
    await page.evaluate(() => {
      const s = window.__life.size;
      window.__life.clear();
      window.__life.stampBrush(s - 2, s - 2, 2);
    });
    const corner = await gpuGrid(page);
    let cornerOk = true;
    for (let dy = -2; dy <= 2 && cornerOk; dy++) {
      for (let dx = -2; dx <= 2 && cornerOk; dx++) {
        if (corner[wrapIdx(SIZE - 2 + dx, SIZE - 2 + dy)] !== 1) cornerOk = false;
      }
    }
    cornerOk = cornerOk
      && corner[wrapIdx(0, 0)] === 1
      && corner[wrapIdx(SIZE - 1, 0)] === 1
      && corner[wrapIdx(0, SIZE - 1)] === 1
      && corner[wrapIdx(1, 1)] === 0
      && corner[wrapIdx(2, SIZE - 2)] === 0;
    record('stage4: brush wraps across both seams (corner)', cornerOk,
      `alive=${corner.reduce((a, b) => a + b, 0)}/25`);

    // glider pattern stamped exactly
    const GLIDER_CELLS = [[0, 0], [1, 0], [2, 0], [0, 1], [1, 2]];
    await page.evaluate(() => {
      window.__life.clear();
      window.__life.stampPattern('glider', 7, 9);
    });
    const gliderGrid = await gpuGrid(page);
    const gliderWant = new Uint8Array(SIZE * SIZE);
    for (const [x, y] of GLIDER_CELLS) gliderWant[(9 + y) * SIZE + (7 + x)] = 1;
    record('stage4: glider pattern stamped exactly', countDiff(gliderGrid, gliderWant) === 0);

    // blinker stamps and evolves one generation exactly
    await page.evaluate(() => {
      window.__life.clear();
      window.__life.stampPattern('blinker', 20, 30);
    });
    const blinkBefore = await gpuGrid(page);
    const blinkRef = cpuStep(blinkBefore, SIZE);
    await page.evaluate(() => window.__life.step(1));
    const blinkAfter = await gpuGrid(page);
    record('stage4: blinker stamps and evolves correctly', countDiff(blinkRef, blinkAfter) === 0);

    // Gosper gun: fingerprint, CPU-exact evolution, population growth (emission)
    const GUN_CELLS = [
      [24, 0], [22, 1], [24, 1],
      [12, 2], [13, 2], [20, 2], [21, 2], [34, 2], [35, 2],
      [11, 3], [15, 3], [20, 3], [21, 3], [34, 3], [35, 3],
      [0, 4], [1, 4], [10, 4], [16, 4], [20, 4], [21, 4],
      [0, 5], [1, 5], [10, 5], [14, 5], [16, 5], [17, 5], [22, 5], [24, 5],
      [10, 6], [16, 6], [24, 6], [11, 7], [15, 7], [12, 8], [13, 8],
    ];
    await page.evaluate(() => {
      window.__life.clear();
      window.__life.stampPattern('gun', 4, 4);
    });
    const gunStamped = await gpuGrid(page);
    const rowWant = [1, 2, 6, 6, 6, 8, 3, 2, 2];
    let rowsOk = true;
    for (let r = 0; r < 9; r++) {
      let c = 0;
      for (let x = 0; x < 36; x++) c += gunStamped[(4 + r) * SIZE + (4 + x)];
      if (c !== rowWant[r]) rowsOk = false;
    }
    record('stage4: Gosper gun fingerprint (36 cells, canonical rows)', rowsOk);

    let refGun = new Uint8Array(SIZE * SIZE);
    for (const [x, y] of GUN_CELLS) refGun[(4 + y) * SIZE + (4 + x)] = 1;
    let gunExact = true;
    for (let g = 1; g <= 60; g++) {
      refGun = cpuStep(refGun, SIZE);
      await page.evaluate(() => window.__life.step(1));
      if (g === 10 || g === 30 || g === 60) {
        const got = await gpuGrid(page);
        if (countDiff(refGun, got) !== 0) gunExact = false;
      }
    }
    const gunFinal = await gpuGrid(page);
    let pop60 = 0;
    for (let i = 0; i < gunFinal.length; i++) pop60 += gunFinal[i];
    record('stage4: gun matches CPU for 60 generations', gunExact);
    record('stage4: gun emits gliders (population grows)', pop60 > 41, `pop@60=${pop60}`);

    // pattern stamped via toolbar (DOM)
    await page.click('#btn-clear');
    await page.selectOption('#pattern', 'glider');
    await page.click('#btn-paint');
    const posP = [400, 260];
    const texP = await expectedTexel(posP[0], posP[1]);
    await page.mouse.move(posP[0], posP[1]);
    await page.mouse.down();
    await page.mouse.up();
    const domPattern = await gpuGrid(page);
    const domWant = new Uint8Array(SIZE * SIZE);
    for (const [x, y] of GLIDER_CELLS) domWant[wrapIdx(texP[0] + x, texP[1] + y)] = 1;
    record('stage4: pattern stamp via toolbar (DOM)', countDiff(domPattern, domWant) === 0, `texel=(${texP[0]},${texP[1]})`);
    await page.selectOption('#pattern', 'brush');
    await page.click('#btn-paint');

    // grid switch to 2048: reallocated once, rule still exact
    await page.selectOption('#grid-size', '2048');
    await page.waitForTimeout(100);
    const s2048 = await page.evaluate(() => window.__life.size);
    const noErr2048 = await page.evaluate(() => !document.getElementById('error'));
    await page.evaluate(() => {
      window.__life.clear();
      window.__life.stampPattern('blinker', 100, 100);
    });
    const b2048 = await gpuGrid(page);
    const ref2048 = cpuStep(b2048, 2048);
    await page.evaluate(() => window.__life.step(1));
    const a2048 = await gpuGrid(page);
    const up2048 = await uploads();
    record('stage4: grid switch to 2048 keeps rule correct',
      s2048 === 2048 && noErr2048 && countDiff(ref2048, a2048) === 0
      && up2048.texImage2D === 2 && up2048.deleteTexture === 2,
      `texImage2D=${up2048.texImage2D} deleteTexture=${up2048.deleteTexture}`);

    // grid switch to 4096: works, blinker flips correctly
    await page.selectOption('#grid-size', '4096');
    const s4096 = await page.evaluate(() => window.__life.size);
    await page.evaluate(() => {
      window.__life.clear();
      window.__life.stampPattern('blinker', 500, 500);
    });
    const g4096a = await gen();
    await page.evaluate(() => window.__life.step(1));
    const g4096b = await gen();
    const regRaw = await page.evaluate(() => Array.from(window.__life.read(499, 499, 3, 3)));
    const reg = [];
    for (let i = 0; i < 9; i++) reg.push(regRaw[i * 4] > 127 ? 1 : 0);
    const regWant = [0, 0, 1, 0, 0, 1, 0, 0, 1];
    const up4096 = await uploads();
    record('stage4: grid switch to 4096 works, rule correct',
      s4096 === 4096 && g4096b === g4096a + 1 && reg.every((v, i) => v === regWant[i])
      && up4096.texImage2D === 4 && up4096.deleteTexture === 4,
      `size=${s4096} gens=${g4096a}->${g4096b} texImage2D=${up4096.texImage2D} `
      + `deleteTexture=${up4096.deleteTexture} reg=${JSON.stringify(reg)}`);

    // grid options sanity
    const opts = await page.evaluate(() => Array.from(document.getElementById('grid-size').options).map((o) => Number(o.value)));
    record('stage4: grid options are powers of two <= 4096',
      opts.every((v) => v > 0 && (v & (v - 1)) === 0 && v <= 4096), JSON.stringify(opts));
  }

  // ---- Stage 5: validation goldens, HUD, seed, perf ----
  {
    // Gosper gun golden checkpoints (canonical populations + emitted-glider offsets).
    // Offsets derived from the B3/S23 CPU reference with the canonical gun at (10,10)
    // on a 128^2 grid: gun activity stays inside x 10..45, y 10..18; gliders leave it.
    const GUN_OX = 10;
    const GUN_OY = 10;
    const GUN_OUT30 = [[33, 19], [34, 20], [35, 20], [33, 21], [34, 21]];
    const GUN_OUT60 = [[33, 19], [34, 20], [35, 20], [33, 21], [34, 21], [40, 27], [42, 27], [41, 28], [42, 28], [41, 29]];
    const popOf = (grid) => { let p = 0; for (let i = 0; i < grid.length; i++) p += grid[i]; return p; };
    const outsideCells = (grid, n) => {
      const cells = [];
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          if (!grid[y * n + x]) continue;
          if (x >= GUN_OX && x <= GUN_OX + 35 && y >= GUN_OY && y <= GUN_OY + 8) continue;
          cells.push([x, y]);
        }
      }
      return cells;
    };

    const gunPage = await browser.newPage({ viewport: { width: 400, height: 300 } });
    const gunErrs = [];
    gunPage.on('pageerror', (e) => gunErrs.push(String(e)));
    await gunPage.goto(`${base}?size=128&sps=0.0001`, { timeout: 60000 });
    await gunPage.waitForFunction(() => !!window.__life);
    await gunPage.evaluate(() => {
      window.__life.setAuto(false);
      window.__life.clear();
      window.__life.stampPattern('gun', 10, 10);
    });
    const gun0 = await gpuGrid(gunPage);
    const out0 = outsideCells(gun0, 128);
    await gunPage.evaluate(() => window.__life.step(30));
    const gun30 = await gpuGrid(gunPage);
    const out30 = outsideCells(gun30, 128);
    await gunPage.evaluate(() => window.__life.step(30));
    const gun60 = await gpuGrid(gunPage);
    const out60 = outsideCells(gun60, 128);
    const gunErrFree = gunErrs.length === 0 && (await gunPage.evaluate(() => !document.getElementById('error')));
    await gunPage.close();
    record('stage5: gun golden populations (36/41/46 at gen 0/30/60)',
      popOf(gun0) === 36 && popOf(gun30) === 41 && popOf(gun60) === 46 && gunErrFree,
      `pops=${popOf(gun0)}/${popOf(gun30)}/${popOf(gun60)}`);
    record('stage5: gun golden emitted-glider offsets',
      JSON.stringify(out0) === '[]'
      && JSON.stringify(out30) === JSON.stringify(GUN_OUT30)
      && JSON.stringify(out60) === JSON.stringify(GUN_OUT60),
      `out30=${JSON.stringify(out30)} out60=${JSON.stringify(out60)}`);

    // HUD: present, correct format, ~1 Hz cadence (measured display-only so frames
    // are fast enough for a bounded window), then gen advances while auto is on.
    const gen = () => page.evaluate(() => window.__life.generation());
    const hudExists = await page.evaluate(() => !!document.getElementById('hud'));
    const hudCadence = await page.evaluate(() => new Promise((resolve) => {
      const hud = document.getElementById('hud');
      let changes = 0;
      const obs = new MutationObserver(() => { changes++; });
      obs.observe(hud, { childList: true, characterData: true, subtree: true });
      setTimeout(() => {
        obs.disconnect();
        resolve({ changes, text: hud.textContent });
      }, 1200);
    }));
    const hudMatch = /^(\d+) fps \| (\d+) gen\/s \| gen (\d+)/.exec(hudCadence.text);
    record('stage5: HUD present, ~1 Hz cadence, format fps|gen/s|gen',
      hudExists && !!hudMatch && hudCadence.changes >= 1 && hudCadence.changes <= 3,
      `changes=${hudCadence.changes} text="${hudCadence.text}"`);

    const genBeforeHud = await gen();
    await page.click('#btn-play');
    await page.waitForTimeout(3500);
    const genAfterHud = await gen();
    await page.click('#btn-play');
    const hudPlaying = await page.textContent('#hud');
    const hudGen = /gen (\d+)/.exec(hudPlaying);
    record('stage5: HUD tracks simulation while running',
      genAfterHud > genBeforeHud && !!hudGen && Number(hudGen[1]) > 0,
      `gen ${genBeforeHud} -> ${genAfterHud}, hud="${hudPlaying}"`);

    // ?seed= determinism: same seed twice identical, different seeds differ, default empty
    const loadSeed = async (query) => {
      const p = await browser.newPage({ viewport: { width: 220, height: 160 } });
      await p.addInitScript(() => {
        window.__up = { texSubImage2D: 0 };
        const orig = WebGL2RenderingContext.prototype.texSubImage2D;
        WebGL2RenderingContext.prototype.texSubImage2D = function () { window.__up.texSubImage2D++; return orig.apply(this, arguments); };
      });
      await p.goto(`${base}?size=64&sps=0.0001${query ? '&' + query : ''}`, { timeout: 60000 });
      await p.waitForFunction(() => !!window.__life);
      const grid = await gpuGrid(p);
      const ups = await p.evaluate(() => window.__up.texSubImage2D);
      await p.close();
      return { grid, ups };
    };
    const seedA = await loadSeed('seed=demo');
    const seedB = await loadSeed('seed=demo');
    const seedC = await loadSeed('seed=1');
    const seedDefault = await loadSeed('');
    const gridsEq = (x, y) => countDiff(x, y) === 0;
    const aliveA = seedA.grid.reduce((a, b) => a + b, 0);
    record('stage5: ?seed=demo deterministic across loads (single upload)',
      gridsEq(seedA.grid, seedB.grid) && seedA.ups === 1 && seedB.ups === 1 && aliveA > 0,
      `alive=${aliveA} uploads=${seedA.ups}/${seedB.ups}`);
    record('stage5: different seeds differ; default load stays empty',
      !gridsEq(seedA.grid, seedC.grid) && gridsEq(seedDefault.grid, new Uint8Array(SIZE * SIZE))
      && seedC.ups === 1 && seedDefault.ups === 0,
      `seed1ups=${seedC.ups} defaultups=${seedDefault.ups}`);

    // MAX_TEXTURE_SIZE exposed; selector caps at min(4096, MAX_TEXTURE_SIZE)
    const capInfo = await page.evaluate(() => ({
      visible: Array.from(document.getElementById('grid-size').options)
        .filter((o) => !o.hidden).map((o) => Number(o.value)),
      max: window.__life.maxTextureSize,
    }));
    record('stage5: selector caps at min(4096, MAX_TEXTURE_SIZE)',
      capInfo.max >= 1024 && capInfo.visible.length > 0
      && capInfo.visible.every((v) => v <= Math.min(4096, capInfo.max)),
      `max=${capInfo.max} visible=${JSON.stringify(capInfo.visible)}`);

    // 4096^2 with the sim running every frame: profiled for the README (software
    // GL makes the O(size^2) sim shader the bottleneck — see issue #5 plan adjustment).
    const measureSimFps = async (gridSize) => {
      const p = await browser.newPage({ viewport: { width: 512, height: 512 } });
      await p.addInitScript(() => {
        window.__counters = { drawArrays: 0 };
        const origDraw = WebGL2RenderingContext.prototype.drawArrays;
        WebGL2RenderingContext.prototype.drawArrays = function () { window.__counters.drawArrays++; return origDraw.apply(this, arguments); };
      });
      await p.goto(`${base}?size=${gridSize}&sps=120`, { timeout: 60000 });
      await p.waitForFunction(() => !!window.__life);
      await p.waitForTimeout(500);
      const d0 = await p.evaluate(() => window.__counters.drawArrays);
      const g0 = await p.evaluate(() => window.__life.generation());
      await p.waitForTimeout(2000);
      let elapsed = 2;
      let d1 = await p.evaluate(() => window.__counters.drawArrays);
      let g1 = await p.evaluate(() => window.__life.generation());
      // Under heavy system load a single 4096^2 software-GL frame can outlast the
      // base window; poll in 1 s slices until a generation completes (bounded at +8 s).
      for (let extra = 0; extra < 8 && g1 === g0; extra++) {
        await p.waitForTimeout(1000);
        elapsed += 1;
        d1 = await p.evaluate(() => window.__counters.drawArrays);
        g1 = await p.evaluate(() => window.__life.generation());
      }
      const err = await p.evaluate(() => !!document.getElementById('error'));
      await p.close();
      return { fps: (d1 - d0) / elapsed, genDelta: g1 - g0, err };
    };
    const sim64 = await measureSimFps(64);
    const sim4k = await measureSimFps(4096);
    record('stage5: 4096^2 sim+display runs and advances generations (profiled)',
      !sim4k.err && !sim64.err && sim4k.genDelta > 0 && sim64.genDelta > 0,
      `sim+display fps@64=${sim64.fps.toFixed(1)} (gen+${sim64.genDelta}), `
      + `fps@4096=${sim4k.fps.toFixed(1)} (gen+${sim4k.genDelta})`);
  }

  // ---- Stage 6: RGBA8 byte layout, age, raw readback ----
  {
    const raw1 = (p, x, y) => p.evaluate(
      (coords) => Array.from(window.__life.readRaw(coords[0], coords[1], 1, 1)), [x, y],
    );
    await page.evaluate(() => { window.__life.setAuto(false); window.__life.clear(); });
    const rawDead = await raw1(page, 5, 5);
    await page.evaluate(() => window.__life.stampBrush(10, 10, 0));
    const rawAlive = await raw1(page, 10, 10);
    record('stage6: RGBA8 byte layout via normalized round-trip (dead=(0,8,12,0), alive=(1,8,12,0))',
      rawDead.join() === '0,8,12,0' && rawAlive.join() === '1,8,12,0',
      `dead=[${rawDead}] alive=[${rawAlive}]`);

    // Age: a seeded block (still life) ages 1 per gen, saturating at 127 (R=255).
    const seedBlock = () => page.evaluate(() => {
      window.__life.clear();
      const d = new Uint8Array(64 * 64 * 4);
      for (const c of [[30, 30], [31, 30], [30, 31], [31, 31]]) {
        d[(c[1] * 64 + c[0]) * 4] = 255;
        d[(c[1] * 64 + c[0]) * 4 + 3] = 255;
      }
      window.__life.seed(64, 64, d);
      window.__life.step(1);
    });
    await seedBlock();
    const age1 = await raw1(page, 30, 30);
    await page.evaluate(() => window.__life.step(129));
    const ageSat = await raw1(page, 30, 30);
    const blockAlive = await page.evaluate(() => window.__life.read(30, 30, 1, 1)[0] === 255);
    record('stage6: age increments (R=3) then saturates at 127 (R=255); still life stable',
      age1.join() === '3,8,12,0' && ageSat.join() === '255,8,12,0' && blockAlive,
      `age1=[${age1}] age130=[${ageSat}]`);

    // Death resets age to 0 but keeps the stored Conway masks.
    await page.evaluate(() => {
      window.__life.clear();
      const d = new Uint8Array(64 * 64 * 4);
      for (const c of [[29, 30], [30, 30], [31, 30]]) {
        d[(c[1] * 64 + c[0]) * 4] = 255;
        d[(c[1] * 64 + c[0]) * 4 + 3] = 255;
      }
      window.__life.seed(64, 64, d);
      window.__life.step(1);
    });
    const diedCell = await raw1(page, 29, 30);
    record('stage6: death resets age to 0 and keeps Conway masks',
      diedCell.join() === '0,8,12,0', `died=[${diedCell}]`);
  }

  // ---- Stage 7: per-cell genomes, mask consumption, deterministic inheritance ----
  {
    // Stage 4 left the shared page on a 4096² grid; reload at SIZE so the torus
    // wrap matches the 64² CPU references below.
    await page.goto(`${base}?size=${SIZE}&sps=0.0001`);
    await page.waitForFunction(() => !!window.__life || !!document.getElementById('error'));
    await page.evaluate(() => window.__life.setAuto(false));
    const raw1 = (p, x, y) => p.evaluate(
      (coords) => Array.from(window.__life.readRaw(coords[0], coords[1], 1, 1)), [x, y],
    );

    // Stamp with HighLife selected: readRaw shows G=0b01001000 (B36), B=0b00001100 (S23).
    // Then back to Conway: stamp shows G=0x08.
    await page.evaluate(() => {
      window.__life.setAuto(false);
      window.__life.setGenome('highlife');
      window.__life.clear();
      window.__life.stampBrush(10, 10, 0);
    });
    const hlStamp = await raw1(page, 10, 10);
    await page.evaluate(() => {
      window.__life.setGenome('conway');
      window.__life.clear();
      window.__life.stampBrush(11, 11, 0);
    });
    const cwStamp = await raw1(page, 11, 11);
    record('stage7: brush stamping uses selected genome (HighLife G=0x48/B=0x0C, Conway G=0x08)',
      hlStamp.join() === '1,72,12,0' && cwStamp.join() === '1,8,12,0',
      `highlife=[${hlStamp}] conway=[${cwStamp}]`);

    // Inheritance: blinker of HighLife cells; the cell above the center is born with
    // n==3 from three living HighLife neighbors and must inherit G=0x48/B=0x0C.
    await page.evaluate(() => {
      window.__life.setGenome('highlife');
      window.__life.clear();
      window.__life.stampPattern('blinker', 20, 30);
      window.__life.step(1);
    });
    const inherited = await raw1(page, 21, 31);
    record('stage7: newborn inherits HighLife genome from living neighbors',
      inherited.join() === '3,72,12,0', `inherited=[${inherited}]`);

    // n==8 corner: 3x3 solid block — center has n==8 and must die (A bit1 = 0 for
    // Conway/HighLife), matching cpuStepGenome which takes the same A-bits path.
    await page.evaluate(() => {
      window.__life.setGenome('conway');
      window.__life.clear();
      for (let y = 9; y <= 11; y++) {
        for (let x = 9; x <= 11; x++) window.__life.stampBrush(x, y, 0);
      }
    });
    const n8State0 = await page.evaluate(() => Array.from(window.__life.readRaw(0, 0, 64, 64)));
    await page.evaluate(() => window.__life.step(1));
    const n8Gpu = await page.evaluate(() => Array.from(window.__life.readRaw(0, 0, 64, 64)));
    const n8Cpu = cpuStepGenome(Uint8Array.from(n8State0), 64, 0, 0);
    let n8Mismatch = 0;
    for (let i = 0; i < n8Cpu.length; i++) if (n8Cpu[i] !== n8Gpu[i]) n8Mismatch++;
    const centerAfter = await raw1(page, 10, 10);
    record('stage7: n==8 indexes A bits (center of 3x3 solid dies; GPU matches CPU)',
      n8Mismatch === 0 && centerAfter.join() === '0,8,12,0',
      `mismatches=${n8Mismatch} center=[${centerAfter}]`);

    // Mixed-genome equivalence: half Conway / half HighLife + crossing gliders;
    // GPU vs cpuStepGenome — full uvec4 grids equal after 50 gens (hash parity).
    await page.evaluate(() => {
      window.__life.setGenome('conway');
      window.__life.clear();
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const left = x < 32;
          const alive = left ? ((x * 3 + y * 5) % 7 < 3) : ((x * 5 + y * 3) % 11 < 4);
          if (alive) {
            window.__life.setGenome(left ? 'conway' : 'highlife');
            window.__life.stampBrush(x, y, 0);
          }
        }
      }
      window.__life.setGenome('conway');
      window.__life.stampPattern('glider', 28, 28);
      window.__life.setGenome('highlife');
      window.__life.stampPattern('glider', 36, 24);
      window.__life.setGenome('conway');
    });
    const mixed0 = await page.evaluate(() => Array.from(window.__life.readRaw(0, 0, 64, 64)));
    const mixedGen0 = await page.evaluate(() => window.__life.generation());
    await page.evaluate(() => window.__life.step(50));
    const mixedGpu = await page.evaluate(() => Array.from(window.__life.readRaw(0, 0, 64, 64)));
    let mixedCpu = Uint8Array.from(mixed0);
    for (let g = 0; g < 50; g++) mixedCpu = cpuStepGenome(mixedCpu, 64, mixedGen0 + g, 0);
    let mixedMismatch = 0;
    let firstBad = -1;
    for (let i = 0; i < mixedCpu.length; i++) {
      if (mixedCpu[i] !== mixedGpu[i]) {
        mixedMismatch++;
        if (firstBad < 0) firstBad = i;
      }
    }
    record('stage7: mixed Conway/HighLife grid matches CPU reference for 50 gens (hash parity)',
      mixedMismatch === 0,
      mixedMismatch
        ? `${mixedMismatch} byte mismatches, first @${firstBad}: cpu=[${mixedCpu.slice(firstBad, firstBad + 4)}] gpu=[${mixedGpu.slice(firstBad, firstBad + 4)}]`
        : 'bit-exact over 50 gens');
  }

  // ---- Stage 8: mutation, lineages, lineage color, HUD count ----
  {
    const hsl2rgbRef = (lid) => {
      const h = ((lid * 0.6180339887) % 1) * 360;
      const s = 0.65;
      const l = 0.55;
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const hp = h / 60;
      const x = c * (1 - Math.abs((hp % 2) - 1));
      let rgb;
      if (hp < 1) rgb = [c, x, 0];
      else if (hp < 2) rgb = [x, c, 0];
      else if (hp < 3) rgb = [0, c, x];
      else if (hp < 4) rgb = [0, x, c];
      else if (hp < 5) rgb = [x, 0, c];
      else rgb = [c, 0, x];
      const m = l - c * 0.5;
      return rgb.map((v) => Math.round((v + m) * 255));
    };
    const near8 = (got, want) => Math.abs(got[0] - want[0]) <= 8 && Math.abs(got[1] - want[1]) <= 8 && Math.abs(got[2] - want[2]) <= 8;
    const stampMixed = () => page.evaluate(() => {
      window.__life.setAuto(false);
      window.__life.setGenome('conway');
      window.__life.clear();
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const left = x < 32;
          const alive = left ? ((x * 3 + y * 5) % 7 < 3) : ((x * 5 + y * 3) % 11 < 4);
          if (alive) {
            window.__life.setGenome(left ? 'conway' : 'highlife');
            window.__life.stampBrush(x, y, 0);
          }
        }
      }
      window.__life.setGenome('conway');
    });
    const readRaw64 = () => page.evaluate(() => Array.from(window.__life.readRaw(0, 0, 64, 64)));
    const countIds = (buf) => {
      const seen = new Set();
      for (let i = 0; i < buf.length; i += 4) {
        if (buf[i] & 1) seen.add(buf[i + 3] >> 2);
      }
      return seen;
    };

    // mut absent: rule stays stage-7 bit-exact (vs the stage-7 CPU ref chain)
    // and every lineage id stays 0.
    await page.goto(`${base}?size=${SIZE}&sps=0.0001`);
    await page.waitForFunction(() => !!window.__life || !!document.getElementById('error'));
    await stampMixed();
    const m0s0 = Uint8Array.from(await readRaw64());
    const m0gen = await page.evaluate(() => window.__life.generation());
    await page.evaluate(() => window.__life.step(30));
    const m0gpu = Uint8Array.from(await readRaw64());
    let m0cpu = m0s0;
    for (let g = 0; g < 30; g++) m0cpu = cpuStepGenomeMut(m0cpu, 64, m0gen + g, 0, 0);
    let m0Mismatch = 0;
    for (let i = 0; i < m0cpu.length; i++) if (m0cpu[i] !== m0gpu[i]) m0Mismatch++;
    const m0Ids = countIds(m0gpu);
    record('stage8: mut absent/0 keeps stage-7 bit-exact and all lineage ids 0',
      m0Mismatch === 0 && [...m0Ids].every((id) => id === 0),
      `mismatches=${m0Mismatch} ids=${[...m0Ids].join('/')}`);

    // HUD on a pure Conway world (paused): lineages: 1.
    await page.evaluate(() => {
      window.__life.setGenome('conway');
      window.__life.clear();
      window.__life.stampPattern('blinker', 20, 30);
      window.__life.setAuto(false);
    });
    await page.waitForTimeout(1500);
    const hudPure = await page.evaluate(() => document.getElementById('hud').textContent);
    const hudPureN = /lineages: (\d+)/.exec(hudPure);
    record('stage8: HUD shows lineages count (pure Conway world = 1)',
      !!hudPureN && Number(hudPureN[1]) === 1, `hud="${hudPure}"`);

    // mut=0.15: births mutate — lineage ids appear in A bits2-7; GPU matches
    // the mutation+lineage CPU ref bit-exactly for 50 gens; paused HUD counts
    // the distinct living lineages (>= 2 after mutations).
    await page.goto(`${base}?size=${SIZE}&sps=0.0001&mut=0.15`);
    await page.waitForFunction(() => !!window.__life || !!document.getElementById('error'));
    await stampMixed();
    const m1s0 = Uint8Array.from(await readRaw64());
    const m1gen = await page.evaluate(() => window.__life.generation());
    await page.evaluate(() => window.__life.step(5));
    const m1early = Uint8Array.from(await readRaw64());

    // Color probe while the page is still at the snapshot generation (later
    // gens extinguish lid0 and move the cells): a lineage-0 alive cell keeps
    // the classic color; a mutated cell matches the golden-angle HSL ref.
    // Camera-constrained search — only cells inside the fitted view are probed.
    const v8 = await page.evaluate(() => window.__life.view());
    const yMin = Math.max(0, Math.ceil(v8[1]));
    const yMax = Math.min(63, Math.floor(v8[1] + v8[3]));
    const xMin = Math.max(0, Math.ceil(v8[0]));
    const xMax = Math.min(63, Math.floor(v8[0] + v8[2]));
    let cell0 = -1;
    let cellMut = -1;
    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        const i = (y * 64 + x) * 4;
        if (!(m1early[i] & 1)) continue;
        const lid = m1early[i + 3] >> 2;
        if (lid === 0 && cell0 < 0) cell0 = y * 64 + x;
        if (lid !== 0 && cellMut < 0) cellMut = y * 64 + x;
      }
    }
    const screenAt = (wx, wy) => page.evaluate(([wx, wy]) => {
      const L = window.__life;
      const c = document.querySelector('canvas');
      const v = L.view();
      const px = Math.floor((wx - v[0]) / v[2] * c.width);
      const py = Math.floor((wy - v[1]) / v[3] * c.height);
      const b = L.readScreen(px, py, 1, 1);
      return [b[0], b[1], b[2]];
    }, [wx, wy]);
    if (cell0 >= 0 && cellMut >= 0) {
      const px0 = await screenAt((cell0 % 64) + 0.5, Math.floor(cell0 / 64) + 0.5);
      const lidMut = m1early[cellMut * 4 + 3] >> 2;
      const pxMut = await screenAt((cellMut % 64) + 0.5, Math.floor(cellMut / 64) + 0.5);
      const refMut = hsl2rgbRef(lidMut);
      record('stage8: lineage 0 keeps classic color; mutated lineage matches HSL ref',
        near8(px0, [235, 240, 255]) && near8(pxMut, refMut) && !near8(pxMut, [235, 240, 255]),
        `lid0=${px0} lid${lidMut}=${pxMut} ref=${refMut}`);
    } else {
      record('stage8: lineage 0 keeps classic color; mutated lineage matches HSL ref',
        false, `cells not found: lid0=${cell0} mut=${cellMut}`);
    }

    await page.evaluate(() => window.__life.step(45));
    const m1gpu = Uint8Array.from(await readRaw64());
    let m1cpu = m1s0;
    for (let g = 0; g < 50; g++) m1cpu = cpuStepGenomeMut(m1cpu, 64, m1gen + g, 0, 1500);
    let m1Mismatch = 0;
    for (let i = 0; i < m1cpu.length; i++) if (m1cpu[i] !== m1gpu[i]) m1Mismatch++;
    const m1Ids = countIds(m1gpu);
    await page.waitForTimeout(1500);
    const hudMut = await page.evaluate(() => document.getElementById('hud').textContent);
    const hudMutN = /lineages: (\d+)/.exec(hudMut);
    record('stage8: mut>0 produces lineage ids; GPU matches CPU ref for 50 gens',
      m1Mismatch === 0 && m1Ids.size >= 2 && !!hudMutN && Number(hudMutN[1]) >= 2,
      `mismatches=${m1Mismatch} distinctIds=${m1Ids.size} hud="${hudMut}"`);

    // Determinism: same ?seed=+?mut= twice -> identical grids; different mut
    // diverges. Initial fill + hash both come from ?seed=.
    const loadMut = async (query) => {
      const p = await browser.newPage({ viewport: { width: 220, height: 160 } });
      await p.goto(`${base}?size=64&sps=0.0001&${query}`);
      await p.waitForFunction(() => !!window.__life);
      await p.evaluate(() => window.__life.setAuto(false));
      await p.evaluate(() => window.__life.step(15));
      const grid = Uint8Array.from(await p.evaluate(() => Array.from(window.__life.readRaw(0, 0, 64, 64))));
      await p.close();
      return grid;
    };
    const eqBuf = (x, y) => {
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
      return true;
    };
    const detA = await loadMut('seed=7&mut=0.1');
    const detB = await loadMut('seed=7&mut=0.1');
    const detC = await loadMut('seed=7&mut=0.2');
    record('stage8: ?seed=+?mut= deterministic across loads; different mut diverges',
      eqBuf(detA, detB) && !eqBuf(detA, detC),
      `A==B ${eqBuf(detA, detB)}, A!=C ${!eqBuf(detA, detC)}`);
  }

  // ---- Loop hygiene with auto stepping on (second page) ----
  {
    const page2 = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page2.addInitScript(() => {
      window.__counters = { textures: 0, framebuffers: 0, readPixels: 0, drawArrays: 0 };
      const W2 = WebGL2RenderingContext.prototype;
      for (const [name, key] of [['createTexture', 'textures'], ['createFramebuffer', 'framebuffers']]) {
        const orig = W2[name];
        W2[name] = function () { window.__counters[key]++; return orig.apply(this, arguments); };
      }
      const origRead = W2.readPixels;
      W2.readPixels = function () { window.__counters.readPixels++; return origRead.apply(this, arguments); };
      const origDraw = W2.drawArrays;
      W2.drawArrays = function () { window.__counters.drawArrays++; return origDraw.apply(this, arguments); };
    });
    await page2.goto(`${base}?size=${SIZE}&sps=10`);
    await page2.waitForFunction(() => !!window.__life);
    await page2.waitForTimeout(1200);
    const c = await page2.evaluate(() => window.__counters);
    record('loop: no GPU readback while running', c.readPixels === 0, `readPixels=${c.readPixels}`);
    record('loop: no extra allocations while running', c.textures === 2 && c.framebuffers === 2, JSON.stringify(c));
    await page2.close();
  }

  // ---- Stage 9: novelty explorer (unit + determinism + smoke) ----
  {
    const explore = require(path.join(ROOT, 'tools', 'explore.js'));
    const ffmpegHere = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

    // Unit: boring filters classify die / freeze / noise correctly.
    const frozenM = {
      vec: {
        activityMean: 0.01, activityStd: 0, spatialEntropy: 0.2, compressibility: 0.1,
        movingComponents: 0, persistence: 1, lineageDiversity: 0, stability: 1,
      },
      finalPop: 100, maxPop: 100,
    };
    const diedM = { vec: frozenM.vec, finalPop: 0, maxPop: 100 };
    const noiseM = {
      vec: { ...frozenM.vec, activityMean: 0.5, compressibility: 0.8, stability: 0.1 },
      finalPop: 2000, maxPop: 3000,
    };
    const interestingM = {
      vec: {
        activityMean: 0.2, activityStd: 0.1, spatialEntropy: 0.6, compressibility: 0.3,
        movingComponents: 0.2, persistence: 0.7, lineageDiversity: 0.1, stability: 0.5,
      },
      finalPop: 1000, maxPop: 2000,
    };
    record('stage9: boring filters (dies/frozen/noise) classify correctly',
      explore.isBoring(diedM).died === true
      && explore.isBoring(frozenM).frozen === true
      && explore.isBoring(noiseM).noise === true
      && explore.isBoring(interestingM).any === false,
      `died=${JSON.stringify(explore.isBoring(diedM).died)} frozen=${JSON.stringify(explore.isBoring(frozenM).frozen)} noise=${JSON.stringify(explore.isBoring(noiseM).noise)}`);

    // Unit: novelty distance is Euclidean over the fixed metric vector.
    const zeroVec = {};
    for (const k of explore.METRIC_KEYS) zeroVec[k] = 0;
    const oneVec = { ...zeroVec };
    oneVec.activityMean = 1;
    record('stage9: novelty distance is Euclidean in metric space',
      explore.noveltyDistance(zeroVec, zeroVec) === 0
      && Math.abs(explore.noveltyDistance(zeroVec, oneVec) - 1) < 1e-12
      && explore.noveltyDistance(zeroVec, oneVec) >= explore.TAU_DEFAULT,
      `d=${explore.noveltyDistance(zeroVec, oneVec).toFixed(3)} tau=${explore.TAU_DEFAULT}`);

    // Determinism + smoke in isolated tmp dirs (the real archive is never read
    // or written by tests). --pattern still => deterministic frozen world;
    // --force-keep exercises the full gallery pipeline on it.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-'));
    const runExplorer = (out) => execFileSync('node', [
      path.join(ROOT, 'tools', 'explore.js'),
      '--size', '64', '--gens', '20', '--worlds', '1', '--seed-base', '7',
      '--pattern', 'still', '--force-keep',
      '--archive', path.join(out, 'archive.json'),
      '--out', out,
    ], { cwd: ROOT, stdio: 'pipe' });
    const detA = path.join(tmp, 'a');
    const detB = path.join(tmp, 'b');
    fs.mkdirSync(detA);
    fs.mkdirSync(detB);
    runExplorer(detA);
    runExplorer(detB);
    const read = (p) => fs.readFileSync(p, 'utf8');
    record('stage9: same config -> byte-identical run.json + archive.json',
      read(path.join(detA, 'run.json')) === read(path.join(detB, 'run.json'))
      && read(path.join(detA, 'archive.json')) === read(path.join(detB, 'archive.json')),
      'run.json + archive.json');

    const runJ = JSON.parse(read(path.join(detA, 'run.json')));
    const w0 = runJ.worlds[0];
    const entryDir = path.join(detA, w0.entry);
    const entry = JSON.parse(read(path.join(entryDir, 'metrics.json')));
    const gifOk = ffmpegHere
      ? fs.existsSync(path.join(entryDir, 'anim.gif')) && fs.statSync(path.join(entryDir, 'anim.gif')).size > 0
      : entry.gifSkip === 'ffmpeg not found';
    record('stage9: smoke — archive written, still world frozen, gallery entry complete',
      fs.existsSync(path.join(detA, 'archive.json'))
      && w0.boring.frozen === true
      && w0.kept === true
      && /^index\.html\?size=64&seed=7&mut=0(\.\d+)?$/.test(entry.reproUrl)
      && explore.METRIC_KEYS.every((k) => typeof entry.metrics[k] === 'number')
      && gifOk,
      `reproUrl=${entry.reproUrl} gif=${entry.gif} gifSkip=${entry.gifSkip}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  record(
    'no page errors or console errors across the whole run',
    pageErrors.length === 0 && !console_.some((m) => m.startsWith('[error]')),
    [...pageErrors, ...console_.filter((m) => m.startsWith('[error]'))].join('; ') || undefined,
  );

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.error(`FAILED: ${failed.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
