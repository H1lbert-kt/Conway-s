#!/usr/bin/env node
// Validation suite for Conway's Game of Life (B3/S23, WebGL2).
// Stages covered: 1 (scaffold/context) and 2 (GPU simulation core).
// Run: npm test   (requires Node 18+ and a Chromium binary; see findChromium).
const http = require('http');
const fs = require('fs');
const path = require('path');
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
