#!/usr/bin/env node
// Stage 9: headless novelty explorer. Runs a matrix of worlds (size x seed x
// mut x genome), scores behavior with a fixed metric vector, drops the boring
// ones (dies / freezes / white noise) and keeps only worlds far enough from
// the archive of seen behaviors. Each kept world becomes a gallery entry:
// repro URL + deterministic metrics.json + short stepped-frame GIF (ffmpeg;
// explicit skip when absent). CLI-only — no page runtime changes (the
// explorer drives the existing __life hooks with auto off, validation path).
// Metric vector order (fixed, documented): activityMean, activityStd,
// spatialEntropy, compressibility, movingComponents, persistence,
// lineageDiversity, stability. All in [0,1] (movingComponents scaled by 1/16).
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.glsl': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

// Metric vector order — fixed forever (archive compatibility).
const METRIC_KEYS = [
  'activityMean', 'activityStd', 'spatialEntropy', 'compressibility',
  'movingComponents', 'persistence', 'lineageDiversity', 'stability',
];
// Boring filters (documented thresholds).
const BORE = {
  frozenStability: 0.9999, // state stopped changing -> still life
  noiseActivity: 0.35,     // white noise: high activity AND ...
  noiseCompress: 0.55,     // ... incompressible AND ...
  noiseStability: 0.3,     // ... unstable
};
const MOVING_SCALE = 16; // moving component count -> /16, clamped to 1
const TAU_DEFAULT = 0.35; // novelty threshold (Euclidean distance in vec space)
const FRAME_SIZE = 256;   // GIF frame size (canvas viewport)
const LIN_IDS = 64;       // lineage ids 0..63 (0 = classic, 1..63 = stage 8)

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

function hasFfmpeg() {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

// ---- Pure metrics (no browser, no I/O) ----

function liveCount(raw) {
  let c = 0;
  for (let i = 0; i < raw.length; i += 4) if (raw[i] & 1) c++;
  return c;
}

function packedAlive(raw) {
  const n = raw.length / 4;
  const bytes = new Uint8Array((n + 7) >> 3);
  for (let i = 0; i < n; i++) {
    if (raw[i * 4] & 1) bytes[i >> 3] |= 1 << (i & 7);
  }
  return bytes;
}

function neighborHist(raw, size) {
  const hist = new Float64Array(9);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const i = (((y + dy + size) % size) * size + ((x + dx + size) % size)) * 4;
          if (raw[i] & 1) n++;
        }
      }
      hist[n]++;
    }
  }
  return hist;
}

function shannonNorm(hist) {
  let total = 0;
  for (let i = 0; i < 9; i++) total += hist[i];
  if (total === 0) return 0;
  let h = 0;
  for (let i = 0; i < 9; i++) {
    if (hist[i] === 0) continue;
    const p = hist[i] / total;
    h -= p * Math.log2(p);
  }
  return h / Math.log2(9);
}

function componentCentroids(raw, size) {
  const n = size * size;
  const visited = new Uint8Array(n);
  const queue = new Int32Array(n);
  const centroids = [];
  for (let start = 0; start < n; start++) {
    if (visited[start] || !(raw[start * 4] & 1)) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let sx = 0;
    let sy = 0;
    let count = 0;
    while (head < tail) {
      const cell = queue[head++];
      const cx = cell % size;
      const cy = (cell / size) | 0;
      sx += cx;
      sy += cy;
      count++;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const qx = (cx + dx + size) % size;
          const qy = (cy + dy + size) % size;
          const q = qy * size + qx;
          if (!visited[q] && (raw[q * 4] & 1)) {
            visited[q] = 1;
            queue[tail++] = q;
          }
        }
      }
    }
    centroids.push([sx / count, sy / count]);
  }
  return centroids;
}

function movingCount(prevCentroids, curCentroids) {
  // A previous component counts as "moving" when its nearest later centroid
  // moved more than 1 cell (glider-like displacement between snapshots).
  let moving = 0;
  for (const p of prevCentroids) {
    let best = Infinity;
    for (const c of curCentroids) {
      const d = (p[0] - c[0]) * (p[0] - c[0]) + (p[1] - c[1]) * (p[1] - c[1]);
      if (d < best) best = d;
    }
    if (best > 1.0) moving++;
  }
  return moving;
}

function distinctLineages(raw) {
  const seen = new Set();
  for (let i = 0; i < raw.length; i += 4) {
    if (raw[i] & 1) seen.add(raw[i + 3] >> 2);
  }
  return seen.size;
}

function computeMetrics(snapshots, size) {
  const n = size * size;
  const pops = snapshots.map(liveCount);
  const series = pops.map((p) => p / n);
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const variance = series.reduce((a, b) => a + (b - mean) * (b - mean), 0) / series.length;
  const std = Math.min(1, Math.sqrt(variance) * 2);
  const spatialEntropy = shannonNorm(neighborHist(snapshots[snapshots.length - 1], size));
  const packed = Buffer.concat(snapshots.map((s) => Buffer.from(packedAlive(s).buffer)));
  const compressibility = packed.length ? zlib.deflateSync(packed).length / packed.length : 1;
  const last = snapshots[snapshots.length - 1];
  let unchanged = 0;
  if (snapshots.length >= 2) {
    const prev = snapshots[snapshots.length - 2];
    for (let i = 0; i < n; i++) {
      if ((prev[i * 4] & 1) === (last[i * 4] & 1)) unchanged++;
    }
  } else {
    unchanged = n;
  }
  const stability = unchanged / n;
  const maxPop = Math.max(...pops);
  const finalPop = pops[pops.length - 1];
  const persistence = maxPop > 0 ? finalPop / maxPop : 0;
  const lineageDiversity = distinctLineages(last) / LIN_IDS;
  let movingSum = 0;
  let windows = 0;
  for (let i = 1; i < snapshots.length; i++) {
    movingSum += movingCount(
      componentCentroids(snapshots[i - 1], size),
      componentCentroids(snapshots[i], size),
    );
    windows++;
  }
  const movingComponents = Math.min(1, (windows ? movingSum / windows : 0) / MOVING_SCALE);
  return {
    vec: {
      activityMean: mean,
      activityStd: std,
      spatialEntropy,
      compressibility,
      movingComponents,
      persistence,
      lineageDiversity,
      stability,
    },
    finalPop,
    maxPop,
  };
}

function isBoring(m) {
  const v = m.vec;
  const died = m.finalPop === 0;
  const frozen = !died && v.stability >= BORE.frozenStability;
  const noise = v.activityMean > BORE.noiseActivity
    && v.compressibility > BORE.noiseCompress
    && v.stability < BORE.noiseStability;
  return { died, frozen, noise, any: died || frozen || noise };
}

function noveltyDistance(a, b) {
  let sum = 0;
  for (const k of METRIC_KEYS) {
    const d = a[k] - b[k];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function vecToArray(vec) {
  return METRIC_KEYS.map((k) => vec[k]);
}

function vecToObject(vec) {
  const o = {};
  for (const k of METRIC_KEYS) o[k] = vec[k];
  return o;
}

// ---- Gallery ----

function buildReproUrl(params) {
  return `index.html?size=${params.size}&seed=${params.seed}&mut=${params.mut}`;
}

function entryId(params) {
  return `s${params.size}_seed${params.seed}_mut${params.mut}_${params.genome}`;
}

function writeGif(frames, dest) {
  // frames: Array of rgb24 Uint8Array (FRAME_SIZE^2*3, already y-corrected).
  const input = Buffer.concat(frames.map((f) => Buffer.from(f.buffer, f.byteOffset, f.length)));
  const r = spawnSync('ffmpeg', [
    '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    '-s', `${FRAME_SIZE}x${FRAME_SIZE}`, '-i', 'pipe:0',
    '-vf', 'fps=8,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5',
    '-loop', '0', dest,
  ], { input, stdio: ['pipe', 'ignore', 'ignore'] });
  return r.status === 0;
}

function writeJson(dest, obj) {
  fs.writeFileSync(dest, JSON.stringify(obj, null, 2) + '\n');
}

// ---- Driver ----

function parseArgs(argv) {
  const opts = {
    size: 64,
    gens: 120,
    worlds: 8,
    seedBase: 1,
    mut: 0,
    genome: 'conway',
    tau: TAU_DEFAULT,
    archive: path.join('tools', 'gallery', 'archive.json'),
    out: path.join('tools', 'gallery'),
    pattern: 'soup',
    forceKeep: false,
    gif: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--size') opts.size = Number(next());
    else if (a === '--gens') opts.gens = Number(next());
    else if (a === '--worlds') opts.worlds = Number(next());
    else if (a === '--seed-base') opts.seedBase = Number(next());
    else if (a === '--mut') opts.mut = Number(next());
    else if (a === '--genome') opts.genome = next();
    else if (a === '--tau') opts.tau = Number(next());
    else if (a === '--archive') opts.archive = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--pattern') opts.pattern = next();
    else if (a === '--force-keep') opts.forceKeep = true;
    else if (a === '--no-gif') opts.gif = false;
    else throw new Error(`Unknown flag: ${a}`);
  }
  if (!Number.isFinite(opts.size) || opts.size < 8) throw new Error('--size must be >= 8');
  if (!Number.isFinite(opts.gens) || opts.gens < 1) throw new Error('--gens must be >= 1');
  if (!Number.isFinite(opts.worlds) || opts.worlds < 1) throw new Error('--worlds must be >= 1');
  if (!['soup', 'still'].includes(opts.pattern)) throw new Error('--pattern must be soup|still');
  if (!['conway', 'highlife'].includes(opts.genome)) throw new Error('--genome must be conway|highlife');
  return opts;
}

function loadArchive(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(data.entries)) return data;
  } catch (e) { /* missing/corrupt -> fresh */ }
  return { version: 1, entries: [] };
}

async function toB64(page, fnName, x, y, w, h) {
  return page.evaluate(([fn, x, y, w, h]) => {
    const b = window.__life[fn](x, y, w, h);
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  }, [fnName, x, y, w, h]);
}

function fromB64(b64) {
  const buf = Buffer.from(b64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice();
}

async function runWorld(browser, base, params, opts, ffmpeg) {
  const page = await browser.newPage({ viewport: { width: FRAME_SIZE, height: FRAME_SIZE } });
  await page.goto(`${base}?size=${params.size}&seed=${params.seed}&mut=${params.mut}&sps=0.0001`);
  await page.waitForFunction(() => !!window.__life);
  await page.evaluate(() => window.__life.setAuto(false));
  if (opts.pattern === 'still') {
    await page.evaluate(([size]) => {
      const data = new Uint8Array(size * size * 4);
      const half = size >> 1;
      const cells = [
        [half, half], [half + 1, half], [half, half + 1], [half + 1, half + 1],
      ];
      for (const [x, y] of cells) data[(y * size + x) * 4] = 255;
      window.__life.seed(size, size, data);
    }, [params.size]);
  } else if (opts.genome !== 'conway') {
    const raw0 = fromB64(await toB64(page, 'readRaw', 0, 0, params.size, params.size));
    const alive = new Uint8Array(params.size * params.size);
    for (let i = 0; i < alive.length; i++) alive[i] = raw0[i * 4] & 1;
    await page.evaluate(([size, genome, aliveArr]) => {
      window.__life.setGenome(genome);
      const data = new Uint8Array(size * size * 4);
      for (let i = 0; i < size * size; i++) data[i * 4] = aliveArr[i] ? 255 : 0;
      window.__life.seed(size, size, data);
    }, [params.size, opts.genome, Array.from(alive)]);
  }
  const snapEvery = Math.max(1, Math.floor(opts.gens / 16));
  const snapshots = [];
  const frames = [];
  const captureGif = ffmpeg && opts.gif;
  for (let g = 0; g < opts.gens; g += snapEvery) {
    const k = Math.min(snapEvery, opts.gens - g);
    await page.evaluate((n) => window.__life.step(n), k);
    snapshots.push(fromB64(await toB64(page, 'readRaw', 0, 0, params.size, params.size)));
    if (captureGif) {
      const rgba = fromB64(await toB64(page, 'readScreen', 0, 0, FRAME_SIZE, FRAME_SIZE));
      const rgb = new Uint8Array(FRAME_SIZE * FRAME_SIZE * 3);
      for (let y = 0; y < FRAME_SIZE; y++) {
        const src = (FRAME_SIZE - 1 - y) * FRAME_SIZE * 4; // readPixels is y-up
        const dst = y * FRAME_SIZE * 3;
        for (let x = 0; x < FRAME_SIZE; x++) {
          rgb[dst + x * 3] = rgba[src + x * 4];
          rgb[dst + x * 3 + 1] = rgba[src + x * 4 + 1];
          rgb[dst + x * 3 + 2] = rgba[src + x * 4 + 2];
        }
      }
      frames.push(rgb);
    }
  }
  await page.close();
  return { metrics: computeMetrics(snapshots, params.size), frames };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const ffmpeg = hasFfmpeg();
  fs.mkdirSync(opts.out, { recursive: true });
  const archivePath = path.resolve(opts.archive);
  const archive = loadArchive(archivePath);
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
  });

  const run = {
    version: 1,
    config: {
      size: opts.size, gens: opts.gens, worlds: opts.worlds,
      seedBase: opts.seedBase, mut: opts.mut, genome: opts.genome,
      pattern: opts.pattern, tau: opts.tau,
    },
    worlds: [],
  };

  for (let i = 0; i < opts.worlds; i++) {
    const params = {
      size: opts.size,
      seed: opts.seedBase + i,
      mut: opts.mut,
      genome: opts.genome,
      pattern: opts.pattern,
    };
    const { metrics, frames } = await runWorld(browser, base, params, opts, ffmpeg);
    const boring = isBoring(metrics);
    let dist = null;
    for (const entry of archive.entries) {
      const d = noveltyDistance(metrics.vec, vecToObject(Array.isArray(entry.vec) ? vecFromArr(entry.vec) : entry.vec));
      if (dist === null || d < dist) dist = d;
    }
    const kept = opts.forceKeep
      || (!boring.any && (dist === null || dist >= opts.tau));
    const id = entryId(params);
    const record = {
      params,
      metrics: vecToObject(metrics.vec),
      finalPop: metrics.finalPop,
      maxPop: metrics.maxPop,
      boring,
      distToArchive: dist,
      kept,
      entry: kept ? id : null,
    };
    if (kept) {
      const dir = path.join(opts.out, id);
      fs.mkdirSync(dir, { recursive: true });
      const entryMetrics = {
        params,
        reproUrl: buildReproUrl(params),
        metrics: record.metrics,
        finalPop: metrics.finalPop,
        maxPop: metrics.maxPop,
        boring,
        gif: null,
        gifSkip: null,
      };
      if (frames.length) {
        const gifPath = path.join(dir, 'anim.gif');
        if (ffmpeg) {
          if (writeGif(frames, gifPath)) entryMetrics.gif = 'anim.gif';
          else entryMetrics.gifSkip = 'ffmpeg failed';
        } else {
          entryMetrics.gifSkip = 'ffmpeg not found';
        }
      }
      writeJson(path.join(dir, 'metrics.json'), entryMetrics);
      archive.entries.push({ params, vec: vecToArray(metrics.vec) });
    }
    run.worlds.push(record);
    console.log(`world seed=${params.seed} pop=${metrics.finalPop} `
      + `bored=${boring.any} dist=${dist === null ? 'n/a' : dist.toFixed(3)} kept=${kept}`);
  }

  writeJson(path.join(opts.out, 'run.json'), run);
  writeJson(archivePath, archive);
  await browser.close();
  server.close();
  const mins = (Date.now() - t0) / 60000;
  const keptCount = run.worlds.filter((w) => w.kept).length;
  console.log(`done: ${keptCount} kept / ${opts.worlds} worlds in ${mins.toFixed(1)} min `
    + `(${(opts.worlds / Math.max(mins, 1e-6)).toFixed(1)} worlds/min, ffmpeg=${ffmpeg ? 'yes' : 'no'})`);
}

function vecFromArr(arr) {
  const o = {};
  for (let i = 0; i < METRIC_KEYS.length; i++) o[METRIC_KEYS[i]] = arr[i];
  return o;
}

module.exports = {
  METRIC_KEYS,
  BORE,
  TAU_DEFAULT,
  computeMetrics,
  isBoring,
  noveltyDistance,
  vecToArray,
  vecToObject,
  buildReproUrl,
  entryId,
  neighborHist,
  shannonNorm,
  componentCentroids,
  movingCount,
  liveCount,
  packedAlive,
  distinctLineages,
};

if (require.main === module) {
  main().catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });
}
